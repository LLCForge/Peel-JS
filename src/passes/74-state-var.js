import * as t from '@babel/types';
import { traverse } from '../util/ast.js';

// switch (P + Q + R) → __peelS = P + Q + R; switch (__peelS)
// Atama switch'ten hemen önce yapıldığı için toplam, orijinaldeki ile aynı anda ve aynı kapsamda
// (with dahil) hesaplanır: semantik birebir korunur. Amaç VM pass'ine tek bir durum değişkeni vermek.

function sumNames(node, out = []) {
  if (t.isIdentifier(node)) { out.push(node.name); return out; }
  if (t.isNumericLiteral(node)) return out;
  if (t.isBinaryExpression(node, { operator: '+' })) {
    return sumNames(node.left, out) && sumNames(node.right, out);
  }
  return null;
}

function mutatesAny(switchPath, names) {
  let hit = false;
  switchPath.traverse({
    AssignmentExpression(p) {
      if (t.isIdentifier(p.node.left) && names.includes(p.node.left.name)) { hit = true; p.stop(); }
    },
    UpdateExpression(p) {
      if (t.isIdentifier(p.node.argument) && names.includes(p.node.argument.name)) { hit = true; p.stop(); }
    },
  });
  return hit;
}

export async function run(ast, { onLog, bump }) {
  let n = 0;
  let seq = 0;
  traverse(ast, {
    SwitchStatement(p) {
      const d = p.node.discriminant;
      if (!t.isBinaryExpression(d, { operator: '+' })) return;
      const names = sumNames(d);
      if (!names || new Set(names).size < 2) return;
      if (!p.findParent((x) => x.isLoop())) return;
      if (!mutatesAny(p, names)) return;

      let name;
      do { name = `__peelS${seq++ || ''}`; } while (p.scope.hasBinding(name) || p.scope.hasGlobal(name));
      (p.scope.getFunctionParent() ?? p.scope.getProgramParent()).push({ id: t.identifier(name) });

      const assign = t.expressionStatement(t.assignmentExpression('=', t.identifier(name), d));
      p.node.discriminant = t.identifier(name);

      let target = p;
      while (target.parentPath.isLabeledStatement()) target = target.parentPath;
      if (Array.isArray(target.container)) target.insertBefore(assign);
      else target.replaceWith(t.blockStatement([assign, target.node]));
      n++;
    },
  });
  if (n) onLog(`state-var: ${n} durum ifadesi tek değişkene alındı`, 'info');
  bump('stateVar', n);
}
