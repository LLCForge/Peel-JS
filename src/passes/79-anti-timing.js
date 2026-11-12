import * as t from '@babel/types';
import { traverse, gen } from '../util/ast.js';

// Zamanlama tabanlı anti-debug nötralizasyonu (madde 44).
//
//   var t0 = Date.now(); … if (Date.now() - t0 > 100) { debugger; while (true) {} }
//
// Ölçüm, kod adım adım izlenirken (debugger açıkken) uzar; normal çalıştırmada koşul yanlıştır. Gövdesi yalnızca
// anti-debug eylemlerinden (debugger, sonsuz döngü, throw, sayfa yenileme/yönlendirme/kapatma) oluşan böyle bir
// kontrol kaldırılır; else dalı varsa yerine o konur (normal yol). Deep doğrulama çıktının aynı kaldığını denetler.

const CLOCK = (n) =>
  (t.isCallExpression(n) && t.isMemberExpression(n.callee) && !n.callee.computed &&
    ((t.isIdentifier(n.callee.object, { name: 'Date' }) && t.isIdentifier(n.callee.property, { name: 'now' })) ||
     (t.isIdentifier(n.callee.object, { name: 'performance' }) && t.isIdentifier(n.callee.property, { name: 'now' })) ||
     (t.isNewExpression(n.callee.object) && t.isIdentifier(n.callee.object.callee, { name: 'Date' }) && t.isIdentifier(n.callee.property, { name: 'getTime' })))) ||
  (t.isNewExpression(n) && t.isIdentifier(n.callee, { name: 'Date' }) && !n.arguments.length) ||
  (t.isUnaryExpression(n, { operator: '+' }) && t.isNewExpression(n.argument) && t.isIdentifier(n.argument.callee, { name: 'Date' }));

// a - b: ikisi de saat okuması ya da saat okumasıyla başlatılmış değişken
function isElapsed(n, clockVars) {
  if (!t.isBinaryExpression(n, { operator: '-' })) return false;
  const side = (x) => CLOCK(x) || (t.isIdentifier(x) && clockVars.has(x.name));
  return side(n.left) && side(n.right);
}

function timingTest(test, clockVars) {
  if (!t.isBinaryExpression(test) || !['>', '>=', '<', '<='].includes(test.operator)) return false;
  const big = ['>', '>='].includes(test.operator);
  const [elapsed, limit] = big ? [test.left, test.right] : [test.right, test.left];
  return isElapsed(elapsed, clockVars) && t.isNumericLiteral(limit);
}

// Gövde yalnızca anti-debug eylemleri mi?
function onlyAntiDebug(node) {
  const list = t.isBlockStatement(node) ? node.body : [node];
  if (!list.length) return false;
  return list.every((s) => {
    if (t.isDebuggerStatement(s) || t.isThrowStatement(s)) return true;
    if ((t.isWhileStatement(s) || t.isForStatement(s)) && (!s.test || t.isBooleanLiteral(s.test, { value: true }) ||
        (t.isUnaryExpression(s.test, { operator: '!' }) && t.isArrayExpression(s.test.argument)))) return true;
    if (t.isExpressionStatement(s)) {
      const src = gen(s.expression);
      return /^(window\.)?location\.(reload|replace|assign)\(|^(window\.)?location(\.href)?\s*=|^window\.close\(\)|^document\.(body\.)?innerHTML\s*=|^document\.write\(/.test(src);
    }
    return false;
  });
}

export async function run(ast, { onLog, bump, findings }) {
  const clockVars = new Set();
  traverse(ast, {
    VariableDeclarator(p) {
      if (t.isIdentifier(p.node.id) && p.node.init && CLOCK(p.node.init)) clockVars.add(p.node.id.name);
    },
    AssignmentExpression(p) {
      if (t.isIdentifier(p.node.left) && CLOCK(p.node.right)) clockVars.add(p.node.left.name);
    },
  });
  let n = 0;
  traverse(ast, {
    IfStatement(p) {
      if (!timingTest(p.node.test, clockVars) || !onlyAntiDebug(p.node.consequent)) return;
      const test = gen(p.node.test);
      const alt = p.node.alternate;
      if (findings) (findings.timing ??= []).push({ test, action: gen(p.node.consequent).slice(0, 200), line: p.node.loc?.start.line ?? null, kept: alt ? 'else dalı' : null });
      if (alt) p.replaceWith(t.isBlockStatement(alt) ? alt : t.blockStatement([alt]));
      else p.remove();
      n++;
    },
  });
  if (n) onLog(`anti-timing: ${n} zamanlama tabanlı anti-debug kontrolü kaldırıldı`, 'info');
  bump('antiTiming', n);
}
