// CDCL SAT çözücü: iki izlenen literal, 1UIP öğrenme, VSIDS benzeri etkinlik, Luby yeniden başlatma.
// Öğrenilen her yan tümce DRUP kanıtı olarak kaydedilir; UNSAT sonucu checkDrup ile bağımsız doğrulanır.
// Literal: DIMACS biçimi (v > 0 doğru, -v yanlış).

const idx = (lit) => (lit > 0 ? lit << 1 : (-lit << 1) | 1);

function luby(i) {
  let k = 1;
  while ((1 << k) - 1 < i) k++;
  while ((1 << k) - 1 !== i) {
    i -= (1 << (k - 1)) - 1;
    k = 1;
    while ((1 << k) - 1 < i) k++;
  }
  return 1 << (k - 1);
}

export class Sat {
  constructor() {
    this.n = 0;
    this.clauses = [];
    this.trivialUnsat = false;
  }

  newVar() { return ++this.n; }

  add(clause) {
    const seen = new Set();
    const out = [];
    for (const l of clause) {
      if (seen.has(-l)) return; // totoloji
      if (!seen.has(l)) { seen.add(l); out.push(l); }
    }
    if (!out.length) this.trivialUnsat = true;
    this.clauses.push(out);
  }

  /** @returns {{status:'sat'|'unsat'|'unknown', model?:Int8Array, proof?:number[][], conflicts:number}} */
  solve({ maxConflicts = 200000, deadline = Infinity } = {}) {
    const n = this.n;
    const proof = [];
    if (this.trivialUnsat) { proof.push([]); return { status: 'unsat', proof, conflicts: 0 }; }
    const val = new Int8Array(n + 1);
    const level = new Int32Array(n + 1);
    const reason = new Int32Array(n + 1).fill(-1);
    const activity = new Float64Array(n + 1);
    const phase = new Int8Array(n + 1).fill(-1);
    const seen = new Uint8Array(n + 1);
    const watches = Array.from({ length: (n + 1) * 2 }, () => []);
    const db = [];
    const trail = [];
    const lim = [];
    let qhead = 0;
    let inc = 1;

    const value = (l) => (l > 0 ? val[l] : -val[-l]);
    const assign = (l, r) => {
      const v = Math.abs(l);
      val[v] = l > 0 ? 1 : -1;
      level[v] = lim.length;
      reason[v] = r;
      trail.push(l);
    };
    const attach = (ci) => {
      const c = db[ci];
      watches[idx(-c[0])].push(ci);
      watches[idx(-c[1])].push(ci);
    };

    const units = [];
    for (const c of this.clauses) {
      if (c.length === 1) units.push(c[0]);
      else { db.push(c.slice()); attach(db.length - 1); }
    }
    for (const u of units) {
      const cur = value(u);
      if (cur === -1) { proof.push([]); return { status: 'unsat', proof, conflicts: 0 }; }
      if (cur === 0) assign(u, -1);
    }

    // döndürür: çatışan yan tümce indeksi ya da -1
    const propagate = () => {
      while (qhead < trail.length) {
        const p = trail[qhead++];
        const ws = watches[idx(p)];
        let i = 0;
        let j = 0;
        let conflict = -1;
        while (i < ws.length) {
          const ci = ws[i++];
          const c = db[ci];
          if (c[0] === -p) { c[0] = c[1]; c[1] = -p; }
          if (value(c[0]) === 1) { ws[j++] = ci; continue; }
          let found = false;
          for (let k = 2; k < c.length; k++) {
            if (value(c[k]) !== -1) {
              c[1] = c[k]; c[k] = -p;
              watches[idx(-c[1])].push(ci);
              found = true;
              break;
            }
          }
          if (found) continue;
          ws[j++] = ci;
          if (value(c[0]) === -1) {
            conflict = ci;
            while (i < ws.length) ws[j++] = ws[i++];
          } else {
            assign(c[0], ci);
          }
        }
        ws.length = j;
        if (conflict >= 0) return conflict;
      }
      return -1;
    };

    // etkinliğe göre ikili yığın (en etkin atanmamış değişken)
    const heap = [];
    const pos = new Int32Array(n + 1).fill(-1);
    const less = (a, b) => activity[a] > activity[b];
    const up = (i) => {
      const v = heap[i];
      while (i > 0) {
        const pi = (i - 1) >> 1;
        if (!less(v, heap[pi])) break;
        heap[i] = heap[pi]; pos[heap[i]] = i; i = pi;
      }
      heap[i] = v; pos[v] = i;
    };
    const down = (i) => {
      const v = heap[i];
      for (;;) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1], heap[c])) c++;
        if (!less(heap[c], v)) break;
        heap[i] = heap[c]; pos[heap[i]] = i; i = c;
      }
      heap[i] = v; pos[v] = i;
    };
    const insert = (v) => { if (pos[v] >= 0) return; heap.push(v); up(heap.length - 1); };
    const popMax = () => {
      const top = heap[0];
      const last = heap.pop();
      pos[top] = -1;
      if (heap.length) { heap[0] = last; pos[last] = 0; down(0); }
      return top;
    };
    for (let v = 1; v <= n; v++) insert(v);

    const bump = (v) => {
      activity[v] += inc;
      if (activity[v] > 1e100) {
        for (let k = 1; k <= n; k++) activity[k] *= 1e-100;
        inc *= 1e-100;
      }
      if (pos[v] >= 0) up(pos[v]);
    };

    const analyze = (confl) => {
      const learnt = [0];
      let pathC = 0;
      let p = 0;
      let ti = trail.length - 1;
      let ci = confl;
      const cur = lim.length;
      do {
        const c = db[ci];
        for (let k = p === 0 ? 0 : 1; k < c.length; k++) {
          const q = c[k];
          const v = Math.abs(q);
          if (seen[v] || level[v] === 0) continue;
          seen[v] = 1;
          bump(v);
          if (level[v] >= cur) pathC++;
          else learnt.push(q);
        }
        while (!seen[Math.abs(trail[ti])]) ti--;
        p = trail[ti--];
        ci = reason[Math.abs(p)];
        seen[Math.abs(p)] = 0;
        pathC--;
        // değişmez: gerekçe yan tümcesinde çıkarılan literal her zaman 0. sırada (propagate öyle atar)
      } while (pathC > 0);
      learnt[0] = -p;
      for (let k = 1; k < learnt.length; k++) seen[Math.abs(learnt[k])] = 0;
      let bt = 0;
      if (learnt.length > 1) {
        let mi = 1;
        for (let k = 2; k < learnt.length; k++) if (level[Math.abs(learnt[k])] > level[Math.abs(learnt[mi])]) mi = k;
        [learnt[1], learnt[mi]] = [learnt[mi], learnt[1]];
        bt = level[Math.abs(learnt[1])];
      }
      return { learnt, bt };
    };

    const cancel = (lvl) => {
      if (lim.length <= lvl) return;
      for (let k = trail.length - 1; k >= lim[lvl]; k--) {
        const v = Math.abs(trail[k]);
        phase[v] = val[v];
        val[v] = 0;
        reason[v] = -1;
        insert(v);
      }
      trail.length = lim[lvl];
      qhead = trail.length;
      lim.length = lvl;
    };

    const pick = () => {
      while (heap.length) {
        const v = popMax();
        if (!val[v]) return v * phase[v];
      }
      return 0;
    };

    let conflicts = 0;
    let restartNo = 1;
    let budget = luby(restartNo) * 100;
    for (;;) {
      const confl = propagate();
      if (confl >= 0) {
        conflicts++;
        if (!lim.length) { proof.push([]); return { status: 'unsat', proof, conflicts }; }
        const { learnt, bt } = analyze(confl);
        cancel(bt);
        proof.push(learnt.slice());
        if (learnt.length === 1) {
          assign(learnt[0], -1);
        } else {
          db.push(learnt);
          attach(db.length - 1);
          assign(learnt[0], db.length - 1);
        }
        inc *= 1.05;
        if (conflicts >= maxConflicts || (conflicts % 256 === 0 && Date.now() > deadline)) return { status: 'unknown', conflicts };
        if (--budget <= 0) { cancel(0); budget = luby(++restartNo) * 100; }
      } else {
        const d = pick();
        if (!d) return { status: 'sat', model: val, conflicts };
        lim.push(trail.length);
        assign(d, -1);
      }
    }
  }
}

// DRUP denetleyici: her lemma için olumsuzlanmış literaller varsayılıp birim yayılımı çatışma üretmeli.
// Çözücüden bağımsız, sade bir yayılım motoru kullanır.
export function checkDrup(n, clauses, proof, { maxWork = 5e7 } = {}) {
  const db = clauses.map((c) => c.slice());
  let work = 0;
  const val = new Int8Array(n + 1);
  const value = (l) => (l > 0 ? val[l] : -val[-l]);
  const unitPropagate = (assumptions) => {
    const set = [];
    const put = (l) => { val[Math.abs(l)] = l > 0 ? 1 : -1; set.push(Math.abs(l)); };
    let conflict = false;
    for (const a of assumptions) {
      const cur = value(a);
      if (cur === -1) { conflict = true; break; }
      if (cur === 0) put(a);
    }
    let changed = !conflict;
    while (changed && !conflict) {
      changed = false;
      for (const c of db) {
        work += c.length;
        let unassigned = 0;
        let last = 0;
        let sat = false;
        for (const l of c) {
          const v = value(l);
          if (v === 1) { sat = true; break; }
          if (v === 0) { unassigned++; last = l; if (unassigned > 1) break; }
        }
        if (sat || unassigned > 1) continue;
        if (unassigned === 0) { conflict = true; break; }
        put(last);
        changed = true;
      }
      if (work > maxWork) break;
    }
    for (const v of set) val[v] = 0;
    return conflict;
  };
  for (const lemma of proof) {
    if (!unitPropagate(lemma.map((l) => -l))) return { ok: false, reason: work > maxWork ? 'bütçe' : 'RUP başarısız' };
    if (!lemma.length) return { ok: true, lemmas: proof.length };
    db.push(lemma);
  }
  return { ok: false, reason: 'boş yan tümce yok' };
}
