import * as t from '@babel/types';
import { traverse, gen } from '../util/ast.js';

// VM / state machine dedektörü: döngü içinde, case gövdelerinde durumu değişen switch.
// Programı sandbox'ta işaretli discriminant ile bir kez çalıştırır ve gözlenen durum geçişlerini
// döngünün üstüne yorum olarak yazar. Kodu değiştirmez: tek çalıştırmadan çıkarılan akış
// diğer girdiler için yanlış olabilir.

const MARK = ' PEEL VM';
const MAX_EVENTS = 20000;
const MAX_LINES = 150;

function switchOf(loopNode) {
  let body = loopNode.body;
  const wrapper = (n) => t.isWithStatement(n) || t.isLabeledStatement(n) || t.isBlockStatement(n);
  for (;;) {
    if (t.isWithStatement(body) || t.isLabeledStatement(body)) body = body.body;
    else if (t.isBlockStatement(body) && body.body.length === 1 && wrapper(body.body[0])) body = body.body[0];
    else break;
  }
  if (t.isSwitchStatement(body)) return { sw: body, siblings: null };
  if (!t.isBlockStatement(body)) return null;
  const idx = body.body.findIndex((s) => t.isSwitchStatement(s));
  if (idx < 0) return null;
  // with gövdesi blok ise switch onun içinde olabilir
  return { sw: body.body[idx], siblings: body.body, idx };
}

function stateNames(found) {
  const d = found.sw.discriminant;
  const names = new Set();
  const collect = (n) => {
    if (t.isIdentifier(n)) names.add(n.name);
    else if (t.isMemberExpression(n)) { collect(n.object); if (n.computed) collect(n.property); }
    else if (t.isBinaryExpression(n)) { collect(n.left); collect(n.right); }
    else if (t.isUpdateExpression(n)) collect(n.argument);
  };
  collect(d);
  // state-var çıktısı: __peelS = P + Q; switch (__peelS)
  const prev = found.siblings?.[found.idx - 1];
  if (t.isIdentifier(d) && t.isExpressionStatement(prev) && t.isAssignmentExpression(prev.expression) &&
      t.isIdentifier(prev.expression.left, { name: d.name })) collect(prev.expression.right);
  return names;
}

function mutatedInCases(sw, names) {
  let hit = false;
  const visit = (node) => {
    if (!node || typeof node !== 'object' || hit) return;
    if (t.isAssignmentExpression(node)) {
      const l = node.left;
      if ((t.isIdentifier(l) && names.has(l.name)) ||
          (t.isMemberExpression(l) && t.isIdentifier(l.object) && names.has(l.object.name))) { hit = true; return; }
    }
    if (t.isUpdateExpression(node) && t.isIdentifier(node.argument) && names.has(node.argument.name)) { hit = true; return; }
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
      const v = node[key];
      if (Array.isArray(v)) v.forEach(visit); else visit(v);
    }
  };
  sw.cases.forEach((c) => c.consequent.forEach(visit));
  return hit;
}

function transitions(events, id) {
  const edges = new Map();
  let prev;
  for (const [vmId, value] of events) {
    if (vmId !== id) continue;
    if (prev !== undefined) {
      const k = JSON.stringify(prev);
      if (!edges.has(k)) edges.set(k, new Set());
      edges.get(k).add(JSON.stringify(value));
    }
    prev = value;
  }
  return edges;
}

export async function run(ast, { onLog, bump, sandbox }) {
  const vms = [];
  traverse(ast, {
    Loop(p) {
      if ((p.node.leadingComments ?? []).some((c) => c.value.startsWith(MARK))) return;
      const found = switchOf(p.node);
      if (!found || found.sw.cases.length < 3) return;
      const names = stateNames(found);
      if (!names.size || !mutatedInCases(found.sw, names)) return;
      vms.push({ path: p, sw: found.sw });
    },
  });
  if (!vms.length) return;

  // Discriminant'ları geçici olarak işaretleyip programı çalıştır, sonra geri al
  const originals = vms.map((v) => v.sw.discriminant);
  vms.forEach((v, i) => {
    v.sw.discriminant = t.callExpression(t.identifier('__peelMark'), [t.numericLiteral(i), v.sw.discriminant]);
  });
  const instrumented = gen(ast);
  vms.forEach((v, i) => { v.sw.discriminant = originals[i]; });

  const prelude = `var __peelN = 0; function __peelMark(id, v) { if (__peelN++ < ${MAX_EVENTS} && (typeof v === "number" || typeof v === "string")) __res.push([id, v]); return v; }`;
  const r = await sandbox.run(`${prelude}\ntry {\n${instrumented}\n} catch (e) {}`, { timeoutMs: 6000 });
  const events = r.res ?? [];

  vms.forEach((v, i) => {
    const edges = transitions(events, i);
    const lines = [`${MARK} | ${v.sw.cases.length} durum | switch (${gen(v.sw.discriminant)})`];
    if (edges.size) {
      lines.push('  gözlenen geçişler (tek çalıştırma):');
      for (const [from, to] of [...edges].slice(0, MAX_LINES)) lines.push(`  ${from} -> ${[...to].join(' | ')}`);
      if (edges.size > MAX_LINES) lines.push(`  ... ${edges.size - MAX_LINES} geçiş daha`);
    } else {
      lines.push('  çalıştırmada bu makineye girilmedi');
    }
    t.addComment(v.path.node, 'leading', `${lines.join('\n')}\n`, false);
    onLog(`vm: ${v.sw.cases.length} durumlu makine işaretlendi (${edges.size} geçiş)`, 'info');
  });
  bump('vm', vms.length);
}
