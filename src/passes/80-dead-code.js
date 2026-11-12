import * as t from '@babel/types';
import { traverse, gen } from '../util/ast.js';
import { isPureExpr, literalValue } from '../util/pure.js';

const MAX_PROTECTION_SRC = 4000;

// Ölü daldaki `var` bildirimleri hoisting yüzünden yine de var olur: isimlerini koru
function hoistedVars(node, out = []) {
  if (!node || typeof node !== 'object' || t.isFunction(node)) return out;
  if (t.isVariableDeclaration(node, { kind: 'var' })) {
    for (const d of node.declarations) out.push(...Object.keys(t.getBindingIdentifiers(d.id)));
  }
  for (const key of t.VISITOR_KEYS[node.type] ?? []) {
    const v = node[key];
    if (Array.isArray(v)) v.forEach((c) => hoistedVars(c, out)); else hoistedVars(v, out);
  }
  return out;
}

function containsFunctionDecl(node) {
  if (!node || typeof node !== 'object') return false;
  if (t.isFunctionDeclaration(node)) return true;
  if (t.isFunction(node)) return false;
  return (t.VISITOR_KEYS[node.type] ?? []).some((key) => {
    const v = node[key];
    return Array.isArray(v) ? v.some(containsFunctionDecl) : containsFunctionDecl(v);
  });
}

const isLexical = (s) => t.isClassDeclaration(s) || t.isFunctionDeclaration(s) ||
  (t.isVariableDeclaration(s) && s.kind !== 'var');

// Ölü bloktaki fonksiyon bildirimleri: sloppy kipte (Annex B) çevre fonksiyonda undefined değerli bir var
// oluşturur, blok hiç çalışmadığından değer atanmaz; katı kipte yalnızca blok kapsamlıdır.
function blockFunctionNames(node, out = []) {
  if (!node || typeof node !== 'object' || t.isFunction(node)) return out;
  if (t.isBlockStatement(node) || t.isSwitchCase(node)) {
    for (const s of node.body ?? node.consequent) if (t.isFunctionDeclaration(s) && s.id) out.push(s.id.name);
  }
  for (const key of t.VISITOR_KEYS[node.type] ?? []) {
    const v = node[key];
    if (Array.isArray(v)) v.forEach((c) => blockFunctionNames(c, out)); else blockFunctionNames(v, out);
  }
  return out;
}

function replaceStatement(p, keep, dead) {
  // ölü dal doğrudan (bloksuz) bir fonksiyon bildirimiyse ya da async/generator bildirim varsa dokunulmaz
  if (containsFunctionDecl(dead) && (t.isFunctionDeclaration(dead) ||
      (() => { let odd = false; t.traverseFast(dead, (n) => { if (t.isFunctionDeclaration(n) && (n.async || n.generator)) odd = true; }); return odd; })())) return false;
  const stmts = keep ? (t.isBlockStatement(keep) ? keep.body : [keep]) : [];
  const vars = hoistedVars(dead);
  if (containsFunctionDecl(dead) && !p.isInStrictMode()) vars.push(...blockFunctionNames(dead));
  const out = stmts.some(isLexical) ? [t.blockStatement(stmts)] : [...stmts];
  if (vars.length) out.push(t.variableDeclaration('var', vars.map((v) => t.variableDeclarator(t.identifier(v)))));
  if (Array.isArray(p.container)) {
    if (out.length) p.replaceWithMultiple(out); else p.remove();
  } else {
    p.replaceWith(out.length === 1 ? out[0] : t.blockStatement(out));
  }
  return true;
}

function truthiness(node) {
  const lit = literalValue(node);
  return lit.ok ? Boolean(lit.value) : undefined;
}

// self-defending (toString/RegExp kontrolü) ve debug protection (debugger + zamanlayıcı) IIFE'leri
function isProtectionIife(stmt) {
  let e = stmt.expression;
  if (t.isUnaryExpression(e)) e = e.argument;
  if (!t.isCallExpression(e) || !(t.isFunctionExpression(e.callee) || t.isArrowFunctionExpression(e.callee))) return false;
  const src = gen(e.callee.body);
  if (src.length > MAX_PROTECTION_SRC) return false;
  const selfDefending = /toString/.test(src) && /native|RegExp/.test(src) && /constructor|\.call\(|\.apply\(/.test(src);
  const antiDebug = /debugger|"debu"/.test(src) && /setInterval|setTimeout/.test(src);
  return selfDefending || antiDebug;
}

// Boş ve hiç değiştirilmeyen bir değere karşı "k" in X testi: sonucu host'ta taze bir eşi ile hesapla
const emptyFn = (f) => (t.isFunctionExpression(f) || t.isFunctionDeclaration(f)) && !f.async && !f.generator &&
  f.body.body.every((x) => t.isReturnStatement(x) && !x.argument);
// let V; …; V = function () { return; };  — tek atama, gövde düzeyinde; her test atama deyiminden sonraki bir
// deyimde (hoisting'li fonksiyon bildirimi değil): test çalıştığında V her zaman bu boş fonksiyondur
function assignedEmptyFn(binding) {
  if (binding.constantViolations.length !== 1 || !binding.path.isVariableDeclarator() || binding.path.node.init) return false;
  const v = binding.constantViolations[0];
  const stmt = v.parentPath;
  if (!v.isAssignmentExpression({ operator: '=' }) || !emptyFn(v.node.right) || !stmt.isExpressionStatement() ||
      !Array.isArray(stmt.container) || stmt.parentPath !== binding.path.parentPath.parentPath) return false;
  // ref, atama deyiminden sonra çalışır: sonraki bir deyimde ya da önceki bir deyimde tek kez atanan bir fonksiyon
  // ifadesinin (W = function () {…}) içinde ve W'nin her kullanımı da böyle (sınırlı derinlik)
  const after = (r, depth) => {
    const top = r.findParent((x) => x.parentPath === stmt.parentPath);
    if (!top) return false;
    if (top.key > stmt.key) return !top.isFunctionDeclaration();
    const e = top.isExpressionStatement() ? top.get('expression') : null;
    if (depth > 3 || !e?.isAssignmentExpression({ operator: '=' }) || !t.isIdentifier(e.node.left) || !e.get('right').isFunctionExpression() ||
        !r.findParent((x) => x === e.get('right'))) return false;
    const wb = e.scope.getBinding(e.node.left.name);
    return Boolean(wb && wb.constantViolations.length === 1 && wb.constantViolations[0] === e && wb.path.isVariableDeclarator() &&
      !wb.path.node.init && wb.referencePaths.every((q) => after(q, depth + 1)));
  };
  return binding.referencePaths.every((r) => after(r, 0));
}
function emptyShapeOf(binding) {
  if (!binding) return null;
  const onlyInTests = binding.referencePaths.every((r) => r.parentPath.isBinaryExpression({ operator: 'in', right: r.node }));
  if (!onlyInTests) return null;
  if (!binding.constant) return assignedEmptyFn(binding) ? () => function () {} : null;
  const n = binding.path.node;
  if (t.isFunctionDeclaration(n) && emptyFn(n)) return () => function () {};
  if (t.isVariableDeclarator(n)) {
    if (t.isObjectExpression(n.init) && !n.init.properties.length) return () => ({});
    if (t.isArrayExpression(n.init) && !n.init.elements.length) return () => [];
  }
  return null;
}

async function foldInTests(ast, { sandbox, ctx }) {
  const jobs = [];
  traverse(ast, {
    BinaryExpression(p) {
      if (p.node.operator !== 'in' || !t.isIdentifier(p.node.right)) return;
      const make = emptyShapeOf(p.scope.getBinding(p.node.right.name));
      if (!make) return;
      const lit = literalValue(p.node.left);
      if (lit.ok) jobs.push({ p, make, key: lit.value });
      else if (ctx && isPureExpr(p.get('left'), { programFns: true })) jobs.push({ p, make, src: gen(p.node.left) });
    },
  });
  const dynamic = jobs.filter((j) => j.src);
  if (dynamic.length) {
    const r = await sandbox.batchIn(ctx, dynamic.map((j) => j.src));
    if (r.ok) dynamic.forEach((j, i) => {
      const v = r.results[i];
      if (v?.ok && !v.opaque && (v.type === 'string' || v.type === 'number')) j.key = v.value;
    });
  }
  let n = 0;
  for (const j of jobs) {
    if (j.key === undefined || !j.p.node) continue;
    j.p.replaceWith(t.booleanLiteral(String(j.key) in j.make()));
    n++;
  }
  return n;
}

// function f() {}  ya da  function f() { f = function () {}; }  → çağrılar yalnızca argümanlarını değerlendirir
function isNoopWrapper(fnPath) {
  const { id, body, params } = fnPath.node;
  if (!id || fnPath.node.async || fnPath.node.generator) return false;
  if (params.some((p) => !t.isIdentifier(p))) return false;
  const stmts = body.body;
  if (!stmts.length) return true;
  if (stmts.length !== 1 || !t.isExpressionStatement(stmts[0])) return false;
  const e = stmts[0].expression;
  return t.isAssignmentExpression(e, { operator: '=' }) && t.isIdentifier(e.left, { name: id.name }) &&
    t.isFunctionExpression(e.right) && !e.right.body.body.length;
}

// function S(fn, n) { Object.defineProperty(fn, "length", {...}); return fn; } → S(f, 2) yerine f
function isLengthSpoofer(fnPath) {
  const { params, body } = fnPath.node;
  if (params.length < 2 || !t.isIdentifier(params[0]) || body.body.length !== 2) return false;
  const [first, ret] = body.body;
  return /defineProperty/.test(gen(first)) && /["']length["']/.test(gen(first)) &&
    t.isReturnStatement(ret) && t.isIdentifier(ret.argument, { name: params[0].name });
}

// Deyim olarak tek başına duran, değerlendirmesi gözlenebilir hiçbir şey yapmayan ifadeler (depo nesnesi
// kullanımları satır içine yazıldıktan sonra kalan kabuklar):
//   ({ a: "x", f: function (b, c) { return b + c; } });      — yalnızca literal/fonksiyon değerli, sabit anahtarlı nesne
//   (function () { var x = true; return function () { … }; })();   — yalnızca fonksiyon üreten IIFE
const inertObject = (e) => t.isObjectExpression(e) && e.properties.every((x) => t.isObjectProperty(x) && (!x.computed || t.isStringLiteral(x.key)) &&
  (literalValue(x.value).ok || t.isFunctionExpression(x.value) || t.isArrowFunctionExpression(x.value) || inertObject(x.value)));
function factoryIife(e) {
  if (!t.isCallExpression(e) || e.arguments.length || !t.isFunctionExpression(e.callee) || e.callee.async || e.callee.generator) return false;
  const body = e.callee.body.body;
  const last = body[body.length - 1];
  if (!t.isReturnStatement(last) || !(t.isFunctionExpression(last.argument) || t.isArrowFunctionExpression(last.argument))) return false;
  return body.slice(0, -1).every((s) => t.isVariableDeclaration(s) &&
    s.declarations.every((d) => t.isIdentifier(d.id) && (!d.init || literalValue(d.init).ok || t.isFunction(d.init))));
}

// obfuscator.io selfDefending / debugProtection / disableConsoleOutput: bir "callController" ile tek seferlik
// çalıştırılan koruma geri çağrıları. Kodun kendi metnini regex ile tarar; biçimlendirilmiş kodda sonsuz döngüye girer.
const GUARD_STRINGS = new Set(['(((.+)+)+)+$', 'function *\\( *\\)', '\\+\\+ *(?:[a-zA-Z_$][0-9a-zA-Z_$]*)',
  // javascript-obfuscator 0.x selfDefending: sıkıştırılmış fonksiyon metni ve \x/\u kaçışı testi
  '\\w+ *\\(\\) *{\\w+ *[\'|"].+[\'|"];? *}', '(\\\\[x|u](\\w){2,4})+']);

// Kontrol akışı düzleştirmesiyle birlikte koruma string'leri ve çağrılar sabit "depo" nesnesinin arkasındadır:
//   var o = { k: "(((.+)+)+)+$", c: function (a, b, d) { return a(b, d); }, r: function (a) { return a(); } };
//   var g = o.c(C, this, function () { … o.k … }); o.r(g);
// Hiç değiştirilmeyen nesne literal'inin özelliği değer olarak okunur.
function objectProp(scope, member) {
  if (!t.isMemberExpression(member) || !t.isIdentifier(member.object)) return null;
  const key = !member.computed && t.isIdentifier(member.property) ? member.property.name : t.isStringLiteral(member.property) ? member.property.value : null;
  const b = key === null ? null : scope.getBinding(member.object.name);
  if (!b?.constant || !b.path.isVariableDeclarator() || !t.isObjectExpression(b.path.node.init)) return null;
  const prop = b.path.node.init.properties.find((x) => t.isObjectProperty(x) && !x.computed &&
    (t.isIdentifier(x.key, { name: key }) || t.isStringLiteral(x.key, { value: key })));
  return prop?.value ?? null;
}

// depo nesnesinin "çağırıcı" proxy'si mi: function (f, ...xs) { return f(...xs); }  (arity = parametre sayısı)
function isCallerProxy(fn, arity) {
  if (!t.isFunctionExpression(fn) || fn.params.length !== arity || !fn.params.every((x) => t.isIdentifier(x))) return false;
  const ret = fn.body.body.length === 1 ? fn.body.body[0] : null;
  const c = t.isReturnStatement(ret) ? ret.argument : null;
  return t.isCallExpression(c) && t.isIdentifier(c.callee, { name: fn.params[0].name }) && c.arguments.length === arity - 1 &&
    c.arguments.every((a, i) => t.isIdentifier(a, { name: fn.params[i + 1].name }));
}

function isGuardCallback(node, scope = null) {
  if (!t.isFunctionExpression(node) && !t.isArrowFunctionExpression(node)) return false;
  let hit = false;
  t.traverseFast(node, (n) => {
    if (t.isStringLiteral(n) && GUARD_STRINGS.has(n.value)) hit = true;
    if (scope && !hit && t.isMemberExpression(n)) {
      const v = objectProp(scope, n);
      if (t.isStringLiteral(v) && GUARD_STRINGS.has(v.value)) hit = true;
    }
  });
  return hit;
}

// C(this, function () { …koruma… })  ya da  o.c(C, this, function () { … })  (o.c çağırıcı proxy)
const guardCall = (n, scope = null) => t.isCallExpression(n) && ((n.arguments.length === 2 &&
  t.isThisExpression(n.arguments[0]) && isGuardCallback(n.arguments[1], scope)) ||
  (scope && n.arguments.length === 3 && t.isThisExpression(n.arguments[1]) && isCallerProxy(objectProp(scope, n.callee), 3) &&
    isGuardCallback(n.arguments[2], scope)));

// g()  ya da  o.r(g)  (o.r tek argümanlı çağırıcı proxy)
const callsOnly = (c, ref, scope) => (c.isCallExpression({ callee: ref.node }) && !c.node.arguments.length) ||
  (c.isCallExpression() && c.node.arguments.length === 1 && c.node.arguments[0] === ref.node && isCallerProxy(objectProp(scope, c.node.callee), 1));

function removeGuardedCallbacks(ast, onLog) {
  let n = 0;
  traverse(ast, {
    CallExpression(p) {
      if (!p.node || !guardCall(p.node, p.scope)) return;
      const parent = p.parentPath;
      // C(this, cb)();  → deyimi sil
      if (parent.isCallExpression({ callee: p.node }) && !parent.node.arguments.length && parent.parentPath.isExpressionStatement()) {
        const stmt = parent.parentPath;
        if (Array.isArray(stmt.container)) { stmt.remove(); n++; }
        return;
      }
      // var g = C(this, cb); … g();  → bildirimi ve tüm g() çağrılarını sil
      if (!parent.isVariableDeclarator({ init: p.node }) || !t.isIdentifier(parent.node.id)) return;
      const b = parent.scope.getBinding(parent.node.id.name);
      if (!b?.constant) return;
      // geri çağrı kendi değişkenini de okur (v7.toString()); o referanslar silinen bildirimle birlikte gider
      const refs = b.referencePaths.filter((r) => !r.findParent((x) => x === p));
      const calls = refs.map((r) => r.parentPath);
      if (!calls.every((c, i) => callsOnly(c, refs[i], c.scope))) return;
      for (const c of calls) {
        const host = c.parentPath;
        if (host.isExpressionStatement() && Array.isArray(host.container)) host.remove();
        else if (host.isSequenceExpression() && host.node.expressions.length > 1) {
          host.node.expressions = host.node.expressions.filter((x) => x !== c.node);
          if (host.node.expressions.length === 1) host.replaceWith(host.node.expressions[0]);
        } else c.replaceWith(t.unaryExpression('void', t.numericLiteral(0)));
      }
      parent.remove();
      n += calls.length + 1;
    },
    // virgül zincirindeki boş IIFE: ((function () {})(), x) → x
    SequenceExpression(p) {
      const kept = p.node.expressions.filter((e, i, all) => i === all.length - 1 || !(t.isCallExpression(e) &&
        !e.arguments.length && t.isFunctionExpression(e.callee) && !e.callee.body.body.length));
      if (kept.length === p.node.expressions.length) return;
      n += p.node.expressions.length - kept.length;
      if (kept.length === 1) p.replaceWith(kept[0]);
      else p.node.expressions = kept;
    },
    // (function () {})();  — içi boşalmış IIFE
    ExpressionStatement(p) {
      const e = p.node.expression;
      if (t.isCallExpression(e) && !e.arguments.length && t.isFunctionExpression(e.callee) &&
          !e.callee.body.body.length && Array.isArray(p.container)) {
        p.remove();
        n++;
      }
    },
  });
  if (n) onLog(`dead-code: koruma geri çağrıları söküldü (${n})`, 'info');
  return n;
}

function unwrapCalls(ast, onLog) {
  let n = 0;
  traverse(ast, {
    FunctionDeclaration(fnPath) {
      const noop = isNoopWrapper(fnPath);
      const spoofer = !noop && isLengthSpoofer(fnPath);
      if (!noop && !spoofer) return;
      const name = fnPath.node.id.name;
      const b = fnPath.parentPath.scope.getBinding(name);
      if (!b || b.constantViolations.some((v) => !v.findParent((x) => x === fnPath))) return;
      const refs = b.referencePaths.filter((r) => !r.findParent((x) => x === fnPath));
      if (!refs.length) return;
      const calls = refs.map((r) => r.parentPath);
      if (!calls.every((c, i) => c.isCallExpression({ callee: refs[i].node }) && !c.node.arguments.some((a) => t.isSpreadElement(a)))) return;
      if (spoofer && !calls.every((c) => c.node.arguments.length >= 1 && c.node.arguments.slice(1).every((a) => literalValue(a).ok))) return;

      for (const c of calls) {
        const args = c.node.arguments;
        if (spoofer) { c.replaceWith(args[0]); continue; }
        if (c.parentPath.isExpressionStatement()) {
          if (!args.length) {
            if (Array.isArray(c.parentPath.container)) c.parentPath.remove();
            else c.parentPath.replaceWith(t.emptyStatement());
          } else {
            c.replaceWith(args.length === 1 ? args[0] : t.sequenceExpression(args));
          }
        } else {
          c.replaceWith(t.sequenceExpression([...args, t.unaryExpression('void', t.numericLiteral(0))]));
        }
      }
      fnPath.remove();
      n += calls.length;
      onLog(`dead-code: ${spoofer ? 'length sarmalayıcısı' : 'boş sarmalayıcı'} ${name} söküldü (${calls.length} çağrı)`, 'info');
    },
  });
  return n;
}

export async function run(ast, { onLog, bump, sandbox, ctx }) {
  let n = 0;
  traverse(ast, {
    DebuggerStatement(p) {
      if (Array.isArray(p.container)) p.remove(); else p.replaceWith(t.emptyStatement());
      n++;
      bump('dead.debugger');
    },
    ExpressionStatement(p) {
      if (isProtectionIife(p.node)) {
        if (Array.isArray(p.container)) p.remove(); else p.replaceWith(t.emptyStatement());
        n++;
        bump('dead.protection');
        return;
      }
      const e = p.node.expression;
      // `W;` gibi tek başına bağlı bir isim ya da literal: değerlendirmenin gözlenebilir etkisi yok
      // (bağsız isim ReferenceError fırlatabileceği için dokunulmaz; "use strict" gibi direktifler zaten ayrı düğüm)
      const inert = (t.isIdentifier(e) && p.scope.getBinding(e.name) && !p.findParent((x) => x.isWithStatement())) ||
        (literalValue(e).ok && !t.isStringLiteral(e)) || inertObject(e) || factoryIife(e) ||
        // !x;  typeof x;  void x;  (movedDeclarations kalıntısı) — bağlı ad: dönüşüm çağırmaz
        (t.isUnaryExpression(e) && ['!', 'typeof', 'void'].includes(e.operator) && t.isIdentifier(e.argument) &&
          Boolean(p.scope.getBinding(e.argument.name)) && !p.findParent((x) => x.isWithStatement()));
      if (inert && Array.isArray(p.container)) {
        p.remove();
        n++;
        bump('dead.noop');
        return;
      }
      if (t.isSequenceExpression(e) && Array.isArray(p.container)) {
        p.replaceWithMultiple(e.expressions.map((x) => t.expressionStatement(x)));
        n++;
      }
    },
    IfStatement(p) {
      const v = truthiness(p.node.test);
      if (v === undefined) return;
      const keep = v ? p.node.consequent : p.node.alternate;
      const dead = v ? p.node.alternate : p.node.consequent;
      if (replaceStatement(p, keep, dead)) { n++; bump('dead.constIf'); }
    },
    ConditionalExpression(p) {
      const v = truthiness(p.node.test);
      if (v === undefined) return;
      p.replaceWith(v ? p.node.consequent : p.node.alternate);
      n++;
      bump('dead.constIf');
    },
    WhileStatement(p) {
      if (truthiness(p.node.test) === false && replaceStatement(p, null, p.node.body)) { n++; bump('dead.constIf'); }
    },
  });

  // E220: ölü kod türüne göre sayılır (rapordaki dağılım)
  const inTests = await foldInTests(ast, { sandbox, ctx });
  const wrappers = unwrapCalls(ast, onLog);
  const guards = removeGuardedCallbacks(ast, onLog);
  bump('dead.inTest', inTests);
  bump('dead.emptyWrapper', wrappers);
  bump('dead.guard', guards);
  n += inTests + wrappers + guards;

  if (n) onLog(`dead-code: ${n} öğe temizlendi`, 'info');
  bump('deadCode', n);
}
