import * as t from '@babel/types';
import { traverse, gen } from '../util/ast.js';

// A-11 / E206: bütünlük (hash) kontrollerini etkisizleştirme.
//   function add() { var h = add.p || (add.p = hash(impl, 2432744)); if (h === 803393648862986) { return impl(...arguments); } else { while (true) {} } }
// Hash fonksiyonu korunan fonksiyonun kaynağını (toString) özetler; çözme sırasında kaynak değişince kontrol
// tutmaz ve program kilitlenir. Testin orijinal programdaki sonucu değerlendirme bağlamında (orijinal kaynakla)
// hesaplanır; if, o sonuçta seçilen dalla değiştirilir. Böylece davranış orijinalle birebir aynı kalır ve
// sonraki pass'ler korunan fonksiyonu güvenle değiştirebilir. Bu pass ilk AST pass'i olmalı.

// Gövdesinde parametresinin toString'ini çağıran (kaynağı okuyan) fonksiyon adları
function sourceHashers(ast) {
  const names = new Set();
  traverse(ast, {
    Function(p) {
      const id = p.node.id ?? (p.parentPath.isVariableDeclarator() && t.isIdentifier(p.parent.id) ? p.parent.id : null);
      if (!id) return;
      const params = new Set(p.node.params.map((x) => (t.isAssignmentPattern(x) ? x.left : x)).filter((x) => t.isIdentifier(x)).map((x) => x.name));
      let reads = false;
      p.traverse({
        MemberExpression(q) {
          const prop = q.node.computed ? (t.isStringLiteral(q.node.property) ? q.node.property.value : null) : q.node.property.name;
          if (prop === 'toString' && t.isIdentifier(q.node.object) && params.has(q.node.object.name)) { reads = true; q.stop(); }
        },
      });
      if (reads) names.add(id.name);
    },
  });
  return names;
}

// İfade içinde bir hash çağrısı: hash(fn, ...) — ilk argüman bir fonksiyon adı
function hashCall(node, hashers) {
  let found = null;
  t.traverseFast(node, (n) => {
    if (!found && t.isCallExpression(n) && t.isIdentifier(n.callee) && hashers.has(n.callee.name) &&
        n.arguments.length >= 1 && t.isIdentifier(n.arguments[0]) && n.arguments.every((a) => t.isIdentifier(a) || t.isLiteral(a))) found = n;
  });
  return found;
}

const isConst = (n) => t.isNumericLiteral(n) || t.isStringLiteral(n);

export function findIntegrityChecks(ast) {
  const hashers = sourceHashers(ast);
  if (!hashers.size) return [];
  const checks = [];
  traverse(ast, {
    IfStatement(p) {
      const test = p.node.test;
      if (!t.isBinaryExpression(test) || !['===', '!==', '==', '!='].includes(test.operator)) return;
      const [side, other] = isConst(test.right) ? [test.left, test.right] : [test.right, test.left];
      if (!isConst(other)) return;
      let call = null;
      let holder = null;
      if (t.isCallExpression(side)) call = hashCall(side, hashers);
      else if (t.isIdentifier(side)) {
        const b = p.scope.getBinding(side.name);
        if (b?.constant && b.path.isVariableDeclarator() && b.path.node.init && b.references === 1) {
          call = hashCall(b.path.node.init, hashers);
          holder = b.path;
        }
      }
      if (!call) return;
      const fn = p.getFunctionParent();
      checks.push({
        path: p, call, holder, operator: test.operator, expected: other.value,
        protects: call.arguments[0].name, inFunction: fn?.node.id?.name ?? null, hasher: call.callee.name,
      });
    },
  });
  return checks;
}

export async function run(ast, { onLog, bump, sandbox, ctx }) {
  if (!ctx) return;
  const checks = findIntegrityChecks(ast);
  if (!checks.length) return;
  const r = await sandbox.batchIn(ctx, checks.map((c) => gen(c.call)));
  if (!r.ok) return;
  let n = 0;
  checks.forEach((c, i) => {
    const v = r.results[i];
    if (!v?.ok || v.opaque || (v.type !== 'number' && v.type !== 'string')) return;
    // eslint-disable-next-line eqeqeq
    const eq = c.operator.length === 3 ? v.value === c.expected : v.value == c.expected;
    const pass = c.operator.startsWith('=') ? eq : !eq;
    const branch = pass ? c.path.node.consequent : c.path.node.alternate;
    const stmts = !branch ? [] : t.isBlockStatement(branch) ? branch.body : [branch];
    if (stmts.some((s) => t.isFunctionDeclaration(s) || (t.isVariableDeclaration(s) && s.kind !== 'var') || t.isClassDeclaration(s))) {
      c.path.replaceWith(t.blockStatement(stmts));
    } else if (Array.isArray(c.path.container)) {
      if (stmts.length) c.path.replaceWithMultiple(stmts); else c.path.remove();
    } else {
      c.path.replaceWith(t.blockStatement(stmts));
    }
    if (c.holder?.node) c.holder.remove();
    n++;
    onLog(`integrity: ${c.inFunction ?? 'program'} içindeki ${c.hasher}(${c.protects}) bütünlük kontrolü etkisizleştirildi (orijinalde ${pass ? 'geçiyor' : 'tutmuyor'})`, 'info');
  });
  bump('integrity', n);
  bump('dead.integrity', n);
}
