// E59: (kısmi) source map ile isim kurtarma — haritadaki `names` girdileri üretilmiş koddaki bildirimlere
//      eşlenir ve bağlamalar orijinal adlarıyla yeniden adlandırılır.
// E60: çıktı için source map üretme — girdi ve çıktı token dizileri hizalanır (sabit/benzersiz token
//      çapaları + aralık doldurma); eşleşen her token için çıktı → girdi konumu yazılır (Source Map v3).
import { parse as babelParse } from '@babel/parser';
import * as t from '@babel/types';
import { parse } from './parse.js';
import { traverse, generate } from '../util/ast.js';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function vlqEncode(v) {
  let n = v < 0 ? (-v << 1) | 1 : v << 1;
  let out = '';
  do {
    let digit = n & 31;
    n >>>= 5;
    if (n) digit |= 32;
    out += B64[digit];
  } while (n);
  return out;
}

export function decodeMappings(mappings) {
  const lines = [];
  const state = [0, 0, 0, 0, 0];
  for (const line of mappings.split(';')) {
    const segs = [];
    state[0] = 0;
    for (const seg of line.split(',')) {
      if (!seg) continue;
      const vals = [];
      let shift = 0;
      let value = 0;
      for (const ch of seg) {
        const d = B64.indexOf(ch);
        if (d < 0) throw new Error('source map: geçersiz VLQ karakteri');
        value += (d & 31) << shift;
        if (d & 32) shift += 5;
        else { vals.push(value & 1 ? -(value >>> 1) : value >>> 1); value = 0; shift = 0; }
      }
      vals.forEach((v, i) => { state[i] += v; });
      segs.push(state.slice(0, vals.length));
    }
    lines.push(segs);
  }
  return lines;
}

/** E59: map (JSON string ya da nesne) ile koddaki bildirimleri yeniden adlandırır */
export function recoverNames(code, map) {
  const m = typeof map === 'string' ? JSON.parse(map) : map;
  if (m?.version !== 3 || typeof m.mappings !== 'string' || !Array.isArray(m.names)) throw new Error('Source Map v3 değil');
  const lookup = new Map();
  decodeMappings(m.mappings).forEach((segs, line) => {
    for (const s of segs) if (s.length >= 5 && typeof m.names[s[4]] === 'string') lookup.set(`${line}:${s[0]}`, m.names[s[4]]);
  });
  const ast = parse(code);
  const renamed = [];
  const done = new Set();
  traverse(ast, {
    Scope(p) {
      for (const [name, b] of Object.entries(p.scope.bindings)) {
        if (done.has(b)) continue;
        done.add(b);
        const loc = b.identifier.loc?.start;
        if (!loc) continue;
        const orig = lookup.get(`${loc.line - 1}:${loc.column}`);
        if (!orig || orig === name || !t.isValidIdentifier(orig)) continue;
        // aynı kapsamda ya da referans noktalarında gölgeleme yaratacaksa atla
        if (b.scope.hasBinding(orig) || b.referencePaths.some((r) => r.scope.hasBinding(orig) && r.scope.getBinding(orig) !== b)) continue;
        b.scope.rename(name, orig);
        renamed.push({ from: name, to: orig });
      }
    },
  });
  return { code: generate(ast, { jsescOption: { minimal: true } }).code, renamed, mapped: lookup.size };
}

function tokens(code) {
  const ast = babelParse(code, { sourceType: 'unambiguous', tokens: true, errorRecovery: false, allowReturnOutsideFunction: true });
  return ast.tokens.filter((x) => x.type !== 'CommentLine' && x.type !== 'CommentBlock' && x.type?.label !== 'eof').map((x) => ({
    key: `${x.type?.label ?? x.type}|${x.value ?? ''}`,
    line: x.loc.start.line - 1,
    col: x.loc.start.column,
    name: x.type?.label === 'name' ? x.value : null,
  }));
}

// En uzun artan alt dizi (j'ye göre) — patience diff çapaları
function lis(pairs) {
  const tails = [];
  const prev = new Array(pairs.length);
  const idx = [];
  pairs.forEach((p, k) => {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (pairs[tails[mid]][1] < p[1]) lo = mid + 1; else hi = mid; }
    prev[k] = lo ? tails[lo - 1] : -1;
    tails[lo] = k;
    idx[lo] = k;
  });
  const out = [];
  for (let k = tails.length ? tails[tails.length - 1] : -1; k >= 0; k = prev[k]) out.unshift(pairs[k]);
  return out;
}

export function alignTokens(a, b) {
  const out = [];
  const rec = (a0, a1, b0, b1, depth) => {
    // baştan ve sondan eşit tokenlar
    while (a0 < a1 && b0 < b1 && a[a0].key === b[b0].key) out.push([a0++, b0++]);
    const tail = [];
    while (a0 < a1 && b0 < b1 && a[a1 - 1].key === b[b1 - 1].key) tail.unshift([--a1, --b1]);
    if (a0 < a1 && b0 < b1 && depth < 40) {
      const ca = new Map();
      const cb = new Map();
      for (let i = a0; i < a1; i++) { const k = a[i].key; ca.set(k, ca.has(k) ? -1 : i); }
      for (let j = b0; j < b1; j++) { const k = b[j].key; cb.set(k, cb.has(k) ? -1 : j); }
      const pairs = [];
      for (const [k, i] of ca) { const j = cb.get(k); if (i >= 0 && j !== undefined && j >= 0) pairs.push([i, j]); }
      pairs.sort((x, y) => x[0] - y[0]);
      const anchors = lis(pairs);
      if (anchors.length) {
        let pa = a0;
        let pb = b0;
        for (const [i, j] of anchors) {
          rec(pa, i, pb, j, depth + 1);
          out.push([i, j]);
          pa = i + 1;
          pb = j + 1;
        }
        rec(pa, a1, pb, b1, depth + 1);
      }
    }
    out.push(...tail);
  };
  rec(0, a.length, 0, b.length, 0);
  return out.sort((x, y) => x[1] - y[1]);
}

/** E60: çıktı (b) → girdi (a) Source Map v3 */
export function generateSourceMap(input, output, { file = 'peeled.js', source = 'input.js' } = {}) {
  const a = tokens(input);
  const b = tokens(output);
  const pairs = alignTokens(a, b);
  const names = [];
  const nameIdx = new Map();
  const byLine = [];
  for (const [i, j] of pairs) (byLine[b[j].line] ??= []).push([b[j].col, a[i].line, a[i].col, a[i].name]);
  let prevSrcLine = 0;
  let prevSrcCol = 0;
  let prevName = 0;
  const lines = [];
  const total = Math.max(byLine.length, output.split('\n').length);
  for (let line = 0; line < total; line++) {
    const segs = (byLine[line] ?? []).sort((x, y) => x[0] - y[0]);
    let prevCol = 0;
    const enc = [];
    for (const [col, sl, sc, nm] of segs) {
      let s = vlqEncode(col - prevCol) + vlqEncode(0) + vlqEncode(sl - prevSrcLine) + vlqEncode(sc - prevSrcCol);
      if (nm) {
        if (!nameIdx.has(nm)) { nameIdx.set(nm, names.length); names.push(nm); }
        const ni = nameIdx.get(nm);
        s += vlqEncode(ni - prevName);
        prevName = ni;
      }
      enc.push(s);
      prevCol = col;
      prevSrcLine = sl;
      prevSrcCol = sc;
    }
    lines.push(enc.join(','));
  }
  return {
    map: { version: 3, file, sources: [source], sourcesContent: [input], names, mappings: lines.join(';') },
    matched: pairs.length,
    coverage: b.length ? Number((pairs.length / b.length).toFixed(3)) : 1,
  };
}
