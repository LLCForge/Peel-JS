import * as t from '@babel/types';
import { traverse, gen } from '../util/ast.js';

// js-confuser kilitleri, kodun yalnızca biçimi değişince tetiklenenler:
//  - lock.selfDefending: (function () { var f = function () { if (new RegExp("\n").test(f)) while (true) {} }; return f(); })();
//    Sıkıştırılmış özgün kodda fonksiyon metninde satır sonu yoktur, test hiç tutmaz. Çözülmüş (biçimlenmiş)
//    kodda sonsuz döngüye girer. Deyim kaldırılır: özgün çalışmayla aynı (etkisiz) sonuç.
//  - lock.integrity: function f() { var h = f.x || (f.x = HASH(g, 123)); if (h === 456) { … } else { karşı önlem } }
//    HASH, g'nin toString() metninin özetidir; özgün kodda eşitlik her zaman tutar. Kod çözüldükçe metin
//    değişeceğinden test yerine özgün dal yazılır.
// Ortama bağlı kilitler (domainLock, startDate/endDate, tamperProtection) gerçek davranıştır; dokunulmaz.

const MAX_GUARD_SRC = 1500;

const isInfiniteEmptyLoop = (n) => (t.isWhileStatement(n) && t.isBooleanLiteral(n.test, { value: true }) ||
  t.isForStatement(n) && !n.test) && (t.isEmptyStatement(n.body) || (t.isBlockStatement(n.body) && !n.body.body.length));

function isSelfDefendingIife(stmt) {
  if (!t.isExpressionStatement(stmt)) return false;
  let e = stmt.expression;
  if (t.isUnaryExpression(e)) e = e.argument;
  if (!t.isCallExpression(e) || e.arguments.length || !t.isFunctionExpression(e.callee)) return false;
  const body = e.callee.body.body;
  if (body.length !== 2 || !t.isVariableDeclaration(body[0]) || !t.isReturnStatement(body[1])) return false;
  const [decl] = body[0].declarations;
  if (body[0].declarations.length !== 1 || !t.isIdentifier(decl.id) || !t.isFunctionExpression(decl.init)) return false;
  const ret = body[1].argument;
  if (!t.isCallExpression(ret) || !t.isIdentifier(ret.callee, { name: decl.id.name }) || ret.arguments.length) return false;
  const src = gen(e.callee);
  if (src.length > MAX_GUARD_SRC) return false;
  let newline = false;
  let loop = false;
  t.traverseFast(decl.init, (n) => {
    if (t.isStringLiteral(n, { value: '\n' }) || (t.isRegExpLiteral(n) && n.pattern === '\\n')) newline = true;
    if (isInfiniteEmptyLoop(n)) loop = true;
  });
  return newline && loop && /test/.test(src);
}

// var h = F.x || (F.x = H(g, seed));  → { name: h, hashFn: H }
function integrityHash(decl, selfName) {
  if (!t.isVariableDeclaration(decl) || decl.declarations.length !== 1) return null;
  const { id, init } = decl.declarations[0];
  if (!t.isIdentifier(id) || !t.isLogicalExpression(init, { operator: '||' })) return null;
  const cache = (m) => t.isMemberExpression(m) && t.isIdentifier(m.object, { name: selfName });
  if (!cache(init.left) || !t.isAssignmentExpression(init.right, { operator: '=' }) || !cache(init.right.left)) return null;
  const call = init.right.right;
  if (!t.isCallExpression(call) || !t.isIdentifier(call.callee) || call.arguments.length !== 2 ||
      !t.isIdentifier(call.arguments[0]) || !t.isNumericLiteral(call.arguments[1])) return null;
  return { name: id.name, hashFn: call.callee.name };
}

// Özet fonksiyonu: fonksiyonun toString() metnini okuyup bir sayıya indirger
function isHashFunction(binding) {
  if (!binding || !t.isFunctionDeclaration(binding.path.node)) return false;
  const src = gen(binding.path.node);
  return src.length < 2000 && /toString/.test(src) && /replace/.test(src);
}

// integrity özgün fonksiyonu G'ye taşıyıp kabuğu function F() { return G(...arguments); } bırakır.
// G yalnızca buradan çağrılıyor, aynı kapsamda ve this/arguments/new.target/super kullanmıyorsa F'nin
// parametreleri ve gövdesi G'ninki olur. (F.length 0'dı, G'nin parametre sayısı olur.)
function collapseForwarder(fPath) {
  const { node } = fPath;
  if (node.params.length || node.body.body.length !== 1) return;
  const ret = node.body.body[0];
  const call = ret.argument;
  if (!t.isReturnStatement(ret) || !t.isCallExpression(call) || !t.isIdentifier(call.callee) || call.arguments.length !== 1 ||
      !t.isSpreadElement(call.arguments[0]) || !t.isIdentifier(call.arguments[0].argument, { name: 'arguments' })) return;
  // gövde az önce değişti: özet çağrısındaki G referansı bağlardan düşsün
  fPath.scope.getProgramParent().crawl();
  const gb = fPath.scope.getBinding(call.callee.name);
  if (!gb?.constant || !gb.path.isFunctionDeclaration() || gb.referencePaths.length !== 1) return;
  const g = gb.path;
  if (g.node.async !== node.async || g.node.generator !== node.generator || g.scope.parent !== fPath.scope.parent) return;
  let bad = false;
  g.traverse({
    ThisExpression(q) { if (q.findParent((x) => x.isFunction() && !x.isArrowFunctionExpression()) === g) bad = true; },
    Super() { bad = true; },
    MetaProperty() { bad = true; },
    Identifier(q) {
      if (q.isReferencedIdentifier()) {
        if (q.node.name === 'arguments' && q.findParent((x) => x.isFunction() && !x.isArrowFunctionExpression()) === g) bad = true;
        if (q.node.name === g.node.id.name && q.scope.getBinding(q.node.name) === gb) bad = true;
      }
    },
  });
  if (bad) return;
  node.params = g.node.params;
  node.body = g.node.body;
  g.remove();
}

export async function run(ast, { onLog, bump }) {
  let guards = 0;
  let integrity = 0;
  traverse(ast, {
    ExpressionStatement(p) {
      if (!isSelfDefendingIife(p.node)) return;
      if (Array.isArray(p.container)) p.remove(); else p.replaceWith(t.emptyStatement());
      guards++;
    },
    FunctionDeclaration(p) {
      const name = p.node.id?.name;
      const body = p.get('body.body');
      if (!name || body.length !== 2) return;
      const h = integrityHash(body[0].node, name);
      const test = body[1];
      if (!h || !test.isIfStatement() || !test.node.alternate) return;
      const { left, right, operator } = test.node.test;
      if (operator !== '===' && operator !== '==') return;
      const hashSide = t.isIdentifier(left, { name: h.name }) ? right : t.isIdentifier(right, { name: h.name }) ? left : null;
      if (!t.isNumericLiteral(hashSide)) return;
      if (!isHashFunction(p.scope.getBinding(h.hashFn))) return;
      const hb = p.scope.getBinding(h.name);
      if (!hb || hb.constantViolations.length || hb.referencePaths.length !== 1) return;
      const keep = test.node.consequent;
      p.node.body.body = t.isBlockStatement(keep) ? keep.body : [keep];
      integrity++;
      collapseForwarder(p);
    },
  });
  if (guards) onLog(`locks: ${guards} js-confuser selfDefending denetimi kaldırıldı`, 'info');
  if (integrity) onLog(`locks: ${integrity} fonksiyonda integrity (toString özeti) denetimi açıldı`, 'info');
  bump('locks', guards + integrity);
}
