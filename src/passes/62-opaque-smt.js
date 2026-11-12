import * as t from '@babel/types';
import { traverse } from '../util/ast.js';
import { ssaFor } from '../opt/ssa.js';
import { sccp, absint, ALL } from '../opt/lattice.js';
import { isPureTyped, functionPaths, hasDynamicScope } from '../opt/util.js';
import { toIR, varForVersion, decide, proofText } from '../opt/irbridge.js';
import { vars, onlyType } from '../symbolic/ir.js';

// E592: opaque predicate çözümü. Fonksiyon içindeki dal koşulları, SSA sürümleri tip/aralık kafesinden gelen
// sembolik değişkenlere çevrilir; koşulun değilinin tatmin edilemezliği bit-vektör çözücüyle kanıtlanırsa
// (E594: kanıt yöntemi kaydedilir, DRUP kanıtları bağımsız denetlenir) koşul sabitle değiştirilir.

export function findOpaque(fn, { onProof = () => {} } = {}) {
  const fx = ssaFor(fn);
  if (!fx) return [];
  sccp(fx);
  absint(fx);
  const typeOf = (id) => (fx.useVer.has(id) ? (fx.abs.useAbs(id)?.ty || ALL) : null);
  // sürümün tanımı yan etkisiz ve çevrilebilirse tanım terimi kullanılır (z = x*x % 4 ilişkisi korunur)
  const termOf = (ver, depth) => {
    if (ver.kind === 'def' && depth < 4) {
      const site = ver.site;
      const rhs = t.isVariableDeclarator(site) ? site.init : t.isAssignmentExpression(site, { operator: '=' }) ? site.right : null;
      if (rhs && isPureTyped(rhs, typeOf, fn.scope)) {
        const ir = toIR(rhs, (id) => (fx.useVer.has(id) ? termOf(fx.useVer.get(id), depth + 1) : null), fn.scope);
        if (ir) return ir;
      }
    }
    return varForVersion(fx, ver);
  };
  const varFor = (id) => (fx.useVer.has(id) ? termOf(fx.useVer.get(id), 0) : null);
  const found = [];
  const seen = new Set();
  // boolValue: değerin kendisi kullanılıyor (a && b'nin sol tarafı): yalnızca boolean tipli koşul sabitlenebilir
  const consider = (p, boolValue = false) => {
    if (!p.node || seen.has(p.node)) return;
    seen.add(p.node);
    if (!isPureTyped(p.node, typeOf, fn.scope)) return;
    const ir = toIR(p.node, varFor, fn.scope);
    if (!ir || ir.k === 'c' || !vars(ir).size) return;
    if (boolValue && !onlyType(ir, 'boolean')) return;
    const r = decide(ir);
    if (!r) return;
    const item = { path: p, value: r.value, cond: r.text, proof: r.proof, proofText: proofText(r.proof), line: p.node.loc?.start.line ?? 0 };
    found.push(item);
    onProof(item);
  };
  for (const b of fx.blocks) {
    if (!fx.sccp.blocks.has(b)) continue;
    for (const ins of b.instrs) {
      if (!ins.path.node) continue;
      if (ins.kind === 'test') consider(ins.path);
      ins.path.traverse({
        Function(p) { p.skip(); },
        ConditionalExpression(p) { consider(p.get('test')); },
        LogicalExpression(p) { if (p.node.operator !== '??') consider(p.get('left'), true); },
      });
    }
  }
  return found;
}

export async function run(ast, { onLog, bump }) {
  if (hasDynamicScope(ast, traverse)) return;
  let n = 0;
  for (const fn of functionPaths(ast, traverse)) {
    if (!fn.node) continue;
    const items = findOpaque(fn);
    for (const it of items) {
      if (!it.path.node) continue;
      it.path.replaceWith(t.booleanLiteral(it.value));
      onLog(`opaque-smt: satır ${it.line}: ${it.cond} ≡ ${it.value} (${it.proofText})`, 'info');
      n++;
    }
    if (items.length) fn.scope.crawl();
  }
  bump('opaqueSmt', n);
}
