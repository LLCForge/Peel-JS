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

function replaceStatement(p, keep, dead) {
  if (containsFunctionDecl(dead)) return false;
  const stmts = keep ? (t.isBlockStatement(keep) ? keep.body : [keep]) : [];
  const vars = hoistedVars(dead);
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
function emptyShapeOf(binding) {
  if (!binding?.constant) return null;
  const onlyInTests = binding.referencePaths.every((r) => r.parentPath.isBinaryExpression({ operator: 'in', right: r.node }));
  if (!onlyInTests) return null;
  const n = binding.path.node;
  if (t.isFunctionDeclaration(n) && !n.body.body.length && !n.async && !n.generator) return () => function () {};
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

// obfuscator.io selfDefending / debugProtection / disableConsoleOutput: bir "callController" ile tek seferlik
// çalıştırılan koruma geri çağrıları. Kodun kendi metnini regex ile tarar; biçimlendirilmiş kodda sonsuz döngüye girer.
const GUARD_STRINGS = new Set(['(((.+)+)+)+$', 'function *\\( *\\)', '\\+\\+ *(?:[a-zA-Z_$][0-9a-zA-Z_$]*)']);

function isGuardCallback(node) {
  if (!t.isFunctionExpression(node) && !t.isArrowFunctionExpression(node)) return false;
  let hit = false;
  t.traverseFast(node, (n) => { if (t.isStringLiteral(n) && GUARD_STRINGS.has(n.value)) hit = true; });
  return hit;
}

// C(this, function () { …koruma… })
const guardCall = (n) => t.isCallExpression(n) && n.arguments.length === 2 &&
  t.isThisExpression(n.arguments[0]) && isGuardCallback(n.arguments[1]);

function removeGuardedCallbacks(ast, onLog) {
  let n = 0;
  traverse(ast, {
    CallExpression(p) {
      if (!p.node || !guardCall(p.node)) return;
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
      if (!calls.every((c, i) => c.isCallExpression({ callee: refs[i].node }) && !c.node.arguments.length)) return;
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
    },
    ExpressionStatement(p) {
      if (isProtectionIife(p.node)) {
        if (Array.isArray(p.container)) p.remove(); else p.replaceWith(t.emptyStatement());
        n++;
        return;
      }
      const e = p.node.expression;
      // `W;` gibi tek başına bağlı bir isim ya da literal: değerlendirmenin gözlenebilir etkisi yok
      // (bağsız isim ReferenceError fırlatabileceği için dokunulmaz; "use strict" gibi direktifler zaten ayrı düğüm)
      const inert = (t.isIdentifier(e) && p.scope.getBinding(e.name) && !p.findParent((x) => x.isWithStatement())) ||
        (literalValue(e).ok && !t.isStringLiteral(e));
      if (inert && Array.isArray(p.container)) {
        p.remove();
        n++;
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
      if (replaceStatement(p, keep, dead)) n++;
    },
    ConditionalExpression(p) {
      const v = truthiness(p.node.test);
      if (v === undefined) return;
      p.replaceWith(v ? p.node.consequent : p.node.alternate);
      n++;
    },
    WhileStatement(p) {
      if (truthiness(p.node.test) === false && replaceStatement(p, null, p.node.body)) n++;
    },
  });

  n += await foldInTests(ast, { sandbox, ctx });
  n += unwrapCalls(ast, onLog);
  n += removeGuardedCallbacks(ast, onLog);

  if (n) onLog(`dead-code: ${n} öğe temizlendi`, 'info');
  bump('deadCode', n);
}
