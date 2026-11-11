import * as t from '@babel/types';
import { traverse, gen } from '../util/ast.js';
import { isPureExpr, literalValue } from '../util/pure.js';

const MIN_MAP = 3;

// window/self alias'ı üzerinden erişildiğinde güvenle çıplak isme indirgenebilecek global'ler
const KNOWN_GLOBALS = new Set([
  'document', 'navigator', 'location', 'console', 'localStorage', 'sessionStorage', 'history', 'screen',
  'performance', 'crypto', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'requestAnimationFrame',
  'fetch', 'XMLHttpRequest', 'JSON', 'Math', 'String', 'Number', 'Boolean', 'Array', 'Object', 'Date', 'RegExp',
  'Promise', 'parseInt', 'parseFloat', 'atob', 'btoa', 'encodeURIComponent', 'decodeURIComponent', 'alert',
  'Error', 'Symbol', 'Map', 'Set', 'WeakMap', 'Uint8Array', 'TextEncoder', 'TextDecoder', 'URL', 'Image',
]);
const GLOBAL_OBJECTS = new Set(['window', 'globalThis', 'self']);

// Proxy değeri yalnızca identifier + statik üye zinciri olabilir; kullandığı isimleri döndürür.
function valueNames(node, out = new Set()) {
  if (t.isIdentifier(node)) { out.add(node.name); return out; }
  if (t.isMemberExpression(node)) {
    if (node.computed && !t.isStringLiteral(node.property) && !t.isNumericLiteral(node.property)) return null;
    return valueNames(node.object, out);
  }
  return null;
}

// Switch'in anahtar ifadesi: function V(k) { switch (k) ... }
// ya da js-confuser biçimi: function V(...O) { O.length = 1; switch (O[0]) ... }
function switchOfProxy(params, stmts) {
  const [first] = params;
  if (params.length !== 1) return null;
  if (t.isIdentifier(first) && stmts.length >= 1 && t.isSwitchStatement(stmts[0]) &&
      t.isIdentifier(stmts[0].discriminant, { name: first.name })) return { sw: stmts[0], index: 0 };
  if (!t.isRestElement(first) || !t.isIdentifier(first.argument) || stmts.length < 2) return null;
  const name = first.argument.name;
  const [len, sw] = stmts;
  const isLen = t.isExpressionStatement(len) && t.isAssignmentExpression(len.expression, { operator: '=' }) &&
    t.isMemberExpression(len.expression.left) && t.isIdentifier(len.expression.left.object, { name }) &&
    t.isIdentifier(len.expression.left.property, { name: 'length' }) && t.isNumericLiteral(len.expression.right) &&
    len.expression.right.value >= 1;
  const d = sw && t.isSwitchStatement(sw) && sw.discriminant;
  const isFirstArg = d && t.isMemberExpression(d) && d.computed && t.isIdentifier(d.object, { name }) &&
    t.isNumericLiteral(d.property, { value: 0 });
  return isLen && isFirstArg ? { sw, index: 1 } : null;
}

// function V(k) { switch (k) { case "a": return X.y; ... } }
function readProxy(fnPath) {
  const { params, body } = fnPath.node;
  if (!t.isBlockStatement(body)) return null;
  const found = switchOfProxy(params, body.body);
  if (!found) return null;
  const { sw, index } = found;

  const entries = [];
  sw.cases.forEach((c, i) => {
    if (!c.test) return;
    // boş case bir sonrakine düşer: case A: case B: return X;
    let j = i;
    while (j < sw.cases.length && !sw.cases[j].consequent.length) j++;
    const cons = sw.cases[j]?.consequent;
    if (!cons || !t.isReturnStatement(cons[0])) return;
    const value = cons[0].argument;
    const names = value && valueNames(value);
    if (!names) return;
    // değer proxy'nin kendi parametresine/yereline bağlıysa çağrı yerine taşınamaz
    for (const n of names) if (fnPath.scope.getOwnBinding(n)) return;
    entries.push({ testPath: fnPath.get(`body.body.${index}.cases.${i}.test`), value, names });
  });
  return entries.length >= MIN_MAP ? entries : null;
}

async function resolveKeys(paths, { sandbox, ctx }) {
  const keys = new Array(paths.length).fill(undefined);
  const dynamic = [];
  paths.forEach((p, i) => {
    const lit = literalValue(p.node);
    if (lit.ok && (typeof lit.value === 'string' || typeof lit.value === 'number')) keys[i] = String(lit.value);
    else if (ctx && isPureExpr(p, { programFns: true })) dynamic.push(i);
  });
  if (dynamic.length) {
    const r = await sandbox.batchIn(ctx, dynamic.map((i) => gen(paths[i].node)));
    if (r.ok) {
      dynamic.forEach((i, j) => {
        const v = r.results[j];
        if (v?.ok && (v.type === 'string' || v.type === 'number')) keys[i] = String(v.value);
      });
    }
  }
  return keys;
}

export async function run(ast, { onLog, bump, sandbox, ctx }) {
  const proxies = [];
  traverse(ast, {
    FunctionDeclaration(p) {
      const entries = readProxy(p);
      if (entries) proxies.push({ name: p.node.id.name, fnPath: p, declScope: p.parentPath.scope, entries });
    },
    VariableDeclarator(p) {
      if (!t.isIdentifier(p.node.id) || !t.isFunctionExpression(p.node.init)) return;
      const entries = readProxy(p.get('init'));
      if (entries) proxies.push({ name: p.node.id.name, fnPath: p.get('init'), declScope: p.scope, entries, declarator: p });
    },
  });

  const globalRoots = sandbox && proxies.length ? await probeGlobalRoots(ast, proxies, sandbox) : new Set();

  let total = 0;
  for (const [pi, px] of proxies.entries()) {
    const binding = px.declScope.getBinding(px.name);
    if (!binding?.constant) continue;

    const keys = await resolveKeys(px.entries.map((e) => e.testPath), { sandbox, ctx });
    const map = new Map();
    px.entries.forEach((e, i) => { if (keys[i] !== undefined && !map.has(keys[i])) map.set(keys[i], e); });
    if (map.size < MIN_MAP) continue;

    const calls = binding.referencePaths
      .map((ref) => ref.parentPath)
      .filter((c) => c.isCallExpression() && c.node.arguments.length === 1 && !c.findParent((x) => x === px.fnPath));
    const callKeys = await resolveKeys(calls.map((c) => c.get('arguments.0')), { sandbox, ctx });

    let n = 0;
    calls.forEach((call, i) => {
      const entry = callKeys[i] !== undefined && map.get(callKeys[i]);
      if (!entry || !call.node) return;
      // Çalışma anında global nesne olduğu doğrulanan kökler (N = U() → globalThis) globalThis'e yazılır;
      // diğer her isim çağrı yerinde de aynı binding'e çözülmeli
      const roots = new Set([...entry.names].filter((name) => globalRoots.has(`${pi}:${name}`)));
      if (roots.size && call.scope.getBinding('globalThis')) return;
      for (const name of entry.names) {
        if (!roots.has(name) && call.scope.getBinding(name) !== px.fnPath.scope.getBinding(name)) return;
      }
      call.replaceWith(roots.size ? globalize(t.cloneNode(entry.value, true), roots, call.scope) : t.cloneNode(entry.value, true));
      n++;
    });
    if (!n) continue;
    total += n;
    onLog(`proxy ${px.name}: ${n}/${calls.length} çağrı çözüldü (${map.size} eşleme)`, 'info');

    px.declScope.crawl();
    const after = px.declScope.getBinding(px.name);
    if (after && after.referencePaths.every((r) => r.findParent((x) => x === px.fnPath))) {
      (px.declarator ?? px.fnPath).remove();
    }
  }

  total += simplifyGlobalAliases(ast, onLog);
  bump('proxy', total);
}

// Proxy değerlerinin kök isimleri (N.window → N) programı çalıştırırken global nesneye mi eşit?
// Proxy gövdesinin başına geçici bir kayıt çağrısı ekleyip program sandbox'ta bir kez çalıştırılır.
async function probeGlobalRoots(ast, proxies, sandbox) {
  const inserted = [];
  proxies.forEach((px, pi) => {
    const names = new Set(px.entries.flatMap((e) => [...e.names]));
    const stmts = [...names].map((name) => t.expressionStatement(
      t.callExpression(t.identifier('__peelRoot'), [t.stringLiteral(`${pi}:${name}`), t.identifier(name)])));
    px.fnPath.node.body.body.unshift(...stmts);
    inserted.push([px.fnPath.node.body.body, stmts.length]);
  });
  const code = gen(ast);
  for (const [body, count] of inserted) body.splice(0, count);

  const prelude = 'var __peelRoots = {}; function __peelRoot(k, v) { if (__peelRoots[k] !== false) __peelRoots[k] = v === globalThis; }';
  const r = await sandbox.run(`${prelude}\ntry {\n${code}\n} catch (e) {}\n__res.push(__peelRoots);`, { timeoutMs: 10000 });
  const seen = r?.res?.[0] ?? {};
  return new Set(Object.keys(seen).filter((k) => seen[k] === true));
}

// N.window → window, N.kyIZ5A → globalThis.kyIZ5A (bilinmeyen isim çıplak yazılırsa ReferenceError fırlatabilir)
function globalize(node, roots, scope) {
  if (t.isIdentifier(node) && roots.has(node.name)) return t.identifier('globalThis');
  if (!t.isMemberExpression(node)) return node;
  node.object = globalize(node.object, roots, scope);
  const prop = !node.computed && t.isIdentifier(node.property) ? node.property.name
    : node.computed && t.isStringLiteral(node.property) ? node.property.value : null;
  if (t.isIdentifier(node.object, { name: 'globalThis' }) && prop &&
      (KNOWN_GLOBALS.has(prop) || GLOBAL_OBJECTS.has(prop)) && !scope.getBinding(prop)) {
    return t.identifier(prop);
  }
  return node;
}

// var A = window; ... A.document → document
function simplifyGlobalAliases(ast, onLog) {
  let total = 0;
  traverse(ast, {
    VariableDeclarator(p) {
      const { id, init } = p.node;
      if (!t.isIdentifier(id) || !t.isIdentifier(init) || !GLOBAL_OBJECTS.has(init.name)) return;
      if (p.scope.getBinding(init.name)) return;
      const b = p.scope.getBinding(id.name);
      if (!b?.constant) return;
      let n = 0;
      for (const ref of b.referencePaths) {
        const m = ref.parentPath;
        if (!m.isMemberExpression({ object: ref.node }) || m.node.computed) continue;
        const prop = m.node.property.name;
        if (!KNOWN_GLOBALS.has(prop) || m.scope.getBinding(prop)) continue;
        const parent = m.parentPath;
        if (parent.isAssignmentExpression({ left: m.node }) || parent.isUpdateExpression() ||
            parent.isUnaryExpression({ operator: 'delete' })) continue;
        // çağrıda this değişmesin diye A.setTimeout(...) gibi doğrudan çağrılar da güvenli: global fonksiyonlar this'e bakmaz
        m.replaceWith(t.identifier(prop));
        n++;
      }
      if (!n) return;
      total += n;
      p.scope.crawl();
      const after = p.scope.getBinding(id.name);
      if (after && !after.referenced) p.remove();
      onLog(`global alias ${id.name} sadeleştirildi (${n})`, 'info');
    },
  });
  return total;
}
