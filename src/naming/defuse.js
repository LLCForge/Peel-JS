import * as t from '@babel/types';
import { traverse } from '../util/ast.js';
import { buildCfg } from './cfg.js';

// 90: tanım-kullanım zincirleri. Her fonksiyonun deyim düzeyindeki CFG'si üzerinde klasik "ulaşan tanımlar" veri akışı:
// bir okuma, kendisine giden yolda üzerine yazılmadan ulaşabilen her tanıma bağlanır.
// İç fonksiyonlardaki (kapanış) okumalar, binding'in tüm tanımlarına bağlanır (çağrı anı statik bilinemez).

const MAX_FUNCTIONS = 300;

/**
 * @returns {{ bindings: { name:string, kind:string, line:number|null, defs:{line:number|null,kind:string}[],
 *   uses:{line:number|null,kind:string,from:number[]}[] }[] }}
 */
export function defUse(ast) {
  const out = [];
  const owners = [];
  traverse(ast, {
    'Program|Function'(p) {
      if (owners.length < MAX_FUNCTIONS) owners.push(p);
    },
  });
  const byBinding = new Map();
  const entry = (b) => {
    if (!byBinding.has(b)) {
      const e = { name: b.identifier.name, kind: b.kind, line: b.identifier.loc?.start.line ?? null, defs: [], uses: [] };
      byBinding.set(b, e);
      out.push(e);
    }
    return byBinding.get(b);
  };

  for (const fp of owners) {
    const body = fp.isProgram() ? fp.node : (t.isBlockStatement(fp.node.body) ? fp.node.body : null);
    if (!body) continue;
    let cfg;
    try { cfg = buildCfg(body, { granular: true, maxNodes: 2000 }); } catch { continue; }
    // düğüm → deyim düğümleri; deyim → düğüm
    const nodeOf = new Map();
    cfg.nodes.forEach((n) => { for (const s of n.stmts) nodeOf.set(s, n.id); });
    // bu fonksiyonun kendi binding'leri için tanım ve kullanım olayları
    const defsAt = new Map(); // node id → [{b, defId}]
    const usesAt = new Map(); // node id → [{b, line, kind}]
    const defList = []; // defId → {b, line, kind}
    const ownerNode = fp.node;
    const ownerOf = (p) => p.getFunctionParent()?.node ?? p.scope.getProgramParent().path.node;
    const locate = (p) => {
      for (let x = p; x; x = x.parentPath) {
        if (nodeOf.has(x.node)) return nodeOf.get(x.node);
        if (x.node === ownerNode) return null;
      }
      return null;
    };
    const push = (map, k, v) => { if (!map.has(k)) map.set(k, []); map.get(k).push(v); };
    // parametreler ve hoist edilen fonksiyonlar girişte tanımlanır
    for (const b of Object.values(fp.scope.bindings)) {
      if (b.kind === 'param' || b.kind === 'hoisted') {
        const id = defList.length;
        defList.push({ b, line: b.identifier.loc?.start.line ?? null, kind: b.kind === 'param' ? 'param' : 'function' });
        push(defsAt, 0, { b, id });
      }
    }
    const visitor = {
      Function(q) { if (q.node !== ownerNode) q.skip(); },
      VariableDeclarator(q) {
        if (ownerOf(q) !== ownerNode) return;
        for (const name of Object.keys(q.getBindingIdentifiers())) {
          const b = q.scope.getBinding(name);
          if (!b || (!q.node.init && b.kind === 'var' && !q.parentPath.parentPath.isForXStatement())) continue;
          const at = locate(q);
          if (at === null) continue;
          const id = defList.length;
          defList.push({ b, line: q.node.loc?.start.line ?? null, kind: 'bildirim' });
          push(defsAt, at, { b, id });
        }
      },
      'AssignmentExpression|UpdateExpression'(q) {
        if (ownerOf(q) !== ownerNode) return;
        const target = q.isAssignmentExpression() ? q.node.left : q.node.argument;
        if (!t.isIdentifier(target)) return;
        const b = q.scope.getBinding(target.name);
        if (!b) return;
        const at = locate(q);
        if (at === null) return;
        if (q.isUpdateExpression() || q.node.operator !== '=') push(usesAt, at, { b, line: q.node.loc?.start.line ?? null, kind: 'oku-yaz' });
        const id = defList.length;
        defList.push({ b, line: q.node.loc?.start.line ?? null, kind: q.isUpdateExpression() ? 'artırma' : 'atama' });
        push(defsAt, at, { b, id });
      },
      Identifier(q) {
        if (!q.isReferencedIdentifier()) return;
        const b = q.scope.getBinding(q.node.name);
        if (!b) return;
        const line = q.node.loc?.start.line ?? null;
        if (ownerOf(q) !== ownerNode) return;
        // dış fonksiyonun binding'i: kapanış okuması olarak aşağıda bağlanır
        if ((b.scope.getFunctionParent()?.path.node ?? b.scope.getProgramParent().path.node) !== ownerNode) return;
        const at = locate(q);
        if (at === null) return;
        push(usesAt, at, { b, line, kind: q.parentPath.isCallExpression({ callee: q.node }) ? 'çağrı' : 'okuma' });
      },
    };
    if (fp.isProgram()) fp.traverse(visitor);
    else fp.get('body').traverse(visitor);

    // ulaşan tanımlar: IN[n] = ∪ OUT[pred]; OUT[n] = GEN[n] ∪ (IN[n] − KILL[n])
    const preds = new Map();
    for (const e of cfg.edges) push(preds, e.to, e.from);
    const IN = cfg.nodes.map(() => new Set());
    const OUT = cfg.nodes.map(() => new Set());
    const gen = cfg.nodes.map((n) => {
      const last = new Map();
      for (const d of defsAt.get(n.id) ?? []) last.set(d.b, d.id);
      return last;
    });
    let changed = true;
    let guard = 0;
    while (changed && guard++ < 200) {
      changed = false;
      for (const n of cfg.nodes) {
        const inn = new Set();
        for (const p of preds.get(n.id) ?? []) for (const d of OUT[p]) inn.add(d);
        const outn = new Set();
        for (const d of inn) if (!gen[n.id].has(defList[d].b)) outn.add(d);
        for (const d of gen[n.id].values()) outn.add(d);
        if (outn.size !== OUT[n.id].size || [...outn].some((d) => !OUT[n.id].has(d))) changed = true;
        IN[n.id] = inn;
        OUT[n.id] = outn;
      }
    }
    for (const d of defList) entry(d.b).defs.push({ line: d.line, kind: d.kind });
    for (const [at, list] of usesAt) {
      for (const u of list) {
        const reach = [...IN[at]].filter((d) => defList[d].b === u.b).map((d) => defList[d].line);
        entry(u.b).uses.push({ line: u.line, kind: u.kind, from: [...new Set(reach)] });
      }
    }
  }

  // kapanış okumaları: binding başka fonksiyonda tanımlı, kullanım iç fonksiyonda
  traverse(ast, {
    Identifier(q) {
      if (!q.isReferencedIdentifier()) return;
      const b = q.scope.getBinding(q.node.name);
      if (!b) return;
      const own = q.getFunctionParent()?.node ?? null;
      const declOwner = b.scope.getFunctionParent()?.path.node ?? null;
      if (own === declOwner || own === null) return;
      const e = byBinding.get(b) ?? entry(b);
      e.uses.push({ line: q.node.loc?.start.line ?? null, kind: 'kapanış', from: [...new Set(e.defs.map((d) => d.line))] });
    },
  });
  return { bindings: out.sort((a, b) => (a.line ?? 0) - (b.line ?? 0)) };
}
