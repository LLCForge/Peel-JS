import * as t from '@babel/types';
import { traverse } from '../util/ast.js';

// E43: js-confuser dispatcher'ını geri alma. Dönüşüm fonksiyonları tek bir dispatcher'ın içine taşır:
//   function D(name, flagArg, returnTypeArg, fnLengths = {}) {
//     var output; var fns = { "k": function () { var [a, b] = P; return a + b; } };
//     if (flagArg === "E") { P = [] }
//     if (flagArg === "R") { function createFunction() {...} output = CACHE[name] || (CACHE[name] = createFunction()) } else { output = fns[name]() }
//     if (returnTypeArg === "T") { return { "X": output } } else { return output }
//   }
//   (P = [1, 2], D("k"))  →  k(1, 2)      D("k", "R")  →  k      D("k", "E")  →  k()
// Her fns girdisi adlandırılmış fonksiyon bildirimi olur; tüm çağrı yerleri tanınmazsa dispatcher'a dokunulmaz.

const strOf = (n) => (t.isStringLiteral(n) ? n.value : null);

// if (flagArg === "X") { ... } deyimlerinden bayrak değerleri ve rolleri
function readFlags(body, flagName, retName) {
  const flags = { empty: null, ref: null, ret: null, retKey: null };
  for (const s of body) {
    if (!t.isIfStatement(s) || !t.isBinaryExpression(s.test, { operator: '===' })) continue;
    const v = strOf(s.test.right);
    if (!v) continue;
    if (t.isIdentifier(s.test.left, { name: flagName })) {
      // referans dalı: fonksiyon nesnesi üretip önbelleğe koyar (createFunction), else dalı doğrudan çağırır
      if (s.alternate && t.isBlockStatement(s.consequent) && s.consequent.body.some((x) => t.isFunctionDeclaration(x))) flags.ref = v;
      else if (t.isBlockStatement(s.consequent) && s.consequent.body.length === 1 && t.isExpressionStatement(s.consequent.body[0]) &&
          t.isAssignmentExpression(s.consequent.body[0].expression) && t.isArrayExpression(s.consequent.body[0].expression.right) &&
          !s.consequent.body[0].expression.right.elements.length) flags.empty = v;
    } else if (t.isIdentifier(s.test.left, { name: retName })) {
      flags.ret = v;
      const ret = s.consequent.body?.[0];
      const obj = t.isReturnStatement(ret) && t.isObjectExpression(ret.argument) ? ret.argument.properties[0] : null;
      if (obj && t.isObjectProperty(obj)) flags.retKey = t.isIdentifier(obj.key) ? obj.key.name : strOf(obj.key);
    }
  }
  return flags;
}

function analyzeDispatcher(p) {
  const { node } = p;
  if (node.params.length < 3 || !node.params.slice(0, 3).every((x) => t.isIdentifier(x))) return null;
  const [nameP, flagP, retP] = node.params.map((x) => (t.isIdentifier(x) ? x.name : null));
  const body = node.body.body;
  // var fns = { ... } — fonksiyon değerli string anahtarlı nesne
  let fnsDecl = null;
  for (const s of body) {
    if (!t.isVariableDeclaration(s)) continue;
    for (const d of s.declarations) {
      if (t.isObjectExpression(d.init) && d.init.properties.length && d.init.properties.every((q) => t.isObjectProperty(q) && t.isFunctionExpression(q.value))) fnsDecl = d;
    }
  }
  if (!fnsDecl) return null;
  // payload değişkeni: fns fonksiyonlarının ilk deyimi var [..] = P
  let payload = null;
  const fns = new Map();
  for (const q of fnsDecl.init.properties) {
    const key = t.isIdentifier(q.key) ? q.key.name : strOf(q.key);
    if (key === null || q.computed) return null;
    const fn = q.value;
    if (fn.params.length || fn.async || fn.generator) return null;
    const first = fn.body.body[0];
    let params = [];
    let rest = fn.body.body;
    if (t.isVariableDeclaration(first) && first.declarations.length === 1 && t.isArrayPattern(first.declarations[0].id) && t.isIdentifier(first.declarations[0].init)) {
      const pName = first.declarations[0].init.name;
      if (payload && payload !== pName) return null;
      payload = pName;
      params = first.declarations[0].id.elements;
      if (params.some((e) => !e || !(t.isIdentifier(e) || t.isAssignmentPattern(e) || t.isRestElement(e)))) return null;
      rest = fn.body.body.slice(1);
    }
    fns.set(key, { params, body: rest, node: fn });
  }
  if (!payload) return null;
  const flags = readFlags(body, flagP, retP);
  return { nameP, flagP, retP, fns, payload, flags, fnsDecl };
}

// fns fonksiyonları dispatcher'ın yerel adlarına (name, flagArg, fns, output…) ya da this/arguments'a dokunmamalı
function selfContained(p, info) {
  let ok = true;
  const fnsPath = p.get('body.body').flatMap((s) => (s.isVariableDeclaration() ? s.get('declarations') : [])).find((d) => d.node === info.fnsDecl);
  for (const prop of fnsPath.get('init.properties')) {
    prop.get('value').traverse({
      ThisExpression(q) { if (!q.getFunctionParent().isArrowFunctionExpression() && q.getFunctionParent().node === prop.node.value) ok = false; },
      Identifier(q) {
        if (!q.isReferencedIdentifier()) return;
        if (q.node.name === 'arguments' && q.getFunctionParent()?.node === prop.node.value) { ok = false; return; }
        const b = q.scope.getBinding(q.node.name);
        if (b && b.scope === p.scope) ok = false;
        if (q.node.name === info.payload && !(q.parentPath.isVariableDeclarator() && q.parentPath.parentPath.parentPath.parentPath.node === prop.node.value)) ok = false;
      },
    });
  }
  return ok;
}

export async function run(ast, { onLog, bump }) {
  let n = 0;
  traverse(ast, {
    FunctionDeclaration(p) {
      const info = analyzeDispatcher(p);
      if (!info || !selfContained(p, info)) return;
      const binding = p.scope.parent.getBinding(p.node.id.name);
      if (!binding || binding.constantViolations.length) return;
      // her çağrı yeri: dönüşüm planı; biri bile tanınmazsa vazgeç
      const plans = [];
      for (const r of binding.referencePaths) {
        const call = r.parentPath;
        if (!call.isCallExpression({ callee: r.node })) return;
        const args = call.node.arguments;
        const key = strOf(args[0]);
        if (!key || !info.fns.has(key)) return;
        const flag = args[1] ? strOf(args[1]) : null;
        if (args[1] && flag === null && !t.isIdentifier(args[1], { name: 'undefined' })) return;
        const ret = args[2] ? strOf(args[2]) : null;
        let target = call;
        if (ret !== null) {
          if (ret !== info.flags.ret) return;
          // D("k", f, "T").X → çıktının kendisi
          const m = call.parentPath;
          if (!m.isMemberExpression({ object: call.node }) || (t.isIdentifier(m.node.property) ? m.node.property.name : strOf(m.node.property)) !== info.flags.retKey) return;
          target = m;
        }
        if (flag !== null && flag === info.flags.ref) { plans.push({ kind: 'ref', key, target }); continue; }
        if (flag !== null && flag === info.flags.empty) { plans.push({ kind: 'call', key, target, args: [] }); continue; }
        if (flag !== null) return;
        // (P = [..], D("k")) dizisi
        const seq = target.parentPath;
        if (!seq.isSequenceExpression() || seq.node.expressions.length !== 2 || seq.node.expressions[1] !== target.node) return;
        const assign = seq.node.expressions[0];
        if (!t.isAssignmentExpression(assign, { operator: '=' }) || !t.isIdentifier(assign.left, { name: info.payload }) || !t.isArrayExpression(assign.right)) return;
        plans.push({ kind: 'call', key, target: seq, args: assign.right.elements.map((e) => e ?? t.identifier('undefined')) });
      }
      // payload başka yerde kullanılmamalı
      const pb = p.scope.parent.getBinding(info.payload);
      if (!pb) return;
      const allowed = new Set(plans.filter((x) => x.kind === 'call' && x.target.isSequenceExpression()).map((x) => x.target.node.expressions[0].left));
      for (const r of [...pb.referencePaths, ...pb.constantViolations]) {
        const inside = r.findParent((x) => x.node === p.node);
        if (!inside && !allowed.has(r.node) && !(r.isAssignmentExpression() && allowed.has(r.node.left))) return;
      }
      // fonksiyon bildirimleri
      const names = new Map();
      const decls = [];
      for (const [key, fn] of info.fns) {
        const id = p.scope.parent.generateUidIdentifier(t.isValidIdentifier(key) ? key : 'fn');
        names.set(key, id.name);
        const params = fn.params.map((e) => (t.isRestElement(e) ? t.restElement(e.argument) : e));
        decls.push(t.functionDeclaration(id, params, t.blockStatement(fn.body)));
      }
      for (const plan of plans) {
        const id = t.identifier(names.get(plan.key));
        plan.target.replaceWith(plan.kind === 'ref' ? id : t.callExpression(id, plan.args));
      }
      p.replaceWithMultiple(decls);
      n += plans.length;
    },
  });
  if (n) onLog(`dispatcher: ${n} çağrı açıldı`, 'info');
  bump('dispatcher', n);
}
