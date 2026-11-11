import * as t from '@babel/types';
import { traverse } from '../util/ast.js';
import { isLiteralTree } from '../util/pure.js';

function hasDynamicScope(ast) {
  let found = false;
  traverse(ast, {
    WithStatement(p) { found = true; p.stop(); },
    CallExpression(p) {
      if (t.isIdentifier(p.node.callee, { name: 'eval' }) && !p.scope.getBinding('eval')) { found = true; p.stop(); }
    },
  });
  return found;
}

// Kaldırılınca gözlenebilir hiçbir şey değişmeyen başlangıç değeri
function isInertInit(path) {
  const n = path.node;
  if (isLiteralTree(n) || t.isFunction(n) || t.isClassExpression(n) && !n.superClass) return true;
  if (t.isIdentifier(n)) return Boolean(path.scope.getBinding(n.name)) || n.name === 'undefined';
  return false;
}

const isExported = (p) => p.findParent((x) => x.isExportDeclaration());

// Program kapsamındaki bildirimler global'dir: başka script'ler kullanıyor olabilir, bu yüzden sadece maksimum profilde
export async function run(ast, { onLog, bump, level }) {
  if (hasDynamicScope(ast)) {
    onLog('unused: eval/with mevcut, atlandı', 'warn');
    return;
  }
  const allowGlobal = level >= 4;
  let n = 0;

  traverse(ast, {
    FunctionDeclaration(p) {
      const scope = p.parentPath.scope;
      if (!p.node.id || isExported(p) || (scope.path.isProgram() && !allowGlobal)) return;
      const b = scope.getBinding(p.node.id.name);
      if (!b || b.constantViolations.length) return;
      if (b.referencePaths.some((r) => !r.findParent((x) => x === p))) return;
      p.remove();
      n++;
    },
    VariableDeclarator(p) {
      if (!t.isIdentifier(p.node.id) || isExported(p)) return;
      const decl = p.parentPath;
      if (decl.parentPath.isForStatement() || decl.parentPath.isForXStatement()) return;
      const b = p.scope.getBinding(p.node.id.name);
      if (!b || b.referenced || b.constantViolations.length) return;
      if (b.scope.path.isProgram() && !allowGlobal) return;
      if (b.path !== p) return;

      if (!p.node.init || isInertInit(p.get('init'))) {
        p.remove();
        n++;
      } else if (decl.node.declarations.length === 1 && Array.isArray(decl.container)) {
        decl.replaceWith(t.expressionStatement(p.node.init));
        n++;
      }
    },
  });
  if (n) onLog(`unused: ${n} kullanılmayan bildirim kaldırıldı`, 'info');
  bump('unused', n);
}
