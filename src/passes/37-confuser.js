import * as t from '@babel/types';
import { traverse, gen } from '../util/ast.js';

// A-9:  js-confuser dispatcher fonksiyonları → ayrı fonksiyonlar
// A-21: js-confuser `function f(...M) { M.length = 2; … M[0] … }` → gerçek parametreler
// A-22: tslib/TypeScript `__generator` durum makinesi → function*

// ── ortak ───────────────────────────────────────────────

const strKey = (k, computed) => (!computed && t.isIdentifier(k) ? k.name : t.isStringLiteral(k) ? k.value : null);

// Fonksiyon (iç ok fonksiyonları dahil, iç normal fonksiyonlar hariç) this / arguments kullanıyor mu?
function usesThisOrArguments(fnNode) {
  let found = false;
  const walk = (n, top) => {
    if (!n || typeof n !== 'object' || found) return;
    if (!top && t.isFunction(n) && !t.isArrowFunctionExpression(n)) return;
    if (t.isThisExpression(n) || t.isIdentifier(n, { name: 'arguments' }) || t.isMetaProperty(n)) { found = true; return; }
    for (const k of t.VISITOR_KEYS[n.type] ?? []) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach((c) => walk(c, false)); else walk(v, false);
    }
  };
  walk(fnNode.body, true);
  for (const p of fnNode.params) walk(p, true);
  return found;
}

// arguments (iç normal fonksiyonlar hariç)
function usesArguments(node) {
  let found = false;
  const walk = (n) => {
    if (!n || typeof n !== 'object' || found) return;
    if (t.isFunction(n) && !t.isArrowFunctionExpression(n)) return;
    if (t.isIdentifier(n, { name: 'arguments' })) { found = true; return; }
    for (const k of t.VISITOR_KEYS[n.type] ?? []) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach(walk); else walk(v);
    }
  };
  walk(node);
  return found;
}

// Programdaki tüm bağlama adları ve bağsız (global) referanslar: yeni ad hiçbirini gölgelememeli
function allNames(ast) {
  const names = new Set();
  traverse(ast, {
    Program(p) { for (const g of Object.keys(p.scope.globals)) names.add(g); },
    Scopable(p) { for (const k of Object.keys(p.scope.bindings)) names.add(k); },
  });
  return names;
}

// ── A-9: dispatcher ─────────────────────────────────────

const isFlagTest = (test, param) => t.isBinaryExpression(test, { operator: '===' }) &&
  t.isIdentifier(test.left, { name: param }) && t.isStringLiteral(test.right);

function readDispatcher(fnPath) {
  const fn = fnPath.node;
  if (!fn.id || fn.async || fn.generator || fn.params.length < 3) return null;
  const [nameP, flagP, retP] = fn.params;
  if (![nameP, flagP, retP].every((x) => t.isIdentifier(x))) return null;
  const body = fn.body.body;
  let fns = null;
  let fnsName = null;
  let clearFlag = null;
  let fnFlag = null;
  let retFlag = null;
  let retKey = null;
  let payload = null;
  let lengthHelper = null;
  for (const s of body) {
    if (t.isVariableDeclaration(s) && s.declarations.length === 1 && t.isObjectExpression(s.declarations[0].init) &&
        t.isIdentifier(s.declarations[0].id)) {
      const obj = s.declarations[0].init;
      if (!obj.properties.every((p) => t.isObjectProperty(p) && strKey(p.key, p.computed) !== null && t.isFunctionExpression(p.value))) return null;
      fns = new Map(obj.properties.map((p) => [strKey(p.key, p.computed), p.value]));
      fnsName = s.declarations[0].id.name;
    }
    if (!t.isIfStatement(s)) continue;
    const cons = t.isBlockStatement(s.consequent) ? s.consequent.body : [s.consequent];
    if (isFlagTest(s.test, flagP.name)) {
      const src = gen(s.consequent);
      if (cons.length === 1 && t.isExpressionStatement(cons[0]) && t.isAssignmentExpression(cons[0].expression, { operator: '=' }) &&
          t.isIdentifier(cons[0].expression.left) && t.isArrayExpression(cons[0].expression.right) && !cons[0].expression.right.elements.length) {
        clearFlag = s.test.right.value;
        payload = cons[0].expression.left.name;
      } else if (/\.apply\(this\)/.test(src) && s.alternate) {
        fnFlag = s.test.right.value;
        // createFunction içindeki length ayarlayıcı: helper(fn, fnLength)
        t.traverseFast(s.consequent, (n) => {
          if (t.isCallExpression(n) && t.isIdentifier(n.callee) && n.arguments.length === 2 && t.isIdentifier(n.arguments[0]) &&
              t.isIdentifier(n.arguments[1]) && /length/i.test(n.arguments[1].name)) lengthHelper = n.callee.name;
        });
        const alt = gen(s.alternate).replace(/\s+/g, '');
        if (!new RegExp(`=${fnsName}\\[${nameP.name}\\]\\(\\)`).test(alt)) return null;
      }
    } else if (isFlagTest(s.test, retP.name) && cons.length === 1 && t.isReturnStatement(cons[0]) &&
        t.isObjectExpression(cons[0].argument) && cons[0].argument.properties.length === 1) {
      retFlag = s.test.right.value;
      retKey = strKey(cons[0].argument.properties[0].key, cons[0].argument.properties[0].computed);
    }
  }
  if (!fns || fnFlag === null || !payload) return null;
  return { fns, fnsName, clearFlag, fnFlag, retFlag, retKey, payload, lengthHelper, params: fn.params.length };
}

// fns girdisi: function () { var [a, b] = payload; ... }  → { params, body } (yoksa null)
function readEntry(entryPath, payload, dispatcherPath) {
  const fnNode = entryPath.node;
  if (fnNode.params.length || fnNode.async || fnNode.generator || usesThisOrArguments(fnNode)) return null;
  const body = fnNode.body.body;
  let params = [];
  let rest = body;
  const first = body[0];
  if (t.isVariableDeclaration(first) && first.declarations.length === 1 && t.isArrayPattern(first.declarations[0].id) &&
      t.isIdentifier(first.declarations[0].init, { name: payload })) {
    const els = first.declarations[0].id.elements;
    if (!els.every((e) => t.isIdentifier(e) || (t.isRestElement(e) && t.isIdentifier(e.argument)))) return null;
    params = els;
    rest = body.slice(1);
  }
  // payload başka yerde okunmamalı; dispatcher'ın yerel adlarına (fns, output, name...) bakmamalı
  let bad = false;
  t.traverseFast(t.blockStatement(rest), (n) => { if (t.isIdentifier(n, { name: payload })) bad = true; });
  if (bad) return null;
  entryPath.traverse({
    Identifier(q) {
      if (!q.isReferencedIdentifier() && !q.parentPath.isAssignmentExpression({ left: q.node })) return;
      const b = q.scope.getBinding(q.node.name);
      if (b && b.scope === dispatcherPath.scope) { bad = true; q.stop(); }
    },
  });
  if (bad) return null;
  return { params, rest, node: fnNode };
}

function dispatchers(ast, onLog) {
  let n = 0;
  const names = allNames(ast);
  traverse(ast, {
    FunctionDeclaration(p) {
      if (!p.parentPath.isProgram()) return;
      const d = readDispatcher(p);
      if (!d) return;
      const binding = p.parentPath.scope.getBinding(p.node.id.name);
      if (!binding?.constant) return;
      const entries = new Map();
      const byNode = new Map([...d.fns].map(([k, v]) => [v, k]));
      p.traverse({
        FunctionExpression(q) {
          if (!byNode.has(q.node)) return;
          const e = readEntry(q, d.payload, p);
          if (e) entries.set(byNode.get(q.node), e);
          q.skip();
        },
      });
      // çağrı yerlerini sınıflandır
      const sites = [];
      for (const ref of binding.referencePaths) {
        if (ref.findParent((x) => x === p)) continue;
        const c = ref.parentPath;
        if (!(c.isCallExpression() || c.isNewExpression()) || c.node.callee !== ref.node) continue;
        const args = c.node.arguments;
        if (!args.length || !t.isStringLiteral(args[0]) || !entries.has(args[0].value)) continue;
        if (args.slice(1).some((a) => !t.isStringLiteral(a) && !t.isObjectExpression(a))) continue;
        const flag = t.isStringLiteral(args[1]) ? args[1].value : undefined;
        const ret = t.isStringLiteral(args[2]) ? args[2].value : undefined;
        const mode = flag === d.fnFlag ? 'ref' : 'call';
        let target = c;
        if (ret !== undefined && ret === d.retFlag) {
          const m = c.parentPath;
          if (!m.isMemberExpression({ object: c.node }) || strKey(m.node.property, m.node.computed) !== d.retKey) continue;
          target = m;
        }
        // new D(...) yalnızca dönüş değeri nesneyse (retFlag sarmalı) düz çağrıyla aynıdır
        if (mode === 'call' && c.isNewExpression() && target === c) continue;
        sites.push({ key: args[0].value, mode, target, clear: flag === d.clearFlag, lengths: args.length > 3 });
      }
      // ref sitesi olan girdide .length gözlenebilir: sarmalayıcının length'i 0 (ayarlayıcı boş ve fnLengths yoksa)
      const helperEmpty = !d.lengthHelper || (() => {
        const hb = p.parentPath.scope.getBinding(d.lengthHelper);
        return hb?.path.isFunctionDeclaration() && !hb.path.node.body.body.length;
      })();
      const restForm = new Set();
      for (const s of sites) {
        if (s.mode !== 'ref') continue;
        if (!helperEmpty || s.lengths) s.skip = true; else restForm.add(s.key);
      }

      const made = new Map();
      const nameFor = (key) => {
        if (made.has(key)) return made.get(key);
        let base = t.isValidIdentifier(key) ? key : `fn_${key.replace(/[^\w$]/g, '_')}`;
        let name = base;
        for (let i = 2; names.has(name); i++) name = `${base}${i}`;
        names.add(name);
        made.set(key, name);
        return name;
      };
      let done = 0;
      for (const s of sites) {
        if (s.skip || !s.target.node) continue;
        const e = entries.get(s.key);
        if (s.mode === 'ref') {
          s.target.replaceWith(t.identifier(nameFor(s.key)));
          done++;
          continue;
        }
        // çağrı: (payload = [a, b], D("k")) → k(a, b)
        let args = null;
        let seq = null;
        if (s.clear || !e.params.length) args = [];
        const par = s.target.parentPath;
        if (!s.clear && par.isSequenceExpression()) {
          const i = par.node.expressions.indexOf(s.target.node);
          const prev = par.node.expressions[i - 1];
          if (i > 0 && t.isAssignmentExpression(prev, { operator: '=' }) && t.isIdentifier(prev.left, { name: d.payload }) &&
              t.isArrayExpression(prev.right) && prev.right.elements.every((x) => x !== null)) {
            args = prev.right.elements;
            seq = { par, i };
          }
        }
        if (!args) continue;
        const call = t.callExpression(t.identifier(nameFor(s.key)), args);
        if (seq) {
          const exprs = seq.par.node.expressions.slice();
          exprs.splice(seq.i - 1, 2, call);
          seq.par.replaceWith(exprs.length === 1 ? exprs[0] : t.sequenceExpression(exprs));
        } else {
          s.target.replaceWith(call);
        }
        done++;
      }
      if (!done) return;
      const decls = [...made].map(([key, name]) => {
        const e = entries.get(key);
        const body = e.rest.map((x) => t.cloneNode(x, true));
        if (restForm.has(key) && e.params.length) {
          const argsId = t.identifier(`${name}Args`);
          return t.functionDeclaration(t.identifier(name), [t.restElement(argsId)], t.blockStatement([
            t.variableDeclaration('var', [t.variableDeclarator(t.arrayPattern(e.params.map((x) => t.cloneNode(x, true))), t.cloneNode(argsId))]),
            ...body,
          ]));
        }
        return t.functionDeclaration(t.identifier(name), e.params.map((x) => t.cloneNode(x, true)), t.blockStatement(body));
      });
      p.insertAfter(decls);
      n += done;
      onLog(`confuser: dispatcher ${p.node.id.name} — ${done} çağrı ${made.size} ayrı fonksiyona bağlandı`, 'info');
      p.parentPath.scope.crawl();
      const after = p.parentPath.scope.getBinding(p.node.id.name);
      if (after && after.referencePaths.every((r) => r.findParent((x) => x === p))) p.remove();
    },
  });
  return n;
}

// ── A-21: rest parametre + length ───────────────────────

function restParams(ast) {
  let n = 0;
  traverse(ast, {
    Function(p) {
      const params = p.node.params;
      if (params.length !== 1 || !t.isRestElement(params[0]) || !t.isIdentifier(params[0].argument) || !t.isBlockStatement(p.node.body)) return;
      const M = params[0].argument.name;
      const first = p.node.body.body[0];
      const a = t.isExpressionStatement(first) && first.expression;
      if (!t.isAssignmentExpression(a, { operator: '=' }) || !t.isMemberExpression(a.left) || a.left.computed ||
          !t.isIdentifier(a.left.object, { name: M }) || !t.isIdentifier(a.left.property, { name: 'length' }) ||
          !t.isNumericLiteral(a.right) || !Number.isInteger(a.right.value) || a.right.value > 64) return;
      const N = a.right.value;
      if (!p.isArrowFunctionExpression() && usesArguments(p.node.body)) return;
      const b = p.scope.getOwnBinding(M);
      if (!b || b.constantViolations.length) return;
      const uses = [];
      for (const r of b.referencePaths) {
        if (r.findParent((x) => x.node === first)) continue;
        const m = r.parentPath;
        if (!m.isMemberExpression({ object: r.node }) || !m.node.computed || !t.isNumericLiteral(m.node.property)) return;
        const k = m.node.property.value;
        if (!Number.isInteger(k) || k < 0 || k >= N) return;
        if (m.parentPath.isUnaryExpression({ operator: 'delete' }) || m.parentPath.isCallExpression({ callee: m.node })) return;
        uses.push({ m, k });
      }
      // length değişiyor (0 → N): fonksiyon yalnızca çağrılıyorsa gözlenemez
      const fnRefs = (() => {
        if (p.isFunctionDeclaration() && p.node.id) return p.parentPath.scope.getBinding(p.node.id.name)?.referencePaths ?? null;
        if (p.parentPath.isVariableDeclarator({ init: p.node }) && t.isIdentifier(p.parent.id)) {
          const vb = p.parentPath.scope.getBinding(p.parent.id.name);
          return vb?.constant ? vb.referencePaths : null;
        }
        if (p.parentPath.isCallExpression({ callee: p.node })) return [];
        return null;
      })();
      if (!fnRefs || !fnRefs.every((r) => r.parentPath.isCallExpression({ callee: r.node }) || r.parentPath.isNewExpression({ callee: r.node }))) return;
      const ids = Array.from({ length: N }, () => p.scope.generateUidIdentifier('arg'));
      p.node.params = ids;
      p.node.body.body.shift();
      for (const u of uses) u.m.replaceWith(t.identifier(ids[u.k].name));
      n++;
    },
  });
  return n;
}

// ── A-22: __generator → function* ───────────────────────

function generatorHelpers(ast) {
  const names = new Set();
  traverse(ast, {
    'FunctionDeclaration|VariableDeclarator'(p) {
      const id = p.isFunctionDeclaration() ? p.node.id : p.node.id;
      if (!t.isIdentifier(id)) return;
      const src = gen(p.node);
      if (src.includes('Generator is already executing') && src.length < 4000) {
        const b = (p.isFunctionDeclaration() ? p.parentPath.scope : p.scope).getBinding(id.name);
        if (b?.constant) names.add(id.name);
      }
    },
  });
  return names;
}

class NoGen extends Error {}
const nogen = (why) => { throw new NoGen(why); };

// _a.sent()
const isSent = (n, a) => t.isCallExpression(n) && !n.arguments.length && t.isMemberExpression(n.callee) && !n.callee.computed &&
  t.isIdentifier(n.callee.object, { name: a }) && t.isIdentifier(n.callee.property, { name: 'sent' });

function opOf(ret) {
  const arg = ret.argument;
  if (!t.isArrayExpression(arg) || !arg.elements.length || !t.isNumericLiteral(arg.elements[0]) || arg.elements.length > 2) return nogen('dönüş biçimi');
  return { op: arg.elements[0].value, value: arg.elements[1] ?? null };
}

// [2, e] dönüşlerini `return e`'ye çevirir; iç fonksiyonlara girmez. [4, …] ve diğer işlemler burada yasak.
function rewriteReturns(node, a) {
  const walk = (n) => {
    if (!n || typeof n !== 'object') return n;
    if (t.isFunction(n)) return n;
    if (t.isReturnStatement(n)) {
      const { op, value } = opOf(n);
      if (op !== 2) nogen(`iç işlem ${op}`);
      return t.returnStatement(value ? walk(value) : null);
    }
    if (t.isMemberExpression(n) && t.isIdentifier(n.object, { name: a })) nogen('_a kullanımı');
    if ((t.isBreakStatement(n) || t.isContinueStatement(n)) && n.label) nogen('etiketli atlama');
    for (const k of t.VISITOR_KEYS[n.type] ?? []) {
      const v = n[k];
      if (Array.isArray(v)) n[k] = v.map(walk); else n[k] = walk(v);
    }
    return n;
  };
  return walk(t.cloneNode(node, true));
}

// switch'i hedefleyen etiketsiz break (iç döngü/switch dışında) var mı?
function breaksSwitch(stmts) {
  let found = false;
  const walk = (n, nested) => {
    if (!n || typeof n !== 'object' || found || t.isFunction(n)) return;
    if (t.isBreakStatement(n) && !n.label && !nested) { found = true; return; }
    const inner = nested || t.isLoop(n) || t.isSwitchStatement(n);
    for (const k of t.VISITOR_KEYS[n.type] ?? []) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach((c) => walk(c, inner)); else walk(v, inner);
    }
  };
  stmts.forEach((s) => walk(s, false));
  return found;
}

// _a.sent() içeren ilk deyim: yield ifadesini sonucun yerine koy
function placeYield(stmt, a, yieldExpr) {
  if (t.isExpressionStatement(stmt) && isSent(stmt.expression, a)) return t.expressionStatement(yieldExpr);
  if (t.isExpressionStatement(stmt) && t.isAssignmentExpression(stmt.expression, { operator: '=' }) &&
      t.isIdentifier(stmt.expression.left) && isSent(stmt.expression.right, a)) {
    return t.expressionStatement(t.assignmentExpression('=', stmt.expression.left, yieldExpr));
  }
  if (t.isVariableDeclaration(stmt) && stmt.declarations.length === 1 && t.isIdentifier(stmt.declarations[0].id) &&
      isSent(stmt.declarations[0].init, a)) {
    return t.variableDeclaration(stmt.kind, [t.variableDeclarator(stmt.declarations[0].id, yieldExpr)]);
  }
  if (t.isReturnStatement(stmt) && t.isArrayExpression(stmt.argument) && stmt.argument.elements.length === 2 &&
      t.isNumericLiteral(stmt.argument.elements[0], { value: 2 }) && isSent(stmt.argument.elements[1], a)) {
    return t.returnStatement(yieldExpr);
  }
  return null;
}

function containsSent(node, a) {
  let found = false;
  t.traverseFast(node, (n) => { if (isSent(n, a)) found = true; });
  return found;
}

function linearize(bodyFn) {
  const a = bodyFn.params.length ? (t.isIdentifier(bodyFn.params[0]) ? bodyFn.params[0].name : nogen('parametre')) : '__none';
  if (bodyFn.params.length > 1 || bodyFn.async || bodyFn.generator || t.isArrowFunctionExpression(bodyFn)) nogen('gövde biçimi');
  if (usesArguments(bodyFn.body)) nogen('arguments');
  const stmts = bodyFn.body.body;
  let cases;
  if (stmts.length === 1 && t.isSwitchStatement(stmts[0])) {
    const d = stmts[0].discriminant;
    if (!t.isMemberExpression(d) || d.computed || !t.isIdentifier(d.object, { name: a }) || !t.isIdentifier(d.property, { name: 'label' })) nogen('switch');
    cases = stmts[0].cases.map((c, i) => {
      if (!t.isNumericLiteral(c.test, { value: i })) nogen('etiket sırası');
      return c.consequent;
    });
  } else {
    cases = [stmts];
  }
  const out = [];
  let pendingYield = null;
  cases.forEach((list, ci) => {
    if (breaksSwitch(list)) nogen('break');
    let body = list.slice();
    if (pendingYield) {
      const first = body[0];
      const placed = first && placeYield(first, a, pendingYield);
      if (placed) body = body.slice(1);
      out.push(placed ?? t.expressionStatement(pendingYield));
      pendingYield = null;
    }
    if (body.some((s) => containsSent(s, a))) nogen('_a.sent() konumu');
    const last = body[body.length - 1];
    if (t.isReturnStatement(last)) {
      const { op, value } = opOf(last);
      if (op === 4) {
        if (ci === cases.length - 1) nogen('son yield');
        out.push(...body.slice(0, -1).map((s) => rewriteReturns(s, a)));
        pendingYield = t.yieldExpression(value ? rewriteReturns(value, a) : null);
        return;
      }
    } else if (ci === cases.length - 1) nogen('son case dönüşsüz');
    out.push(...body.map((s) => rewriteReturns(s, a)));
  });
  return out;
}

function generators(ast, onLog) {
  const helpers = generatorHelpers(ast);
  if (!helpers.size) return 0;
  let n = 0;
  traverse(ast, {
    CallExpression(p) {
      const { callee, arguments: args } = p.node;
      if (!t.isIdentifier(callee) || !helpers.has(callee.name) || p.scope.getBinding(callee.name)?.scope.path.isProgram() === false) return;
      if (args.length !== 2 || !t.isThisExpression(args[0]) || !t.isFunctionExpression(args[1])) return;
      const ret = p.parentPath;
      if (!ret.isReturnStatement()) return;
      const fnPath = ret.parentPath.parentPath;
      if (!fnPath?.isFunction() || fnPath.isArrowFunctionExpression() || fnPath.node.async || fnPath.node.generator) return;
      const fnBody = fnPath.node.body.body;
      if (fnBody[fnBody.length - 1] !== ret.node) return;
      // önce çalışan deyimler: yalnızca başlangıçsız var (üreteç gövdesi ilk next()'e kadar ertelenir)
      const prelude = fnBody.slice(0, -1);
      if (!prelude.every((s) => t.isVariableDeclaration(s, { kind: 'var' }) && s.declarations.every((d) => !d.init))) return;
      // üreteç fonksiyonu new ile çağrılamaz: yalnızca çağrılan ya da __awaiter'a verilen fonksiyonlar
      const okUse = (() => {
        if (fnPath.isFunctionDeclaration()) {
          const b = fnPath.parentPath.scope.getBinding(fnPath.node.id.name);
          return b?.constant && b.referencePaths.every((r) => r.parentPath.isCallExpression({ callee: r.node }));
        }
        const par = fnPath.parentPath;
        if (par.isCallExpression() && par.node.arguments.includes(fnPath.node) && t.isIdentifier(par.node.callee) &&
            /awaiter/i.test(par.node.callee.name)) return true;
        if (par.isVariableDeclarator({ init: fnPath.node }) && t.isIdentifier(par.node.id)) {
          const b = par.scope.getBinding(par.node.id.name);
          return b?.constant && b.referencePaths.every((r) => r.parentPath.isCallExpression({ callee: r.node }));
        }
        return false;
      })();
      if (!okUse) return;
      let body;
      try { body = linearize(args[1]); } catch (e) {
        if (!(e instanceof NoGen)) throw e;
        onLog(`confuser: __generator açılamadı (${e.message})`, 'warn');
        return;
      }
      fnPath.node.generator = true;
      fnPath.node.body = t.blockStatement([...prelude, ...body]);
      n++;
    },
  });
  if (n) onLog(`confuser: ${n} __generator durum makinesi function*'a çevrildi`, 'info');
  // kullanılmayan yardımcı: var __generator = (this && this.__generator) || function (...) {...}
  // shortcut: global nesnede __generator getter'ı olmadığı varsayılır (tslib kalıbı; okuma yan etkisiz)
  if (!n) return 0;
  traverse(ast, {
    Program(p) { p.scope.crawl(); },
    VariableDeclarator(p) {
      if (!t.isIdentifier(p.node.id) || !helpers.has(p.node.id.name)) return;
      const b = p.scope.getBinding(p.node.id.name);
      const init = p.node.init;
      if (!b || b.referenced || !t.isLogicalExpression(init, { operator: '||' }) || !t.isFunctionExpression(init.right)) return;
      const left = init.left;
      const member = t.isLogicalExpression(left, { operator: '&&' }) ? left.right : left;
      if (!t.isMemberExpression(member) || member.computed || !t.isIdentifier(member.property, { name: p.node.id.name })) return;
      p.remove();
      n++;
    },
  });
  return n;
}

export async function run(ast, { onLog, bump }) {
  const d = dispatchers(ast, onLog);
  const r = restParams(ast);
  if (r) onLog(`confuser: ${r} fonksiyonda rest parametre + length gerçek parametrelere çevrildi`, 'info');
  const g = generators(ast, onLog);
  bump('dispatcher', d);
  bump('restParams', r);
  bump('generator', g);
}
