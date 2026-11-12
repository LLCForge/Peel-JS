import * as t from '@babel/types';
import { traverse, gen } from '../util/ast.js';
import { machineSwitch, decompile } from '../naming/regenerator.js';
import { scan, runsAfter, isStrict, strictSafe, callOnlyProperty } from '../naming/scope.js';
import { provablyPrimitive } from './97-modern-syntax.js';

// 79: Babel/regenerator kalıntılarını geri çevirme.
//  - regeneratorRuntime.mark/wrap durum makinesi → function*  (try/catch/finally, döngü, if/else, yield*)
//  - _asyncToGenerator(function* …) → async function (IIFE, "_foo.apply(this, arguments)" ikilisi, _ref sarmalayıcısı)
//  - _classCallCheck + _createClass → class
//  - _typeof → typeof, _toConsumableArray → [...x], _slicedToArray → [a, b] deseni, _objectSpread → {...a},
//    _extends → Object.assign, _defineProperty({}, k, v) → { [k]: v }
// Yardımcılar adlarıyla değil gövde biçimleriyle tanınır (küçültülmüş çıktıda da çalışır).
// Kalıtım (_inherits/_createSuper) çevrilmez: super() dönüş değeri ve this başlatma sırası kanıtlanamıyor.

// Yardımcıların iç parçaları: gövdeleri jeneratör nesnesi/tanımlayıcı dizisi üzerinde çalışır, kullanıcı metotlarını okumaz
export const SUPPORT_NAME = /^_?(asyncGeneratorStep|defineProperties|toPropertyKey|toPrimitive|ownKeys|arrayLikeToArray|unsupportedIterableToArray|iterableToArray|iterableToArrayLimit|arrayWithoutHoles|arrayWithHoles|nonIterableSpread|nonIterableRest|regeneratorRuntime|regenerator|getPrototypeOf|setPrototypeOf|objectWithoutProperties|objectWithoutPropertiesLoose|taggedTemplateLiteral|interopRequireDefault|interopRequireWildcard)\d*$/;
const HELPER_NAME = /^_?(typeof|toConsumableArray|slicedToArray|objectSpread2?|extends|defineProperty|classCallCheck|createClass|asyncToGenerator)\d*$/;

function helperKind(name, code, program) {
  const m = HELPER_NAME.exec(name);
  if (!m) return null;
  const kind = m[1];
  switch (kind) {
    case 'typeof': return code.includes('Symbol.iterator') && code.includes('typeof') ? 'typeof' : null;
    case 'toConsumableArray': return /return \w+\(\w+\)\|\|\w+\(\w+\)\|\|\w+\(\w+\)\|\|\w+\(\)/.test(code) && program.includes('spread non-iterable') ? kind : null;
    case 'slicedToArray': return /return \w+\(\w+\)\|\|\w+\(\w+,\w+\)\|\|\w+\(\w+,\w+\)\|\|\w+\(\)/.test(code) && program.includes('destructure non-iterable') ? kind : null;
    case 'objectSpread': case 'objectSpread2':
      if (!code.includes('arguments')) return null;
      return code.includes('%2') ? 'objectSpread2' : (code.includes('Object.keys') ? 'objectSpread' : null);
    case 'extends': return code.includes('Object.assign') ? kind : null;
    case 'defineProperty': return code.includes('Object.defineProperty') && /enumerable:(!0|true)/.test(code) && /writable:(!0|true)/.test(code) ? kind : null;
    case 'classCallCheck': return code.includes('Cannot call a class as a function') ? kind : null;
    case 'createClass': return code.includes('prototype') && code.includes('defineProperty') ? kind : null;
    case 'asyncToGenerator': return code.includes('Promise') && code.includes('apply') ? kind : null;
    default: return null;
  }
}

export async function run(ast, { onLog, bump, naming = {} }) {
  if (naming.babel === false) return;
  const stats = { generators: 0, asyncs: 0, classes: 0, helpers: 0 };

  // ── 1) regenerator → function* ──
  traverse(ast, {
    CallExpression(p) {
      const fn = markedFunction(p);
      if (!fn) return;
      const out = toGenerator(fn.node, fn.wrapCall);
      if (!out) return;
      p.replaceWith(out);
      stats.generators++;
    },
    FunctionDeclaration(p) {
      // var _marked = R.mark(gen); function gen() { return R.wrap(function gen$(ctx) {…}, _marked); }
      const last = p.node.body.body.at(-1);
      if (!t.isReturnStatement(last) || !isWrapCall(last.argument)) return;
      const marker = last.argument.arguments[1];
      if (!t.isIdentifier(marker)) return;
      const mb = p.scope.getBinding(marker.name);
      if (!mb || !mb.constant || !mb.path.isVariableDeclarator() || mb.referencePaths.length !== 1) return;
      const init = mb.path.node.init;
      if (!isMarkCall(init) || !t.isIdentifier(init.arguments[0], { name: p.node.id.name })) return;
      const out = toGenerator(p.node, last.argument);
      if (!out) return;
      p.replaceWith(t.functionDeclaration(p.node.id, out.params, out.body, true, false));
      const decl = mb.path.parentPath;
      if (decl.node.declarations.length === 1) decl.remove(); else mb.path.remove();
      stats.generators++;
    },
  });

  const program = gen(ast.program);
  const helpers = new Map();
  const helperNodes = new Set();
  traverse(ast, {
    FunctionDeclaration(p) {
      if (!p.parentPath.isProgram() && !p.parentPath.parentPath?.isFunction()) return;
      const kind = helperKind(p.node.id.name, gen(p.node), program);
      if (!kind) return;
      const b = p.scope.getBinding(p.node.id.name);
      // yardımcı kendini önbellekli sürümle değiştirebilir (_typeof = …); başka yerde yazılmamalı
      if (!b || !b.constantViolations.every((v) => v.findParent((x) => x.node === p.node))) return;
      helpers.set(b, kind);
      helperNodes.add(p.node);
    },
  });
  const helperOf = (p) => {
    if (!t.isIdentifier(p.node)) return null;
    const b = p.scope.getBinding(p.node.name);
    return b ? helpers.get(b) ?? null : null;
  };

  // ── 2) basit yardımcılar ve async ──
  traverse(ast, {
    CallExpression: {
      exit(p) {
        const kind = helperOf(p.get('callee'));
        if (!kind || p.findParent((x) => helperNodes.has(x.node))) return;
        const args = p.node.arguments;
        if (args.some((a) => t.isSpreadElement(a))) return;
        let rep = null;
        if (kind === 'typeof' && args.length === 1) {
          // _typeof(tanımsızIsim) ReferenceError atar, typeof atmaz: çıplak global'de çevirme
          if (t.isIdentifier(args[0]) && !p.scope.getBinding(args[0].name)) return;
          rep = t.unaryExpression('typeof', args[0]);
        } else if (kind === 'toConsumableArray' && args.length === 1) {
          rep = t.arrayExpression([t.spreadElement(args[0])]);
        } else if (kind === 'extends' && !p.scope.getBinding('Object')) {
          rep = t.callExpression(t.memberExpression(t.identifier('Object'), t.identifier('assign')), args);
        } else if (kind === 'defineProperty' && args.length === 3 && t.isObjectExpression(args[0]) &&
          (t.isStringLiteral(args[1]) || t.isNumericLiteral(args[1]) || provablyPrimitive(p.get('arguments.1'), new Set()))) {
          rep = t.objectExpression([...args[0].properties, t.objectProperty(args[1], args[2], true)]);
        } else if ((kind === 'objectSpread' || kind === 'objectSpread2') && args.length && t.isObjectExpression(args[0]) && plainObject(args[0])) {
          rep = spreadObject(args, kind);
        } else if (kind === 'asyncToGenerator') {
          if (asyncCall(p, stats)) return;
        }
        if (!rep) return;
        p.replaceWith(rep);
        stats.helpers++;
      },
    },
    VariableDeclaration(p) {
      // var _ref = _slicedToArray(x, 2), a = _ref[0], b = _ref[1];  →  var [a, b] = x;
      const ds = p.node.declarations;
      for (let i = 0; i < ds.length; i++) {
        const d = ds[i];
        if (!t.isIdentifier(d.id) || !t.isCallExpression(d.init) || d.init.arguments.length !== 2) continue;
        const kind = helperOf(p.get(`declarations.${i}.init.callee`));
        if (kind !== 'slicedToArray' || !t.isNumericLiteral(d.init.arguments[1])) continue;
        const n = d.init.arguments[1].value;
        const b = p.scope.getBinding(d.id.name);
        if (!b || !b.constant) continue;
        const elems = new Array(n).fill(null);
        let j = i + 1;
        for (; j < ds.length; j++) {
          const e = ds[j];
          if (!t.isIdentifier(e.id) || !t.isMemberExpression(e.init) || !t.isIdentifier(e.init.object, { name: d.id.name }) ||
            !e.init.computed || !t.isNumericLiteral(e.init.property)) break;
          const k = e.init.property.value;
          if (k >= n || elems[k] || elems.slice(k + 1).some(Boolean)) break;
          elems[k] = t.identifier(e.id.name);
        }
        const used = j - i - 1;
        if (!used || b.referencePaths.length !== used) continue;
        // [a, , c]: sondaki boşluklar yineleyiciden fazladan değer çekmesin diye n korunur
        while (elems.length < n) elems.push(null);
        const pattern = t.arrayPattern(elems);
        ds.splice(i, j - i, t.variableDeclarator(pattern, d.init.arguments[0]));
        stats.helpers++;
      }
    },
  });

  // ── 3) _classCallCheck + _createClass → class ──
  traverse(ast, {
    FunctionDeclaration(p) {
      if (p.parentPath.isProgram() && SUPPORT_NAME.test(p.node.id.name)) helperNodes.add(p.node);
    },
  });
  const info = scan(ast, { ignore: helperNodes });
  traverse(ast, {
    FunctionDeclaration(p) {
      const c = createClassFor(p, helperOf, info);
      if (!c) return;
      stats.classes++;
    },
  });

  const total = stats.generators + stats.asyncs + stats.classes + stats.helpers;
  if (total) onLog(`babel: ${stats.generators} generator, ${stats.asyncs} async, ${stats.classes} sınıf, ${stats.helpers} yardımcı çağrısı geri çevrildi`, 'info');
  bump('babel', total);
}

// ── regenerator ─────────────────────────────────────────

const isMarkCall = (n) => t.isCallExpression(n) && t.isMemberExpression(n.callee) && !n.callee.computed &&
  t.isIdentifier(n.callee.property, { name: 'mark' }) && n.arguments.length === 1;
const isWrapCall = (n) => t.isCallExpression(n) && t.isMemberExpression(n.callee) && !n.callee.computed &&
  t.isIdentifier(n.callee.property, { name: 'wrap' }) && n.arguments.length >= 1 && t.isFunctionExpression(n.arguments[0]);

// R.mark(function f() { …; return R.wrap(function f$(ctx) {…}, f, this, tryLocs); })
function markedFunction(p) {
  if (!isMarkCall(p.node)) return null;
  const fn = p.node.arguments[0];
  if (!t.isFunctionExpression(fn) || fn.generator || fn.async) return null;
  const last = fn.body.body.at(-1);
  if (!t.isReturnStatement(last) || !isWrapCall(last.argument)) return null;
  if (gen(p.node.callee.object) !== gen(last.argument.callee.object)) return null;
  const marker = last.argument.arguments[1];
  if (marker && !(fn.id && t.isIdentifier(marker, { name: fn.id.name }))) return null;
  return { node: fn, wrapCall: last.argument };
}

function toGenerator(outer, wrapCall) {
  const [inner, , self, locs] = wrapCall.arguments;
  if (self && !t.isThisExpression(self) && !t.isNullLiteral(self)) return null;
  if (inner.params.length !== 1 || !t.isIdentifier(inner.params[0])) return null;
  const ctx = inner.params[0].name;
  const sw = machineSwitch(inner, ctx);
  if (!sw) return null;
  let tryLocs = [];
  if (locs) {
    if (!t.isArrayExpression(locs)) return null;
    tryLocs = locs.elements.map((e) => (t.isArrayExpression(e) ? [0, 1, 2, 3].map((k) => (t.isNumericLiteral(e.elements[k]) ? e.elements[k].value : null)) : null));
    if (tryLocs.some((x) => !x)) return null;
  }
  // iç fonksiyonda this: wrap(…, this) ile dış this'e bağlı; null/yoksa iç this kullanılmamalı
  if (!t.isThisExpression(self) && containsThis(inner.body)) return null;
  if (containsArguments(inner.body)) return null;
  const res = decompile(sw, ctx, tryLocs);
  if (!res) return null;
  const pre = outer.body.body.slice(0, -1).map((s) => t.cloneNode(s, true));
  const decls = res.temps.length ? [t.variableDeclaration('var', res.temps.map((n) => t.variableDeclarator(t.identifier(n))))] : [];
  const body = foldSent(t.blockStatement([...pre, ...decls, ...res.body]));
  return t.functionExpression(outer.id, outer.params, body, true, false);
}

function containsThis(node) {
  let found = false;
  t.traverseFast(node, (n) => { if (t.isThisExpression(n)) found = true; });
  return found;
}
function containsArguments(node) {
  let found = false;
  t.traverseFast(node, (n) => { if (t.isIdentifier(n, { name: 'arguments' })) found = true; });
  return found;
}

// _sent = yield X; a = _sent;  →  a = yield X;  (_sent başka yerde okunmuyorsa)
function foldSent(block) {
  let reads = 0;
  t.traverseFast(block, (n) => {
    if (t.isIdentifier(n, { name: '_sent' })) reads++;
    if (t.isVariableDeclarator(n) && t.isIdentifier(n.id, { name: '_sent' })) reads--;
  });
  const assigns = [];
  const pairs = [];
  const walk = (list) => {
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      const e = t.isExpressionStatement(s) ? s.expression : null;
      if (e && t.isAssignmentExpression(e, { operator: '=' }) && t.isIdentifier(e.left, { name: '_sent' })) {
        assigns.push(s);
        const next = list[i + 1];
        const ne = t.isExpressionStatement(next) ? next.expression : null;
        if (ne && t.isAssignmentExpression(ne, { operator: '=' }) && t.isIdentifier(ne.right, { name: '_sent' }) && t.isIdentifier(ne.left)) {
          pairs.push([list, i]);
        }
      }
      for (const k of t.VISITOR_KEYS[s.type] ?? []) {
        const v = s[k];
        if (t.isBlockStatement(v)) walk(v.body);
        else if (t.isStatement(v) && !t.isFunction(v)) walk([v]);
        else if (Array.isArray(v) && v.every((x) => t.isSwitchCase(x))) v.forEach((c) => walk(c.consequent));
        else if (t.isCatchClause(v)) walk(v.body.body);
      }
    }
  };
  walk(block.body);
  // her atama bir okuma ile eşleşiyorsa ve tüm okumalar bu çiftlerdeyse katla
  if (pairs.length !== assigns.length || reads !== assigns.length * 2) return block;
  for (const [list, i] of pairs.reverse()) {
    const y = list[i].expression.right;
    list[i + 1].expression.right = y;
    list.splice(i, 1);
  }
  // var _sent bildirimini kaldır
  for (const s of block.body) {
    if (t.isVariableDeclaration(s)) s.declarations = s.declarations.filter((d) => !t.isIdentifier(d.id, { name: '_sent' }));
  }
  block.body = block.body.filter((s) => !(t.isVariableDeclaration(s) && !s.declarations.length));
  return block;
}

// ── async ───────────────────────────────────────────────

// generator ifadesi → async (yield → await); yield* içeriyorsa null
function asyncFrom(genFn) {
  if (!t.isFunctionExpression(genFn) || !genFn.generator || genFn.async) return null;
  let ok = true;
  const body = t.cloneNode(genFn.body, true);
  const visit = (n) => {
    if (!n || typeof n !== 'object' || !ok) return;
    if (Array.isArray(n)) { n.forEach(visit); return; }
    if (!n.type || (t.isFunction(n))) return;
    for (const k of t.VISITOR_KEYS[n.type] ?? []) {
      const v = n[k];
      if (t.isYieldExpression(v)) {
        if (v.delegate) { ok = false; return; }
        n[k] = t.awaitExpression(v.argument ?? t.identifier('undefined'));
        visit(n[k]);
      } else if (Array.isArray(v)) {
        v.forEach((x, i) => {
          if (t.isYieldExpression(x)) {
            if (x.delegate) { ok = false; return; }
            v[i] = t.awaitExpression(x.argument ?? t.identifier('undefined'));
            visit(v[i]);
          } else visit(x);
        });
      } else visit(v);
    }
  };
  visit(body);
  if (!ok) return null;
  return { params: genFn.params, body };
}

// Function.length: varsayılanlı/rest ilk parametreye kadar
const fnLength = (params) => {
  let n = 0;
  for (const p of params) { if (t.isAssignmentPattern(p) || t.isRestElement(p)) break; n++; }
  return n;
};

// Sonuç fonksiyon yalnızca çağrılıyor ya da yerleşik bir API'ye callback veriliyor mu? (new/prototype/length okunmaz)
function callOnlyBinding(b) {
  if (!b || !b.constant) return false;
  return b.referencePaths.every((r) => {
    const par = r.parentPath;
    if (par.isCallExpression({ callee: r.node })) return true;
    if (par.isMemberExpression({ object: r.node }) && !par.node.computed && ['call', 'apply'].includes(par.node.property.name) &&
      par.parentPath.isCallExpression({ callee: par.node })) return true;
    if (par.isCallExpression() && t.isMemberExpression(par.node.callee)) {
      const k = par.node.callee.property.name;
      if (k === 'addEventListener' && par.node.arguments[1] === r.node) return true;
      if ((k === 'then' || k === 'catch') && par.node.arguments.includes(r.node)) return true;
    }
    if (par.isCallExpression() && t.isIdentifier(par.node.callee) && ['setTimeout', 'setInterval'].includes(par.node.callee.name) &&
      par.node.arguments[0] === r.node && !par.scope.getBinding(par.node.callee.name)) return true;
    return false;
  });
}

const isApplyThisArguments = (n, name) => t.isCallExpression(n) && t.isMemberExpression(n.callee) &&
  t.isIdentifier(n.callee.object, { name }) && t.isIdentifier(n.callee.property, { name: 'apply' }) &&
  n.arguments.length === 2 && t.isThisExpression(n.arguments[0]) && t.isIdentifier(n.arguments[1], { name: 'arguments' });
const returnsApply = (fn, name) => fn.body.body.length === 1 && t.isReturnStatement(fn.body.body[0]) &&
  isApplyThisArguments(fn.body.body[0].argument, name);

// _asyncToGenerator(gen) çağrısının kalıpları; dönüştürdüyse true
function asyncCall(p, stats) {
  const conv = asyncFrom(p.node.arguments[0]);
  if (!conv || p.node.arguments.length !== 1) return false;
  const makeFn = (id) => t.functionExpression(id, conv.params, conv.body, false, true);
  const par = p.parentPath;

  // (a) hemen çağrılıyor: _asyncToGenerator(gen)() / .call(this) / .apply(this, arguments)
  if (par.isCallExpression({ callee: p.node }) ||
    (par.isMemberExpression({ object: p.node }) && !par.node.computed && ['call', 'apply'].includes(par.node.property.name) &&
      par.parentPath.isCallExpression({ callee: par.node }))) {
    p.replaceWith(makeFn(null));
    stats.asyncs++;
    return true;
  }

  // (b) function _foo() { _foo = H(gen); return _foo.apply(this, arguments); }  +  function foo(_x) { return _foo.apply(this, arguments); }
  if (par.isAssignmentExpression({ right: p.node }) && t.isIdentifier(par.node.left) && par.parentPath.isExpressionStatement()) {
    const inner = par.parentPath.parentPath.parentPath; // BlockStatement → FunctionDeclaration
    const name = par.node.left.name;
    if (!inner?.isFunctionDeclaration() || inner.node.id.name !== name || inner.node.body.body.length !== 2 ||
      !isApplyThisArguments(inner.node.body.body[1].argument, name)) return false;
    const b = inner.scope.parent.getBinding(name);
    if (!b) return false;
    const outside = b.referencePaths.filter((r) => !r.findParent((x) => x.node === inner.node));
    if (outside.length !== 1) return false;
    const pub = outside[0].findParent((x) => x.isFunctionDeclaration());
    if (!pub || !returnsApply(pub.node, name) || pub.parentPath.node !== inner.parentPath.node) return false;
    if (pub.node.params.length !== fnLength(conv.params) || pub.node.async || pub.node.generator) return false;
    if (!callOnlyBinding(pub.scope.parent.getBinding(pub.node.id.name))) return false;
    if (refersTo(conv.body, name)) return false;
    pub.replaceWith(t.functionDeclaration(pub.node.id, conv.params, conv.body, false, true));
    inner.remove();
    stats.asyncs++;
    return true;
  }

  // (c) function () { var _ref = H(gen); return function NAME(_x) { return _ref.apply(this, arguments); }; }()
  if (par.isVariableDeclarator({ init: p.node }) && t.isIdentifier(par.node.id)) {
    const decl = par.parentPath;
    const wrapper = decl.parentPath.parentPath; // BlockStatement → FunctionExpression
    if (!wrapper?.isFunctionExpression() || wrapper.node.params.length || decl.node.declarations.length !== 1) return false;
    const stmts = wrapper.node.body.body;
    const ref = par.node.id.name;
    let pub = null;
    if (stmts.length === 2 && stmts[0] === decl.node && t.isReturnStatement(stmts[1]) && t.isFunctionExpression(stmts[1].argument)) pub = stmts[1].argument;
    else if (stmts.length === 3 && stmts[0] === decl.node && t.isFunctionDeclaration(stmts[1]) && t.isReturnStatement(stmts[2]) &&
      t.isIdentifier(stmts[2].argument, { name: stmts[1].id.name })) pub = stmts[1];
    if (!pub || !returnsApply(pub, ref) || pub.async || pub.generator || pub.params.length !== fnLength(conv.params)) return false;
    const call = wrapper.parentPath;
    if (!call.isCallExpression({ callee: wrapper.node }) || call.node.arguments.length) return false;
    // sonuç sabit bir değişkene gidiyor ve yalnızca çağrılıyor olmalı
    const target = call.parentPath;
    if (!target.isVariableDeclarator({ init: call.node }) || !t.isIdentifier(target.node.id)) return false;
    if (!callOnlyBinding(target.scope.getBinding(target.node.id.name))) return false;
    const pubName = pub.id?.name ?? null;
    if (pubName && refersTo(conv.body, pubName) && pubName !== target.node.id.name) return false;
    if (refersTo(conv.body, ref)) return false;
    call.replaceWith(t.functionExpression(pubName ? t.identifier(pubName) : null, conv.params, conv.body, false, true));
    stats.asyncs++;
    return true;
  }
  return false;
}

// IIFE'nin sonucunun bağlandığı değişkenin her kullanımı uygun mu?
function outerUsesOk(inner, ok) {
  const fn = inner.getFunctionParent();
  const call = fn?.parentPath;
  if (!fn?.isFunctionExpression() || !call?.isCallExpression({ callee: fn.node }) || call.node.arguments.length) return false;
  const decl = call.parentPath;
  if (!decl.isVariableDeclarator({ init: call.node }) || !t.isIdentifier(decl.node.id)) return false;
  const b = decl.scope.getBinding(decl.node.id.name);
  return Boolean(b?.constant) && b.referencePaths.every(ok);
}

function refersTo(node, name) {
  let found = false;
  t.traverseFast(node, (n) => { if (t.isIdentifier(n, { name })) found = true; });
  return found;
}

// ── nesne yayma ─────────────────────────────────────────

const plainObject = (o) => o.properties.every((p) => t.isObjectProperty(p) && !p.computed &&
  !(t.isIdentifier(p.key, { name: '__proto__' }) || t.isStringLiteral(p.key, { value: '__proto__' })));

function spreadObject(args, kind) {
  const props = [...args[0].properties];
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    // objectSpread2: çift sıradaki argümanlar tanımlayıcı kopyası (getter korunur) → literal özellikleri olduğu gibi
    if (kind === 'objectSpread2' && i % 2 === 0) {
      if (!t.isObjectExpression(a) || a.properties.some((p) => t.isSpreadElement(p) || (t.isObjectProperty(p) && p.computed) ||
        t.isIdentifier(p.key, { name: '__proto__' }) || t.isStringLiteral(p.key, { value: '__proto__' }))) return null;
      props.push(...a.properties);
    } else if (t.isObjectExpression(a) && plainObject(a)) {
      props.push(...a.properties);
    } else {
      props.push(t.spreadElement(a));
    }
  }
  return t.objectExpression(props);
}

// ── sınıflar ────────────────────────────────────────────

function createClassFor(p, helperOf, info) {
  const fn = p.node;
  if (fn.async || fn.generator || !fn.id) return null;
  const first = fn.body.body[0];
  if (!t.isExpressionStatement(first) || !t.isCallExpression(first.expression)) return null;
  const chk = p.get('body.body.0.expression');
  if (helperOf(chk.get('callee')) !== 'classCallCheck') return null;
  const ca = first.expression.arguments;
  if (ca.length !== 2 || !t.isThisExpression(ca[0]) || !t.isIdentifier(ca[1], { name: fn.id.name })) return null;
  if (!p.inList) return null;
  const next = p.getSibling(p.key + 1);
  const nextExpr = next.isExpressionStatement() ? next.get('expression') : next.isReturnStatement() ? next.get('argument') : null;
  if (!nextExpr?.isCallExpression() || helperOf(nextExpr.get('callee')) !== 'createClass') return null;
  const [ctorArg, protoArg, staticArg] = nextExpr.node.arguments;
  if (!t.isIdentifier(ctorArg, { name: fn.id.name })) return null;
  const b = p.scope.getBinding(fn.id.name);
  if (!b || !b.constant) return null;

  const members = [];
  const addProps = (arr, isStatic) => {
    if (arr === undefined || t.isNullLiteral(arr) || t.isIdentifier(arr, { name: 'undefined' })) return true;
    if (!t.isArrayExpression(arr)) return false;
    for (const e of arr.elements) {
      if (!t.isObjectExpression(e)) return false;
      let key = null;
      const parts = {};
      for (const prop of e.properties) {
        if (!t.isObjectProperty(prop) || prop.computed || !t.isIdentifier(prop.key)) return false;
        parts[prop.key.name] = prop.value;
      }
      if (!t.isStringLiteral(parts.key)) return false;
      key = parts.key.value;
      if (key === 'constructor' || !t.isValidIdentifier(key)) return false;
      for (const kind of ['value', 'get', 'set']) {
        const f = parts[kind];
        if (!f) continue;
        if (!t.isFunctionExpression(f)) return false;
        if (f.id && refersTo(f.body, f.id.name)) return false;
        const m = t.classMethod(kind === 'value' ? 'method' : kind, t.identifier(key), f.params, f.body, false, isStatic, f.generator, f.async);
        members.push(m);
      }
      if (parts.value && !callOnlyProperty(info, key)) return false;
    }
    return true;
  };
  if (!addProps(protoArg, false) || !addProps(staticArg, true)) return null;

  // referanslar: yalnızca new, instanceof, statik üye, createClass/classCallCheck argümanı, IIFE'den return
  const end = next.node.end;
  const classUse = (r) => {
    const par = r.parentPath;
    if (par.isNewExpression({ callee: r.node })) return true;
    if (par.isBinaryExpression({ operator: 'instanceof', right: r.node })) return true;
    return par.isMemberExpression({ object: r.node }) && !par.node.computed && !['prototype', 'call', 'apply', 'bind'].includes(par.node.property.name);
  };
  for (const r of b.referencePaths) {
    if (r.node === ctorArg || r.node === ca[1]) continue;
    if (!runsAfter(r, end, p.parentPath, info)) return null;
    if (classUse(r)) continue;
    // var Foo = function () { …; return Foo; }();  dışarıdaki değişkenin kullanımları da aynı kurala uymalı
    if (r.parentPath.isReturnStatement() || (next.isReturnStatement() && r.node === ctorArg)) {
      if (!outerUsesOk(r, classUse)) return null;
      continue;
    }
    return null;
  }
  if (next.isReturnStatement() && !outerUsesOk(next, classUse)) return null;
  // sıkı mod: Babel sınıf çıktısı genelde "use strict" altında; değilse gövdeler sıkı moda uygun olmalı
  if (!isStrict(p)) {
    if (!strictSafe(p)) return null;
    let ok = true;
    for (const a of nextExpr.get('arguments')) {
      a.traverse({ FunctionExpression(q) { if (!strictSafe(q)) ok = false; q.skip(); } });
    }
    if (!ok) return null;
  }
  const ctorBody = t.blockStatement(fn.body.body.slice(1), fn.body.directives);
  const ctor = (ctorBody.body.length || fn.params.length) ? [t.classMethod('constructor', t.identifier('constructor'), fn.params, ctorBody)] : [];
  const cls = t.classDeclaration(fn.id, null, t.classBody([...ctor, ...members]));
  t.inheritsComments(cls, fn);
  if (next.isReturnStatement()) next.node.argument = t.identifier(fn.id.name);
  else next.remove();
  b.scope.removeOwnBinding(fn.id.name);
  p.replaceWith(cls);
  return cls;
}
