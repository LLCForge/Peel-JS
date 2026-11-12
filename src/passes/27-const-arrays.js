import * as t from '@babel/types';
import { traverse } from '../util/ast.js';
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

export async function run(ast, { onLog, bump }) {
  let n = 0;
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
