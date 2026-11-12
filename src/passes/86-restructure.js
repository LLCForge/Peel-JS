import * as t from '@babel/types';
import { traverse } from '../util/ast.js';

// Yapısal gizleme geri alma (anlamı koruyan, yerel olarak kanıtlanabilen dönüşümler):
//   E49  /re/g.flags → "g", /re/i.global → false, /re/.toString() → "/re/", "abc".length → 3
//   E50  var [a, b] = [x, y] → var a = x, b = y;  var { k: v } = o → var v = o.k;  [a, b] = [x, y]; → a = x; b = y;
//   E51  void 0 → undefined (undefined gölgelenmemişse)
//   E54  return a ? b : c ? d : e → if/else zinciri; x = a ? b : c ? d : e; ve var x = … için de
//   E55  function f(...M) { M.length = 2; M[0]; M[1] } → function f(p0, p1) (js-confuser)
//   E57  with (o) { k; } → o.k  (o değişmeyen, anahtarları bilinen sabit nesne)

const FLAG_PROPS = { global: 'g', ignoreCase: 'i', multiline: 'm', sticky: 'y', unicode: 'u', dotAll: 's', hasIndices: 'd', unicodeSets: 'v' };
const OBJECT_PROTO = new Set(['toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString', 'constructor', '__proto__',
  '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__']);

const propName = (m) => (!m.computed && t.isIdentifier(m.property) ? m.property.name : t.isStringLiteral(m.property) ? m.property.value : null);

// Yan etkisiz ve hangi sırada değerlendirildiği önemsiz ifade
function isPure(n) {
  return t.isLiteral(n) && !t.isTemplateLiteral(n) || t.isIdentifier(n) || t.isFunctionExpression(n) || t.isArrowFunctionExpression(n) ||
    (t.isTemplateLiteral(n) && !n.expressions.length) || (t.isUnaryExpression(n) && ['-', '+', '!', '~', 'void'].includes(n.operator) && isPure(n.argument));
}

function names(node, out = new Set()) {
  if (t.isIdentifier(node)) out.add(node.name);
  else if (node && typeof node === 'object') {
    for (const k of t.VISITOR_KEYS[node.type] ?? []) {
      const v = node[k];
      if (Array.isArray(v)) v.forEach((x) => x && names(x, out));
      else if (v) names(v, out);
    }
  }
  return out;
}

// E54: koşul zincirini if/else'e çevir; leaf(expr) her yaprak için deyim üretir
function chain(cond, leaf) {
  const branch = (e) => (t.isConditionalExpression(e) ? chain(e, leaf) : t.blockStatement([leaf(e)]));
  return t.ifStatement(cond.test, branch(cond.consequent), branch(cond.alternate));
}
const nested = (c) => t.isConditionalExpression(c) && (t.isConditionalExpression(c.consequent) || t.isConditionalExpression(c.alternate));

export async function run(ast, { onLog, bump }) {
  let n = 0;
  traverse(ast, {
    // E51
    UnaryExpression(p) {
      if (p.node.operator === 'void' && t.isNumericLiteral(p.node.argument) && !p.scope.hasBinding('undefined', true)) {
        p.replaceWith(t.identifier('undefined'));
        n++;
      }
    },
    // E49
    MemberExpression(p) {
      const { object } = p.node;
      const prop = propName(p.node);
      if (t.isStringLiteral(object) && prop === 'length' && !p.parentPath.isAssignmentExpression({ left: p.node })) {
        p.replaceWith(t.numericLiteral(object.value.length));
        n++;
        return;
      }
      if (!t.isRegExpLiteral(object) || !prop || p.parentPath.isAssignmentExpression({ left: p.node })) return;
      let v;
      if (prop === 'flags') v = t.stringLiteral([...object.flags].sort((a, b) => 'dgimsuvy'.indexOf(a) - 'dgimsuvy'.indexOf(b)).join(''));
      else if (Object.hasOwn(FLAG_PROPS, prop)) v = t.booleanLiteral(object.flags.includes(FLAG_PROPS[prop]));
      else if (prop === 'lastIndex') v = t.numericLiteral(0);
      else if (prop === 'source') v = t.stringLiteral(object.pattern || '(?:)');
      else if (prop === 'toString' && p.parentPath.isCallExpression({ callee: p.node }) && !p.parentPath.node.arguments.length) {
        p.parentPath.replaceWith(t.stringLiteral(`/${object.pattern || '(?:)'}/${object.flags}`));
        n++;
        return;
      }
      if (!v || p.parentPath.isCallExpression({ callee: p.node })) return;
      p.replaceWith(v);
      n++;
    },
    // E50: bildirimde dizi/nesne deseni
    VariableDeclaration(p) {
      if (p.parentPath.isFor() && p.parentPath.node.init !== p.node) return; // for-in/of başı
      const out = [];
      let changed = false;
      for (const d of p.node.declarations) {
        const split = splitPattern(d.id, d.init);
        if (split) { out.push(...split.map(([id, init]) => t.variableDeclarator(id, init))); changed = true; } else out.push(d);
      }
      if (!changed) return;
      p.node.declarations = out;
      n++;
    },
    // E50: deyim olarak destructuring atama; E54: atama ternary zinciri
    ExpressionStatement(p) {
      const e = p.node.expression;
      if (!t.isAssignmentExpression(e, { operator: '=' })) return;
      const split = splitPattern(e.left, e.right, true);
      if (split) {
        p.replaceWithMultiple(split.map(([l, r]) => t.expressionStatement(t.assignmentExpression('=', l, r))));
        n++;
        return;
      }
      if (nested(e.right) && (t.isIdentifier(e.left) || (t.isMemberExpression(e.left) && t.isIdentifier(e.left.object) && !e.left.computed))) {
        p.replaceWith(chain(e.right, (leaf) => t.expressionStatement(t.assignmentExpression('=', t.cloneNode(e.left), leaf))));
        n++;
      }
    },
    // E54: return ternary zinciri
    ReturnStatement(p) {
      if (!nested(p.node.argument)) return;
      p.replaceWith(chain(p.node.argument, (leaf) => t.returnStatement(leaf)));
      n++;
    },
    // E55
    Function(p) {
      if (restToParams(p)) n++;
    },
    // E57
    WithStatement(p) {
      if (unwrapWith(p)) n++;
    },
  });
  // E54: var x = a ? b : c ? d : e; → var x; if … (const hariç; tek bildirim)
  traverse(ast, {
    VariableDeclaration(p) {
      const { node } = p;
      if (node.kind === 'const' || node.declarations.length !== 1 || !p.parentPath.isBlockStatement() && !p.parentPath.isProgram()) return;
      const d = node.declarations[0];
      if (!t.isIdentifier(d.id) || !nested(d.init)) return;
      const init = d.init;
      d.init = null;
      p.insertAfter(chain(init, (leaf) => t.expressionStatement(t.assignmentExpression('=', t.identifier(d.id.name), leaf))));
      n++;
    },
  });
  if (n) onLog(`restructure: ${n} yapı sadeleştirildi`, 'info');
  bump('restructure', n);
}

// Desen + değer çiftlerini [hedef, değer] listesine ayırır; güvenli değilse null
function splitPattern(id, init, assignment = false) {
  if (!init) return null;
  if (t.isArrayPattern(id) && t.isArrayExpression(init)) {
    if (id.elements.length !== init.elements.length || !id.elements.length) return null;
    const lhs = new Set();
    for (const el of id.elements) {
      if (!t.isIdentifier(el)) return null; // boşluk, rest, varsayılan ya da iç içe desen
      lhs.add(el.name);
    }
    if (lhs.size !== id.elements.length) return null;
    for (const v of init.elements) {
      if (!v || t.isSpreadElement(v)) return null;
      // takas ([a, b] = [b, a]) ve çapraz okuma sıralı atamada anlamı değiştirir
      if ([...names(v)].some((x) => lhs.has(x))) return null;
      if (!isPure(v) && init.elements.length > 1) return null;
    }
    return id.elements.map((el, i) => [el, init.elements[i]]);
  }
  if (t.isObjectPattern(id) && !assignment) {
    if (!id.properties.length) return null;
    const pairs = [];
    for (const prop of id.properties) {
      if (!t.isObjectProperty(prop) || prop.computed || !t.isIdentifier(prop.value)) return null;
      const key = t.isIdentifier(prop.key) ? prop.key.name : t.isStringLiteral(prop.key) ? prop.key.value : null;
      if (key === null) return null;
      pairs.push([key, prop.value]);
    }
    // var { a: x, b: y } = { a: 1, b: 2 }
    if (t.isObjectExpression(init)) {
      const map = new Map();
      for (const q of init.properties) {
        if (!t.isObjectProperty(q) || q.computed) return null;
        const key = t.isIdentifier(q.key) ? q.key.name : t.isStringLiteral(q.key) ? q.key.value : null;
        if (key === null || map.has(key) || !isPure(q.value) || key === '__proto__') return null;
        map.set(key, q.value);
      }
      const lhs = new Set(pairs.map(([, v]) => v.name));
      if ([...map.values()].some((v) => [...names(v)].some((x) => lhs.has(x)))) return null;
      return pairs.map(([k, v]) => [v, map.has(k) ? map.get(k) : t.identifier('undefined')]);
    }
    // var { log: l } = console → var l = console.log (kaynak düz ad: iki kez okumak güvenli)
    if (t.isIdentifier(init) && !pairs.some(([, v]) => v.name === init.name)) {
      return pairs.map(([k, v]) => [v, t.memberExpression(t.identifier(init.name), t.isValidIdentifier(k) ? t.identifier(k) : t.stringLiteral(k), !t.isValidIdentifier(k))]);
    }
  }
  return null;
}

function restToParams(p) {
  const { params } = p.node;
  if (params.length !== 1 || !t.isRestElement(params[0]) || !t.isIdentifier(params[0].argument)) return false;
  if (!t.isBlockStatement(p.node.body)) return false;
  const name = params[0].argument.name;
  const b = p.scope.getBinding(name);
  if (!b) return false;
  const body = p.node.body.body;
  let count = null;
  let lengthStmt = null;
  const first = body[0];
  if (t.isExpressionStatement(first) && t.isAssignmentExpression(first.expression, { operator: '=' }) &&
      t.isMemberExpression(first.expression.left) && t.isIdentifier(first.expression.left.object, { name }) &&
      propName(first.expression.left) === 'length' && t.isNumericLiteral(first.expression.right)) {
    count = first.expression.right.value;
    lengthStmt = first;
  }
  const indices = [];
  for (const r of b.referencePaths) {
    const m = r.parentPath;
    if (lengthStmt && m.node === lengthStmt.expression.left) continue;
    if (!m.isMemberExpression({ object: r.node }) || !m.node.computed || !t.isNumericLiteral(m.node.property)) return false;
    const k = m.node.property.value;
    if (!Number.isInteger(k) || k < 0 || k > 32) return false;
    indices.push(k);
  }
  if (b.constantViolations.length) return false;
  if (count === null) {
    // length kesilmemişse dizi uzunluğu argüman sayısına bağlıdır; yalnızca okunuyorsa güvenli
    count = indices.length ? Math.max(...indices) + 1 : 0;
  }
  if (indices.some((k) => k >= count) || !Number.isInteger(count) || count > 32) return false;
  // arguments ile birlikte kullanılıyorsa (fazla argümanlar) dokunma
  let usesArguments = false;
  p.traverse({
    Identifier(q) { if (q.node.name === 'arguments' && q.isReferencedIdentifier()) usesArguments = true; },
    Function(q) { if (!q.isArrowFunctionExpression()) q.skip(); },
  });
  if (usesArguments) return false;
  const ids = Array.from({ length: count }, (_, i) => p.scope.generateUidIdentifier(`p${i}`));
  for (const r of b.referencePaths) {
    const m = r.parentPath;
    if (lengthStmt && m.node === lengthStmt.expression.left) continue;
    m.replaceWith(t.identifier(ids[m.node.property.value].name));
  }
  p.node.params = ids;
  if (lengthStmt) p.node.body.body = body.filter((s) => s !== lengthStmt);
  p.scope.crawl();
  return true;
}

function unwrapWith(p) {
  const obj = p.node.object;
  if (!t.isIdentifier(obj)) return false;
  const b = p.scope.getBinding(obj.name);
  if (!b || !b.constant || !t.isVariableDeclarator(b.path.node) || !t.isObjectExpression(b.path.node.init)) return false;
  // nesne hiç değiştirilmemeli: tüm referanslar with nesnesi ya da hesaplanmamış üye okuması
  for (const r of b.referencePaths) {
    const parent = r.parentPath;
    if (parent.isWithStatement({ object: r.node })) continue;
    if (parent.isMemberExpression({ object: r.node }) && !parent.parentPath.isAssignmentExpression({ left: parent.node }) &&
        !parent.parentPath.isUpdateExpression() && !parent.parentPath.isUnaryExpression({ operator: 'delete' }) &&
        !parent.parentPath.isCallExpression({ callee: parent.node })) continue;
    return false;
  }
  const keys = new Set();
  for (const q of b.path.node.init.properties) {
    if (!t.isObjectProperty(q) || q.computed) return false;
    const k = t.isIdentifier(q.key) ? q.key.name : t.isStringLiteral(q.key) ? q.key.value : null;
    if (k === null || k === '__proto__') return false;
    keys.add(k);
  }
  // with gövdesindeki serbest isimler: anahtarsa nesne üyesine, prototip adıysa vazgeç
  let unsafe = false;
  const targets = [];
  p.get('body').traverse({
    Identifier(q) {
      if (!q.isReferencedIdentifier() && !(q.parentPath.isAssignmentExpression({ left: q.node }) || q.parentPath.isUpdateExpression())) return;
      const name = q.node.name;
      // gövde içinde bildirilen isim with kapsamında değil, kendi bağlamasına çözülür
      const own = q.scope.getBinding(name);
      if (own && own.scope !== b.scope && isInside(own.scope.path, p)) return;
      if (OBJECT_PROTO.has(name) && !keys.has(name)) { unsafe = true; return; }
      if (keys.has(name)) targets.push(q);
    },
    // var/function bildirimleri with nesnesine değil fonksiyon kapsamına gider; anahtarla çakışırsa anlam karışır
    'VariableDeclarator|FunctionDeclaration'(q) {
      const id = q.node.id;
      if (t.isIdentifier(id) && keys.has(id.name)) unsafe = true;
    },
  });
  if (unsafe) return false;
  for (const q of targets) q.replaceWith(t.memberExpression(t.identifier(obj.name), t.identifier(q.node.name)));
  p.replaceWith(p.node.body);
  return true;
}

const isInside = (scopePath, withPath) => scopePath === withPath || Boolean(scopePath.findParent((x) => x === withPath));
