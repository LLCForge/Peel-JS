import * as t from '@babel/types';
import { traverse, gen } from '../util/ast.js';
import { literalValue } from '../util/pure.js';

// js-confuser "duplicateLiteralsRemoval": const L = [0, 1, "length", ...]; ... L[4] ...
// Hiç değiştirilmeyen ve yalnızca sabit indeksle okunan literal dizisinin elemanlarını yerine yazar.
const MIN_LENGTH = 3;

function declaredFirst(declPath, refs) {
  const stmt = declPath.parentPath;
  const owner = stmt.parentPath;
  if (!(owner.isProgram() || (owner.isBlockStatement() && owner.parentPath.isFunction()))) return false;
  return refs.every((r) => r.node.start > stmt.node.end);
}

// L[i] okuması mı? (yazma, silme, çağırma, for-in hedefi değil)
const isRead = (m, obj) => m.isMemberExpression({ object: obj }) && m.node.computed &&
  !m.parentPath.isAssignmentExpression({ left: m.node }) && !m.parentPath.isUpdateExpression() &&
  !m.parentPath.isUnaryExpression({ operator: 'delete' }) && !m.parentPath.isCallExpression({ callee: m.node }) &&
  !m.parentPath.isForXStatement({ left: m.node });

const isFixed = (m, len) => t.isNumericLiteral(m.node.property) && Number.isInteger(m.node.property.value) &&
  m.node.property.value >= 0 && m.node.property.value < len;

function pathOf(n) {
  if (t.isIdentifier(n)) return n.name;
  if (t.isMemberExpression(n) && !n.computed && t.isIdentifier(n.property)) {
    const base = pathOf(n.object);
    return base && `${base}.${n.property.name}`;
  }
  return null;
}

// js-confuser iç fonksiyonları: scope.X.L = [0, 1, …]; … scope.X.L[12] …  (dizi kapsam nesnesinde)
function scopeArrays(ast, onLog) {
  let n = 0;
  const cands = [];
  traverse(ast, {
    AssignmentExpression(p) {
      const { left, right, operator } = p.node;
      if (operator !== '=' || !p.parentPath.isExpressionStatement() || !t.isMemberExpression(left) || left.computed) return;
      if (!t.isArrayExpression(right) || right.elements.length < MIN_LENGTH) return;
      if (!right.elements.every((e) => e !== null && literalValue(e).ok)) return;
      const path = pathOf(left);
      if (!path) return;
      const root = path.split('.')[0];
      const binding = p.scope.getBinding(root);
      if (!binding || binding.constantViolations.length) return;
      // atama fonksiyon gövdesinin doğrudan deyimi olmalı: switch/döngü içinde metin sırası çalışma sırası değildir
      const owner = p.parentPath.parentPath;
      if (!(owner.isProgram() || (owner.isBlockStatement() && owner.parentPath.isFunction()))) return;
      cands.push({ p, path, root, binding, elements: right.elements });
    },
  });
  // alt nesneler başka kapsam nesnelerine kopyalanır ({ X: scope.X }); aynı özellik adı herhangi bir kökten
  // birden çok kez yazılıyorsa (atama, destructuring, ++) hangi dizinin okunduğu belli değildir
  const writes = new Map();
  traverse(ast, {
    MemberExpression(q) {
      if (q.node.computed || !t.isIdentifier(q.node.property)) return;
      const par = q.parentPath;
      const lval = par.isAssignmentExpression({ left: q.node }) || par.isUpdateExpression() || par.isForXStatement({ left: q.node }) ||
        par.isArrayPattern() || par.isRestElement() || par.isAssignmentPattern({ left: q.node }) || par.isObjectProperty({ value: q.node }) && par.parentPath.isObjectPattern() ||
        par.isUnaryExpression({ operator: 'delete' });
      if (!lval) return;
      // birebir aynı literal dizinin kopyaları (klonlanmış fonksiyonlar) tek yazma sayılır
      const sig = par.isAssignmentExpression({ operator: '=' }) && t.isArrayExpression(par.node.right) ? gen(par.node.right) : Symbol();
      const name = q.node.property.name;
      if (!writes.has(name)) writes.set(name, new Set());
      writes.get(name).add(sig);
    },
  });
  for (const c of cands.filter((c) => writes.get(c.path.split('.').pop())?.size === 1)) {
    if (!c.p.node) continue;
    const stmt = c.p.parentPath;
    const fn = c.p.getFunctionParent();
    const prefixes = c.path.split('.').map((_, i, a) => a.slice(0, i + 1).join('.'));
    const reads = [];
    let ok = true;
    traverse(ast, {
      MemberExpression(q) {
        if (!ok || q.node === c.p.node.left) return;
        const qp = pathOf(q.node);
        if (!qp || !prefixes.includes(qp) || q.scope.getBinding(c.root) !== c.binding) return;
        const parent = q.parentPath;
        // dizinin ya da bir üst nesnesinin yeniden atanması modeli bozar
        if (parent.isAssignmentExpression({ left: q.node }) || parent.isUpdateExpression()) { ok = false; return; }
        if (qp !== c.path) return;
        if (!isRead(parent, q.node)) { ok = false; return; }
        // aynı fonksiyondaki okumalar atamadan sonra olmalı; iç fonksiyonlar sonradan çalışır
        if (q.getFunctionParent() === fn && q.node.start < stmt.node.end) { ok = false; return; }
        reads.push(parent);
      },
    });
    if (!ok) continue;
    const fixed = reads.filter((m) => isFixed(m, c.elements.length));
    if (!fixed.length) continue;
    for (const m of fixed) m.replaceWith(t.cloneNode(c.elements[m.node.property.value], true));
    n += fixed.length;
    if (fixed.length === reads.length) stmt.remove();
    onLog(`const-arrays: ${c.path} (${c.elements.length} literal) ${fixed.length}/${reads.length} okuma yerine yazıldı`, 'info');
  }
  return n;
}

export async function run(ast, { onLog, bump }) {
  let n = scopeArrays(ast, onLog);
  traverse(ast, {
    VariableDeclarator(p) {
      const { id, init } = p.node;
      if (!t.isIdentifier(id) || !t.isArrayExpression(init) || init.elements.length < MIN_LENGTH) return;
      const values = init.elements.map((e) => (e === null ? { ok: false } : literalValue(e)));
      if (!values.every((v) => v.ok)) return;
      const b = p.scope.getBinding(id.name);
      if (!b || b.constantViolations.length || !b.referencePaths.length) return;
      // her kullanım L[...] okuması olmalı: yazma, silme, çağırma, push ya da başka fonksiyona verme yok
      const members = b.referencePaths.map((r) => r.parentPath);
      const readOnly = members.every((m, i) => m.isMemberExpression({ object: b.referencePaths[i].node }) && m.node.computed &&
        !m.parentPath.isAssignmentExpression({ left: m.node }) && !m.parentPath.isUpdateExpression() &&
        !m.parentPath.isUnaryExpression({ operator: 'delete' }) && !m.parentPath.isCallExpression({ callee: m.node }) &&
        !m.parentPath.isForXStatement({ left: m.node }));
      if (!readOnly || !declaredFirst(p, b.referencePaths)) return;
      // sabit indeksli okumalar yazılır; dinamik indeks (L[state + 191]) varsa dizi yerinde kalır
      const fixed = members.filter((m) => t.isNumericLiteral(m.node.property) && Number.isInteger(m.node.property.value) &&
        m.node.property.value >= 0 && m.node.property.value < init.elements.length);
      if (!fixed.length) return;
      for (const m of fixed) m.replaceWith(t.cloneNode(init.elements[m.node.property.value], true));
      n += fixed.length;
      if (fixed.length === members.length) p.remove();
      onLog(`const-arrays: ${id.name} (${init.elements.length} literal) ${fixed.length}/${members.length} okuma yerine yazıldı`, 'info');
    },
  });
  bump('constArray', n);
}
