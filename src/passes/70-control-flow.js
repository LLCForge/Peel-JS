import * as t from '@babel/types';
import { traverse, gen } from '../util/ast.js';

// obfuscator.io control flow flattening:
//   var o = "2|0|1".split("|"), i = 0;
//   while (true) { switch (o[i++]) { case "0": ...; continue; ... } break; }
// Sıra statik olarak bilindiği için trace'e gerek yok; çıktı birebir eşdeğerdir.

const alwaysTrue = (n) =>
  t.isBooleanLiteral(n, { value: true }) || (t.isNumericLiteral(n) && n.value !== 0) || ['!![]', '!0'].includes(gen(n));

function staticOrder(binding) {
  if (!binding?.constant || !binding.path.isVariableDeclarator()) return null;
  const init = binding.path.node.init;
  if (!t.isCallExpression(init) || init.arguments.length !== 1 || !t.isStringLiteral(init.arguments[0])) return null;
  const callee = init.callee;
  if (!t.isMemberExpression(callee) || !t.isStringLiteral(callee.object)) return null;
  if (!(t.isIdentifier(callee.property, { name: 'split' }) && !callee.computed)) return null;
  return callee.object.value.split(init.arguments[0].value);
}

// Case gövdesinde, sondaki dışında dispatcher'ı hedefleyen break/continue var mı?
function hasStrayJump(stmts) {
  let found = false;
  const visit = (node, nested) => {
    if (!node || typeof node !== 'object' || found) return;
    if (t.isFunction(node)) return;
    if ((t.isBreakStatement(node) || t.isContinueStatement(node)) && (node.label || !nested)) { found = true; return; }
    const inner = nested || t.isLoop(node) || t.isSwitchStatement(node);
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
      const v = node[key];
      if (Array.isArray(v)) v.forEach((c) => visit(c, inner));
      else visit(v, inner);
    }
  };
  stmts.forEach((s) => visit(s, false));
  return found;
}

const isLexical = (s) => t.isFunctionDeclaration(s) || t.isClassDeclaration(s) ||
  (t.isVariableDeclaration(s) && s.kind !== 'var');

function flatten(p) {
  if (p.parentPath.isLabeledStatement() || !alwaysTrue(p.node.test)) return false;
  const body = p.node.body;
  if (!t.isBlockStatement(body) || body.body.length !== 2) return false;
  const [sw, brk] = body.body;
  if (!t.isSwitchStatement(sw) || !t.isBreakStatement(brk) || brk.label) return false;

  const d = sw.discriminant;
  if (!t.isMemberExpression(d) || !d.computed || !t.isIdentifier(d.object)) return false;
  if (!t.isUpdateExpression(d.property, { operator: '++', prefix: false }) || !t.isIdentifier(d.property.argument)) return false;

  const orderB = p.scope.getBinding(d.object.name);
  const idxB = p.scope.getBinding(d.property.argument.name);
  const order = staticOrder(orderB);
  if (!order || orderB.referencePaths.length !== 1) return false;
  if (!idxB?.path.isVariableDeclarator() || !t.isNumericLiteral(idxB.path.node.init)) return false;
  if (idxB.constantViolations.length !== 1 || idxB.referencePaths.some((r) => r.parent !== d.property)) return false;

  const cases = new Map();
  for (const c of sw.cases) {
    if (!c.test) return false;
    const lit = t.isStringLiteral(c.test) || t.isNumericLiteral(c.test) ? String(c.test.value) : null;
    if (lit === null) return false;
    const stmts = c.consequent.slice();
    const last = stmts[stmts.length - 1];
    let terminal = false;
    if (t.isContinueStatement(last) && !last.label) stmts.pop();
    else if (t.isReturnStatement(last) || t.isThrowStatement(last)) terminal = true;
    else return false;
    if (hasStrayJump(stmts) || stmts.some((s) => t.isFunctionDeclaration(s))) return false;
    cases.set(lit, { stmts, terminal });
  }

  const out = [];
  for (const key of order.slice(idxB.path.node.init.value)) {
    const c = cases.get(key);
    if (!c) break; // eşleşme yok → switch sonrası break → döngü biter
    out.push(...c.stmts.map((s) => t.cloneNode(s, true)));
    if (c.terminal) break;
  }

  if (out.some(isLexical)) p.replaceWith(t.blockStatement(out));
  else if (!Array.isArray(p.container)) p.replaceWith(t.blockStatement(out));
  else if (out.length) p.replaceWithMultiple(out);
  else p.remove();

  orderB.path.remove();
  idxB.path.remove();
  return true;
}

export async function run(ast, { onLog, bump }) {
  let n = 0;
  traverse(ast, {
    WhileStatement: {
      exit(p) {
        if (flatten(p)) n++;
      },
    },
  });
  if (n) onLog(`control-flow: ${n} dispatcher düzleştirildi`, 'info');
  bump('controlFlow', n);
}
