import * as t from '@babel/types';
import { traverse } from '../util/ast.js';

// js-confuser dispatcher: fonksiyonlar tek bir dağıtıcıdaki nesneye taşınır, argümanlar global bir "payload"
// dizisiyle geçer:
//   var P;  function D(name, flag, ret, lengths = {}) { var fns = { "k1": function () { var [a] = P; … } };
//     if (flag === "C") P = [];  if (flag === "R") { …önbellekli sarmalayıcı… } else output = fns[name]();  … }
//   (P = ["PEEL"], D("k1"))   → k1("PEEL")
//   D("k1", "R")              → k1            (fonksiyonun kendisi, aynı nesne her seferinde)
//   D("k1", "C")              → k1()          (payload boşaltılıp çağrılır)
// Her fns girdisi program düzeyinde adlı bir fonksiyona döner. Özgün adlar kaybolmuştur: anahtardan türetilir.
// Atlanır: ret argümanlı (new ile kullanılan) çağrılar, payload'a başka yerden dokunan kod, fns girdileri
// dağıtıcının yerel adlarına (name, fns, flag…) başvuruyorsa ya da this/arguments kullanıyorsa.

function flagsOf(dispatcher, flagParam, payload) {
  let clear = null;
  let ref = null;
  for (const s of dispatcher.body.body) {
    if (!t.isIfStatement(s) || !t.isBinaryExpression(s.test, { operator: '===' }) ||
        !t.isIdentifier(s.test.left, { name: flagParam }) || !t.isStringLiteral(s.test.right)) continue;
    const c = t.isBlockStatement(s.consequent) ? s.consequent.body : [s.consequent];
    if (c.length === 1 && t.isExpressionStatement(c[0]) && t.isAssignmentExpression(c[0].expression, { operator: '=' }) &&
        t.isIdentifier(c[0].expression.left, { name: payload }) && t.isArrayExpression(c[0].expression.right) &&
        !c[0].expression.right.elements.length) clear = s.test.right.value;
    else if (c.some((x) => t.isFunctionDeclaration(x))) ref = s.test.right.value;
  }
  return { clear, ref };
}

// fns girdisi: function () { var [a, b] = P; … }  → { params, body }
function entryParts(fn, payload) {
  if (!t.isFunctionExpression(fn) || fn.params.length || fn.async || fn.generator) return null;
  const [head, ...rest] = fn.body.body;
  if (t.isVariableDeclaration(head) && head.declarations.length === 1 && t.isArrayPattern(head.declarations[0].id) &&
      t.isIdentifier(head.declarations[0].init, { name: payload })) {
    const els = head.declarations[0].id.elements;
    if (els.some((e) => e === null)) return null;
    return { params: els, body: rest };
  }
  return { params: [], body: fn.body.body };
}

const keyOf = (p) => (t.isIdentifier(p.key) && !p.computed ? p.key.name : t.isStringLiteral(p.key) ? p.key.value : null);

export async function run(ast, { onLog, bump }) {
  let program = null;
  traverse(ast, { Program(p) { program = p; p.stop(); } });
  let total = 0;

  for (const dPath of program.get('body')) {
    const d = dPath.node;
    if (!t.isFunctionDeclaration(d) || d.params.length < 3 || !d.params.slice(0, 3).every((x) => t.isIdentifier(x))) continue;
    const [nameParam, flagParam] = d.params.map((x) => x.name);
    const fnsDecl = d.body.body.find((s) => t.isVariableDeclaration(s) && s.declarations.length === 1 &&
      t.isObjectExpression(s.declarations[0].init) && t.isIdentifier(s.declarations[0].id));
    if (!fnsDecl) continue;
    const fnsObj = fnsDecl.declarations[0].init;
    // payload: girdilerin ilk deyimindeki dizi kalıbının kaynağı
    let payload = null;
    for (const p of fnsObj.properties) {
      const h = t.isObjectProperty(p) && t.isFunctionExpression(p.value) ? p.value.body.body[0] : null;
      if (t.isVariableDeclaration(h) && t.isIdentifier(h.declarations[0]?.init)) { payload = h.declarations[0].init.name; break; }
    }
    if (!payload) continue;
    const pb = program.scope.getBinding(payload);
    const db = program.scope.getBinding(d.id.name);
    if (!pb || !db?.constant || !pb.path.isVariableDeclarator()) continue;
    const { clear, ref } = flagsOf(d, flagParam, payload);

    // girdiler
    const entries = new Map();
    let ok = fnsObj.properties.every((p) => {
      const key = keyOf(p);
      const parts = t.isObjectProperty(p) ? entryParts(p.value, payload) : null;
      if (key === null || !parts) return false;
      entries.set(key, { fn: p.value, ...parts });
      return true;
    });
    if (!ok) continue;
    // girdiler dağıtıcının yerellerine, this'e ya da arguments'a bağlı olmamalı; payload'u yalnızca başta okumalı
    const dLocals = new Set(Object.keys(dPath.scope.bindings));
    const fnsPath = dPath.get('body.body').find((s) => s.node === fnsDecl).get('declarations.0.init');
    const entryNodes = new Set([...entries.values()].map((e) => e.fn));
    fnsPath.traverse({
      ThisExpression(p) { if (entryNodes.has(p.findParent((x) => x.isFunction() && !x.isArrowFunctionExpression())?.node)) ok = false; },
      MetaProperty() { ok = false; },
      Identifier(p) {
        if (!p.isReferencedIdentifier()) return;
        const b = p.scope.getBinding(p.node.name);
        if (p.node.name === 'arguments' && !b) ok = false;
        if (b && b.scope === dPath.scope && dLocals.has(p.node.name)) ok = false;
      },
    });
    if (!ok) continue;

    // dönüş sarmalayıcısı: if (ret === "R") return { KEY: output };  (new ile çağrılan fonksiyonlar için)
    const retParam = d.params[2].name;
    let retFlag = null;
    let retKey = null;
    for (const s of d.body.body) {
      if (!t.isIfStatement(s) || !t.isBinaryExpression(s.test, { operator: '===' }) ||
          !t.isIdentifier(s.test.left, { name: retParam }) || !t.isStringLiteral(s.test.right)) continue;
      const c = t.isBlockStatement(s.consequent) ? s.consequent.body : [s.consequent];
      const o = c.length === 1 && t.isReturnStatement(c[0]) ? c[0].argument : null;
      if (t.isObjectExpression(o) && o.properties.length === 1 && t.isObjectProperty(o.properties[0])) {
        retFlag = s.test.right.value;
        retKey = keyOf(o.properties[0]);
      }
    }
    const absent = (a) => !a || t.isIdentifier(a, { name: 'undefined' }) || t.isUnaryExpression(a, { operator: 'void' });

    // çağrı yerleri: [new] D(k, flag?, ret?)[KEY?]
    const sites = [];
    for (const r of db.referencePaths) {
      const call = r.parentPath;
      if (!(call.isCallExpression({ callee: r.node }) || call.isNewExpression({ callee: r.node }))) { ok = false; break; }
      const args = call.node.arguments;
      if (!args.length || args.length > 3 || !t.isStringLiteral(args[0]) || !entries.has(args[0].value)) { ok = false; break; }
      const [, flag, ret] = args;
      const key = args[0].value;
      let site = call;
      if (!absent(ret)) {
        const m = call.parentPath;
        if (!retFlag || !t.isStringLiteral(ret, { value: retFlag }) || !m.isMemberExpression({ object: call.node }) ||
            (m.node.computed ? m.node.property.value : m.node.property.name) !== retKey) { ok = false; break; }
        site = m;
      } else if (call.isNewExpression()) { ok = false; break; }
      if (t.isStringLiteral(flag) && flag.value === ref && ref) {
        sites.push({ kind: 'ref', path: site, key });
      } else if (t.isStringLiteral(flag) && flag.value === clear && clear) {
        sites.push({ kind: 'call', path: site, key, args: [] });
      } else if (absent(flag) || t.isStringLiteral(flag)) {
        const seq = site.parentPath;
        if (!seq.isSequenceExpression() || seq.node.expressions.length !== 2 || seq.node.expressions[1] !== site.node) { ok = false; break; }
        const asg = seq.node.expressions[0];
        if (!t.isAssignmentExpression(asg, { operator: '=' }) || !t.isIdentifier(asg.left, { name: payload }) || !t.isArrayExpression(asg.right) ||
            asg.right.elements.some((e) => e === null)) { ok = false; break; }
        sites.push({ kind: 'call', path: seq, key, args: asg.right.elements });
      } else { ok = false; break; }
    }
    if (!ok || !sites.length) continue;
    // payload başka hiçbir yerde kullanılmamalı (çağrı yerlerindeki atamalar ve girdilerin başı dışında)
    const allowed = new Set(sites.filter((s) => s.path.isSequenceExpression()).map((s) => s.path.node.expressions[0].left));
    for (const e of entries.values()) allowed.add(e.fn.body.body[0]?.declarations?.[0]?.init);
    if (pb.referencePaths.some((r) => !allowed.has(r.node) && !r.findParent((x) => x === dPath)) ||
        pb.constantViolations.some((v) => !allowed.has(v.node.left) && !v.findParent((x) => x === dPath))) continue;

    // yeni adlar
    const used = new Set();
    traverse(ast, { Identifier(p) { used.add(p.node.name); } });
    const names = new Map();
    for (const key of entries.keys()) {
      let base = `fn_${key.replace(/[^\w$]/g, '_')}`;
      let name = base;
      for (let i = 2; used.has(name); i++) name = `${base}_${i}`;
      used.add(name);
      names.set(key, name);
    }
    const decls = [...entries].map(([key, e]) => t.functionDeclaration(t.identifier(names.get(key)), e.params, t.blockStatement(e.body)));
    for (const s of sites) {
      const id = t.identifier(names.get(s.key));
      s.path.replaceWith(s.kind === 'ref' ? id : t.callExpression(id, s.args));
    }
    // yalnızca dağıtıcının kullandığı program değişkenleri (önbellek nesnesi, payload) onunla birlikte gider
    const onlyInD = [];
    for (const b of Object.values(program.scope.bindings)) {
      if (!b.path.isVariableDeclarator() || b.path.parentPath.node.declarations.length !== 1) continue;
      const init = b.path.node.init;
      const inert = !init || (t.isCallExpression(init) && t.isMemberExpression(init.callee) && t.isIdentifier(init.callee.object, { name: 'Object' }) &&
        !program.scope.getBinding('Object') && (init.callee.property.name ?? init.callee.property.value) === 'create' &&
        init.arguments.length === 1 && t.isNullLiteral(init.arguments[0]));
      const inside = (p) => p.findParent((x) => x === dPath) || allowed.has(p.node) || allowed.has(p.node.left);
      if (inert && b.referencePaths.length + b.constantViolations.length > 0 &&
          b.referencePaths.every(inside) && b.constantViolations.every((v) => v === b.path || inside(v))) onlyInD.push(b.path.parentPath);
    }
    dPath.replaceWithMultiple(decls);
    for (const decl of onlyInD) if (decl.node) decl.remove();
    total += sites.length;
    onLog(`dispatcher: ${d.id.name} açıldı (${entries.size} fonksiyon, ${sites.length} çağrı yeri)`, 'info');
  }
  bump('dispatcher', total);
}
