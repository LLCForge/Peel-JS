import * as t from '@babel/types';
import { traverse } from '../util/ast.js';

// js-confuser variableMasking: parametreler ve yerel değişkenler tek bir rest dizisinin elemanlarına taşınır:
//   function sum(...M) { M.a = 0; for (M[2] = 0; M[2] < M[0].length; M[2]++) M.a += M[0][M[2]]; return M.a; }
// Geri dönüş: sayısal indeksler parametre, adlı anahtarlar yerel değişken olur.
// Kesinlik: gövde başındaki "M.length = N" fazla argümanları siler; o zaman N ve üstü indeksler yerel değişkendir.
// Bu deyim yoksa en büyük indekse kadar her indeks parametre kalır (fazla argüman gelirse aynı değeri alsın).
// Atlanır: M başka biçimde kullanılıyorsa (M.length okuması, M'nin aktarılması, dinamik anahtar), gövde
// arguments kullanıyorsa (rest → parametre dönüşümü arguments eşlemesini değiştirir).

const MAX_INDEX = 64;

function keyOf(member) {
  if (!member.computed && t.isIdentifier(member.property)) return member.property.name;
  if (member.computed && t.isNumericLiteral(member.property) && Number.isInteger(member.property.value)) return member.property.value;
  if (member.computed && t.isStringLiteral(member.property)) {
    const v = member.property.value;
    return /^(0|[1-9]\d*)$/.test(v) ? Number(v) : v;
  }
  return null;
}

function usesArguments(fnPath) {
  let hit = false;
  fnPath.traverse({
    Identifier(p) {
      if (p.node.name === 'arguments' && p.isReferencedIdentifier() && !p.scope.getBinding('arguments')) {
        const owner = p.getFunctionParent();
        if (owner === fnPath || (owner?.isArrowFunctionExpression() && owner.findParent((x) => x === fnPath))) { hit = true; p.stop(); }
      }
    },
  });
  return hit;
}

export async function run(ast, { onLog, bump }) {
  let n = 0;
  traverse(ast, {
    Function(fn) {
      const { params } = fn.node;
      if (params.length !== 1 || !t.isRestElement(params[0]) || !t.isIdentifier(params[0].argument)) return;
      if (fn.isArrowFunctionExpression() || !t.isBlockStatement(fn.node.body)) return;
      const mask = params[0].argument.name;
      const b = fn.scope.getBinding(mask);
      if (!b || b.constantViolations.length || !b.referencePaths.length) return;

      const body = fn.get('body.body');
      // gövde başındaki M.length = N
      let limit = null;
      let lengthStmt = null;
      const first = body[0]?.node;
      if (t.isExpressionStatement(first) && t.isAssignmentExpression(first.expression, { operator: '=' }) &&
          t.isMemberExpression(first.expression.left) && t.isIdentifier(first.expression.left.object, { name: mask }) &&
          keyOf(first.expression.left) === 'length' && t.isNumericLiteral(first.expression.right) &&
          Number.isInteger(first.expression.right.value)) {
        limit = first.expression.right.value;
        lengthStmt = body[0];
      }

      const refs = [];
      for (const r of b.referencePaths) {
        if (lengthStmt && r.findParent((x) => x === lengthStmt)) continue;
        const m = r.parentPath;
        if (!m.isMemberExpression({ object: r.node })) return;
        const key = keyOf(m.node);
        if (key === null || key === 'length' || (typeof key === 'number' && key > MAX_INDEX)) return;
        if (typeof key === 'string' && (!t.isValidIdentifier(key) || ['arguments', 'eval'].includes(key))) return;
        // dizi/nesne prototipinden gelen ad (M.map) ilk okumada undefined değildir
        if (typeof key === 'string' && key in []) return;
        if (m.parentPath.isUnaryExpression({ operator: 'delete' })) return;
        // M.x() çağrısı this olarak M'yi verir: değişkene dönünce this değişir
        if (m.parentPath.isCallExpression({ callee: m.node }) || m.parentPath.isOptionalCallExpression({ callee: m.node })) return;
        refs.push({ m, key });
      }
      if (usesArguments(fn)) return;

      const numeric = refs.filter((r) => typeof r.key === 'number').map((r) => r.key);
      const maxIdx = numeric.length ? Math.max(...numeric) : -1;
      const paramCount = limit === null ? maxIdx + 1 : Math.min(limit, maxIdx + 1);

      // ad üretimi: işlev içinde ve dış kapsamlarda kullanılmayan adlar
      const taken = new Set();
      fn.traverse({ Identifier(p) { if (p.isReferencedIdentifier() || p.isBindingIdentifier()) taken.add(p.node.name); } });
      const fresh = (base) => {
        let name = base;
        for (let i = 2; taken.has(name) || fn.scope.hasBinding(name); i++) name = `${base}_${i}`;
        taken.add(name);
        return name;
      };
      const names = new Map();
      const nameOf = (key) => {
        if (!names.has(key)) names.set(key, fresh(typeof key === 'number' ? `arg${key}` : key));
        return names.get(key);
      };
      for (let i = 0; i < paramCount; i++) nameOf(i);
      for (const { key } of refs) nameOf(key);

      const locals = [...names.entries()].filter(([k]) => !(typeof k === 'number' && k < paramCount)).map(([, v]) => v);
      for (const { m, key } of refs) m.replaceWith(t.identifier(names.get(key)));
      fn.node.params = Array.from({ length: paramCount }, (_, i) => t.identifier(names.get(i)));
      if (lengthStmt) lengthStmt.remove();
      if (locals.length) fn.get('body').unshiftContainer('body', t.variableDeclaration('var', locals.map((x) => t.variableDeclarator(t.identifier(x)))));
      n++;
    },
  });
  if (n) onLog(`var-mask: ${n} fonksiyonda rest dizisi parametre/değişkenlere açıldı`, 'info');
  bump('varMask', n);
}
