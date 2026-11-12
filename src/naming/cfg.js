import * as t from '@babel/types';
import { gen } from '../util/ast.js';

// 89: kontrol akış grafiği. Fonksiyon (ya da program) gövdesinden temel bloklar ve kenarlar.
// granular: true ise her deyim ayrı düğümdür (tanım-kullanım veri akışı için).

const short = (node, max = 60) => {
  let s;
  try { s = gen(node).replace(/\s+/g, ' '); } catch { s = node.type; }
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

/**
 * @param {object} body  BlockStatement ya da Program düğümü
 * @returns {{ nodes: {id:number,kind:string,label:string,line:number|null,stmts:object[]}[], edges: {from:number,to:number,label:string}[] }}
 */
export function buildCfg(body, { granular = false, maxNodes = 400 } = {}) {
  const nodes = [];
  const edges = [];
  const add = (kind, label, line = null) => {
    if (nodes.length >= maxNodes) throw new Error('çok büyük');
    const n = { id: nodes.length, kind, label, line, stmts: [] };
    nodes.push(n);
    return n;
  };
  const edge = (from, to, label = '') => { if (from && to) edges.push({ from: from.id, to: to.id, label }); };
  const entry = add('entry', 'giriş');
  const exit = add('exit', 'çıkış');

  // açık döngü/switch/etiket çerçeveleri: break/continue hedefleri
  const loops = [];
  const loopLabels = new WeakMap();

  // preds: bu noktaya akan düğümler [{node, label}]; dönüş: deyim listesinden çıkan akışlar
  function seq(stmts, preds) {
    let cur = preds;
    let block = null;
    for (const s of stmts) {
      if (!cur.length) break; // erişilemeyen kod
      if (isSimple(s)) {
        if (!block || granular) {
          block = add('block', '', s.loc?.start.line ?? null);
          for (const p of cur) edge(p.node, block, p.label);
          cur = [{ node: block, label: '' }];
        }
        block.stmts.push(s);
        block.label = block.label ? `${block.label}\n${short(s)}` : short(s);
        continue;
      }
      block = null;
      cur = stmt(s, cur);
    }
    return cur;
  }

  function stmt(s, preds) {
    const line = s.loc?.start.line ?? null;
    const link = (n) => { for (const p of preds) edge(p.node, n, p.label); };
    if (t.isBlockStatement(s)) return seq(s.body, preds);
    if (t.isIfStatement(s)) {
      const c = add('cond', `if (${short(s.test, 40)})`, line);
      c.stmts.push(s.test);
      link(c);
      const a = stmt(s.consequent, [{ node: c, label: 'doğru' }]);
      const b = s.alternate ? stmt(s.alternate, [{ node: c, label: 'yanlış' }]) : [{ node: c, label: 'yanlış' }];
      return [...a, ...b];
    }
    if (t.isWhileStatement(s) || t.isForStatement(s) || t.isForInStatement(s) || t.isForOfStatement(s) || t.isDoWhileStatement(s)) {
      let init = preds;
      if (t.isForStatement(s) && s.init) {
        const i = add('block', short(s.init), line);
        i.stmts.push(s.init);
        for (const p of preds) edge(p.node, i, p.label);
        init = [{ node: i, label: '' }];
      }
      const head = add('loop', t.isForInStatement(s) || t.isForOfStatement(s)
        ? `for (${short(s.left, 20)} ${t.isForInStatement(s) ? 'in' : 'of'} ${short(s.right, 25)})`
        : `${t.isDoWhileStatement(s) ? 'do…while' : 'while'} (${short(s.test ?? t.booleanLiteral(true), 40)})`, line);
      if (s.test) head.stmts.push(s.test);
      if (t.isForInStatement(s) || t.isForOfStatement(s)) head.stmts.push(s.right, s.left);
      const frame = { breaks: [], continues: [], label: loopLabels.get(s) ?? null };
      loops.push(frame);
      let bodyOut;
      if (t.isDoWhileStatement(s)) {
        const bodyEntry = add('block', 'do', line);
        for (const p of init) edge(p.node, bodyEntry, p.label);
        bodyOut = stmt(s.body, [{ node: bodyEntry, label: '' }]);
        for (const p of [...bodyOut, ...frame.continues]) edge(p.node, head, p.label);
        edge(head, bodyEntry, 'tekrar');
      } else {
        for (const p of init) edge(p.node, head, p.label);
        bodyOut = stmt(s.body, [{ node: head, label: 'gir' }]);
        let back = [...bodyOut, ...frame.continues];
        if (t.isForStatement(s) && s.update) {
          const u = add('block', short(s.update), line);
          u.stmts.push(s.update);
          for (const p of back) edge(p.node, u, p.label);
          back = [{ node: u, label: '' }];
        }
        for (const p of back) edge(p.node, head, 'tekrar');
      }
      loops.pop();
      const infinite = (t.isWhileStatement(s) || t.isForStatement(s)) && (!s.test || t.isBooleanLiteral(s.test, { value: true }));
      return [...(infinite ? [] : [{ node: head, label: 'çık' }]), ...frame.breaks];
    }
    if (t.isLabeledStatement(s)) {
      if (t.isLoop(s.body)) { loopLabels.set(s.body, s.label.name); return stmt(s.body, preds); }
      const frame = { breaks: [], continues: [], label: s.label.name, block: true };
      loops.push(frame);
      const out = stmt(s.body, preds);
      loops.pop();
      return [...out, ...frame.breaks];
    }
    if (t.isSwitchStatement(s)) {
      const c = add('switch', `switch (${short(s.discriminant, 40)})`, line);
      c.stmts.push(s.discriminant);
      link(c);
      const frame = { breaks: [], continues: null, label: null, isSwitch: true };
      loops.push(frame);
      let fall = [];
      let hasDefault = false;
      for (const k of s.cases) {
        if (!k.test) hasDefault = true;
        const lab = k.test ? `case ${short(k.test, 20)}` : 'default';
        fall = seq(k.consequent, [...fall, { node: c, label: lab }]);
      }
      loops.pop();
      return [...fall, ...frame.breaks, ...(hasDefault ? [] : [{ node: c, label: 'eşleşme yok' }])];
    }
    if (t.isTryStatement(s)) {
      const tr = add('try', 'try', line);
      link(tr);
      const a = stmt(s.block, [{ node: tr, label: '' }]);
      let b = [];
      if (s.handler) {
        const h = add('catch', `catch (${s.handler.param ? short(s.handler.param, 20) : ''})`, s.handler.loc?.start.line ?? null);
        edge(tr, h, 'hata');
        b = stmt(s.handler.body, [{ node: h, label: '' }]);
      }
      const out = [...a, ...b];
      if (s.finalizer) {
        const f = add('finally', 'finally', s.finalizer.loc?.start.line ?? null);
        for (const p of out) edge(p.node, f, p.label);
        if (!s.handler) edge(tr, f, 'hata');
        return stmt(s.finalizer, [{ node: f, label: '' }]);
      }
      return out;
    }
    if (t.isReturnStatement(s) || t.isThrowStatement(s)) {
      const r = add(t.isReturnStatement(s) ? 'return' : 'throw', short(s), line);
      r.stmts.push(s);
      link(r);
      edge(r, exit, t.isThrowStatement(s) ? 'hata' : '');
      return [];
    }
    if (t.isBreakStatement(s) || t.isContinueStatement(s)) {
      const name = s.label?.name ?? null;
      const frame = [...loops].reverse().find((f) => (name ? f.label === name : (t.isBreakStatement(s) ? true : !f.isSwitch && !f.block)));
      if (frame) {
        const target = t.isBreakStatement(s) ? frame.breaks : frame.continues;
        if (target) for (const p of preds) target.push({ node: p.node, label: p.label || (t.isBreakStatement(s) ? 'break' : 'continue') });
      }
      return [];
    }
    // diğer deyimler (bildirim, ifade): tek blok
    const b = add('block', short(s), line);
    b.stmts.push(s);
    link(b);
    return [{ node: b, label: '' }];
  }

  const top = t.isProgram(body) ? body.body : body.body;
  const out = seq(top, [{ node: entry, label: '' }]);
  for (const p of out) edge(p.node, exit, p.label);
  return { nodes, edges };
}

const isSimple = (s) => !(t.isIfStatement(s) || t.isLoop(s) || t.isSwitchStatement(s) || t.isTryStatement(s) ||
  t.isReturnStatement(s) || t.isThrowStatement(s) || t.isBreakStatement(s) || t.isContinueStatement(s) ||
  t.isLabeledStatement(s) || t.isBlockStatement(s));

/** Katmanlı yerleşim: girişten BFS derinliği (geri kenarlar hariç) → { x, y } */
export function layout(cfg) {
  const depth = new Map([[0, 0]]);
  const order = [0];
  const out = new Map();
  for (const e of cfg.edges) {
    if (!out.has(e.from)) out.set(e.from, []);
    out.get(e.from).push(e.to);
  }
  for (let i = 0; i < order.length; i++) {
    const n = order[i];
    for (const m of out.get(n) ?? []) {
      if (depth.has(m)) continue;
      depth.set(m, depth.get(n) + 1);
      order.push(m);
    }
  }
  let maxDepth = 0;
  for (const d of depth.values()) maxDepth = Math.max(maxDepth, d);
  // erişilemeyen düğümler ve çıkış en alta
  for (const n of cfg.nodes) if (!depth.has(n.id)) depth.set(n.id, maxDepth + 1);
  depth.set(1, Math.max(...depth.values()) + (depth.get(1) === maxDepth + 1 ? 0 : 1));
  const rows = new Map();
  for (const n of cfg.nodes) {
    const d = depth.get(n.id);
    if (!rows.has(d)) rows.set(d, []);
    rows.get(d).push(n.id);
  }
  const pos = new Map();
  for (const [d, ids] of rows) ids.forEach((id, i) => pos.set(id, { x: i, y: d, row: ids.length }));
  return pos;
}

/** Düğüm başına yaklaşık döngüsel karmaşıklık: E - N + 2 */
export const cyclomatic = (cfg) => cfg.edges.length - cfg.nodes.length + 2;
