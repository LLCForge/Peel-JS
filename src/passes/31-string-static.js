import * as t from '@babel/types';
import { analyzeStringTables } from '../core/vm/strtable.js';

// Sandbox yokken string tablosu çözümü (E632): rotasyon checksum'ı yerel olarak hesaplanır, decoder
// (indeks / base64 / rc4) taklit edilir ve literal argümanlı çağrılar değerleriyle değiştirilir.
// Sandbox varken string-array / runtime-decoders pass'leri aynı işi çalışma anında yapar; bu pass atlanır.

function countRefs(root, name, skip) {
  let n = 0;
  const visit = (node) => {
    if (!node || typeof node !== 'object' || node === skip) return;
    if (t.isIdentifier(node, { name })) n++;
    for (const k of t.VISITOR_KEYS[node.type] ?? []) {
      const v = node[k];
      if (Array.isArray(v)) v.forEach(visit); else visit(v);
    }
  };
  visit(root);
  return n;
}

export async function run(ast, { onLog, bump, sandbox }) {
  if (sandbox) return;
  const report = analyzeStringTables(ast);
  let total = 0;
  for (const r of report) {
    if (r.rotation.rotation === null) continue;
    let n = 0;
    for (const c of r.calls_) {
      const v = r.values.get(JSON.stringify(c.args));
      if (c.inRotator || !v || typeof v.value !== 'string' || !c.path.node) continue;
      c.path.replaceWith(t.stringLiteral(v.value));
      n++;
    }
    if (!n) continue;
    total += n;
    onLog(`string-static: ${r.table} tablosundan ${n} çağrı statik olarak çözüldü (rotasyon ${r.rotation.rotation})`, 'info');
    // artık çağrılmayan decoder'lar (rotasyon deyimindeki checksum çağrıları sayılmaz), rotasyon deyimi ve tablo
    const body = ast.program.body;
    const decNames = r.decoder.split(', ');
    const isRot = (s) => t.isExpressionStatement(s) && countRefs(s, r.table) > 0 && /push/.test(JSON.stringify(s)) && /shift/.test(JSON.stringify(s));
    const rot = body.find(isRot) ?? null;
    const live = decNames.filter((name) => {
      const fn = body.find((s) => t.isFunctionDeclaration(s) && s.id?.name === name);
      const outside = countRefs(ast.program, name, fn) - (rot ? countRefs(rot, name) : 0);
      return outside > 0;
    });
    if (live.length) continue;
    for (const name of decNames) {
      const fn = body.find((s) => t.isFunctionDeclaration(s) && s.id?.name === name);
      if (fn) body.splice(body.indexOf(fn), 1);
    }
    if (rot) body.splice(body.indexOf(rot), 1);
    const tableStmt = body.find((s) => (t.isFunctionDeclaration(s) && s.id?.name === r.table) ||
      (t.isVariableDeclaration(s) && s.declarations.some((d) => t.isIdentifier(d.id, { name: r.table }))));
    if (tableStmt && countRefs(ast.program, r.table, tableStmt) === 0) body.splice(body.indexOf(tableStmt), 1);
  }
  bump('stringStatic', total);
}
