// CDCL SAT çözücü: iki izlenen literal, 1UIP öğrenme, VSIDS (yığın), faz saklama, Luby yeniden başlatma,
// varsayımlarla artımlı çözüm. Bütçe (çatışma / süre) aşılırsa 'unknown' döner.
// Literal: +v / -v (v ≥ 1). Tarayıcıda ve Node'da aynı çalışır.

const luby = (i) => {
  let size = 1;
  let seq = 0;
  while (size < i + 1) { seq++; size = 2 * size + 1; }
  let x = i;
  while (size - 1 !== x) { size = (size - 1) >> 1; seq--; x %= size; }
  return 2 ** seq;
};

export class Sat {
  constructor() {
    this.n = 0;
    this.ok = true;
    this.val = [0];
    this.level = [0];
    this.reason = [null];
    this.activity = [0];
    this.phase = [0];
    this.seen = [0];
    this.watches = [[], []];
    this.trail = [];
    this.limits = [];
    this.qhead = 0;
    this.inc = 1;
    this.heap = [];
    this.heapPos = [-1];
    this.learnts = [];
    this.maxLearnts = 4000;
    this.stats = { conflicts: 0, decisions: 0, propagations: 0, solves: 0 };
    this.model = null;
  }

  newVar() {
    const v = ++this.n;
    this.val.push(0); this.level.push(0); this.reason.push(null); this.activity.push(0); this.phase.push(-1); this.seen.push(0);
    this.watches.push([], []);
    this.heapPos.push(-1);
    this.heapInsert(v);
    return v;
  }

  // Literal → watches dizini
  static w(l) { return l > 0 ? 2 * l : -2 * l + 1; }
  value(l) { return l > 0 ? this.val[l] : -this.val[-l]; }

  addClause(lits) {
    if (!this.ok) return false;
    this.backtrack(0);
    const set = new Set();
    for (const l of lits) {
      if (set.has(-l) || this.value(l) === 1) return true;
      if (this.value(l) !== -1) set.add(l);
    }
    const c = [...set];
    if (!c.length) { this.ok = false; return false; }
    if (c.length === 1) {
      this.enqueue(c[0], null);
      if (this.propagate()) this.ok = false;
      return this.ok;
    }
    this.attach(c);
    return true;
  }

  attach(c) {
    this.watches[Sat.w(c[0])].push(c);
    this.watches[Sat.w(c[1])].push(c);
  }

  enqueue(l, reason) {
    const v = Math.abs(l);
    this.val[v] = l > 0 ? 1 : -1;
    this.level[v] = this.limits.length;
    this.reason[v] = reason;
    this.trail.push(l);
  }

  // Çatışan cümleyi ya da null döndürür
  propagate() {
    while (this.qhead < this.trail.length) {
      const p = this.trail[this.qhead++];
      const falseLit = -p;
      const ws = this.watches[Sat.w(falseLit)];
      this.stats.propagations++;
      let i = 0;
      let j = 0;
      while (i < ws.length) {
        const c = ws[i++];
        if (c.deleted) continue;
        if (c[0] === falseLit) { c[0] = c[1]; c[1] = falseLit; }
        if (this.value(c[0]) === 1) { ws[j++] = c; continue; }
        let moved = false;
        for (let k = 2; k < c.length; k++) {
          if (this.value(c[k]) !== -1) {
            c[1] = c[k]; c[k] = falseLit;
            this.watches[Sat.w(c[1])].push(c);
            moved = true;
            break;
          }
        }
        if (moved) continue;
        ws[j++] = c;
        if (this.value(c[0]) === -1) {
          while (i < ws.length) ws[j++] = ws[i++];
          ws.length = j;
          return c;
        }
        this.enqueue(c[0], c);
      }
      ws.length = j;
    }
    return null;
  }

  backtrack(lvl) {
    if (this.limits.length <= lvl) return;
    const lim = this.limits[lvl];
    for (let i = this.trail.length - 1; i >= lim; i--) {
      const v = Math.abs(this.trail[i]);
      this.phase[v] = this.val[v];
      this.val[v] = 0;
      this.reason[v] = null;
      if (this.heapPos[v] < 0) this.heapInsert(v);
    }
    this.trail.length = lim;
    this.qhead = lim;
    this.limits.length = lvl;
  }

  bump(v) {
    if ((this.activity[v] += this.inc) > 1e100) {
      for (let i = 1; i <= this.n; i++) this.activity[i] *= 1e-100;
      this.inc *= 1e-100;
    }
    if (this.heapPos[v] >= 0) this.heapUp(this.heapPos[v]);
  }

  analyze(confl) {
    const learnt = [0];
    let pathC = 0;
    let p = 0;
    let idx = this.trail.length - 1;
    const cur = this.limits.length;
    const touched = [];
    do {
      for (const q of confl) {
        if (q === p) continue;
        const v = Math.abs(q);
        if (this.seen[v] || this.level[v] === 0) continue;
        this.seen[v] = 1;
        touched.push(v);
        this.bump(v);
        if (this.level[v] >= cur) pathC++;
        else learnt.push(q);
      }
      while (!this.seen[Math.abs(this.trail[idx])]) idx--;
      p = this.trail[idx--];
      confl = this.reason[Math.abs(p)];
      this.seen[Math.abs(p)] = 0;
      pathC--;
    } while (pathC > 0);
    learnt[0] = -p;
    for (const v of touched) this.seen[v] = 0;
    let bt = 0;
    let maxI = 1;
    for (let i = 1; i < learnt.length; i++) {
      const lv = this.level[Math.abs(learnt[i])];
      if (lv > bt) { bt = lv; maxI = i; }
    }
    if (learnt.length > 1) [learnt[1], learnt[maxI]] = [learnt[maxI], learnt[1]];
    this.inc *= 1 / 0.95;
    return { learnt, bt };
  }

  reduceDb() {
    const locked = (c) => this.reason[Math.abs(c[0])] === c;
    this.learnts.sort((a, b) => a.length - b.length);
    const keep = [];
    this.learnts.forEach((c, i) => {
      if (i > this.learnts.length / 2 && c.length > 2 && !locked(c)) c.deleted = true;
      else keep.push(c);
    });
    this.learnts = keep;
  }

  pickBranch() {
    while (this.heap.length) {
      const v = this.heapPop();
      if (this.val[v] === 0) return this.phase[v] === 1 ? v : -v;
    }
    return 0;
  }

  /**
   * @param {{ assumptions?: number[], maxConflicts?: number, deadline?: number }} o
   * @returns {'sat'|'unsat'|'unknown'}
   */
  solve({ assumptions = [], maxConflicts = Infinity, deadline = Infinity } = {}) {
    this.stats.solves++;
    this.model = null;
    this.budgetHit = null;
    if (!this.ok) return 'unsat';
    this.backtrack(0);
    if (this.propagate()) { this.ok = false; return 'unsat'; }
    let conflicts = 0;
    let restartNo = 0;
    let restartAt = 100 * luby(0);
    let sinceRestart = 0;
    for (;;) {
      const confl = this.propagate();
      if (confl) {
        conflicts++;
        sinceRestart++;
        this.stats.conflicts++;
        if (this.limits.length === 0) { this.ok = false; return 'unsat'; }
        const { learnt, bt } = this.analyze(confl);
        this.backtrack(bt);
        if (learnt.length === 1) this.enqueue(learnt[0], null);
        else {
          this.attach(learnt);
          this.learnts.push(learnt);
          this.enqueue(learnt[0], learnt);
        }
        if (conflicts >= maxConflicts) { this.backtrack(0); this.budgetHit = 'çatışma bütçesi'; return 'unknown'; }
        if ((conflicts & 63) === 0 && Date.now() > deadline) { this.backtrack(0); this.budgetHit = 'zaman aşımı'; return 'unknown'; }
        continue;
      }
      if (sinceRestart >= restartAt) {
        sinceRestart = 0;
        restartAt = 100 * luby(++restartNo);
        this.backtrack(0);
        if (this.learnts.length > this.maxLearnts) { this.reduceDb(); this.maxLearnts *= 1.1; }
        continue;
      }
      let next = 0;
      while (this.limits.length < assumptions.length) {
        const a = assumptions[this.limits.length];
        const v = this.value(a);
        if (v === 1) { this.limits.push(this.trail.length); continue; }
        if (v === -1) { this.backtrack(0); return 'unsat'; }
        next = a;
        break;
      }
      if (!next) {
        this.stats.decisions++;
        if ((this.stats.decisions & 1023) === 0 && Date.now() > deadline) { this.backtrack(0); this.budgetHit = 'zaman aşımı'; return 'unknown'; }
        next = this.pickBranch();
        if (!next) {
          this.model = this.val.slice();
          this.backtrack(0);
          return 'sat';
        }
      }
      this.limits.push(this.trail.length);
      this.enqueue(next, null);
    }
  }

  // VSIDS yığını (en yüksek aktivite tepede)
  heapInsert(v) { this.heapPos[v] = this.heap.length; this.heap.push(v); this.heapUp(this.heap.length - 1); }
  heapUp(i) {
    const h = this.heap;
    const v = h[i];
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.activity[h[p]] >= this.activity[v]) break;
      h[i] = h[p]; this.heapPos[h[i]] = i; i = p;
    }
    h[i] = v; this.heapPos[v] = i;
  }
  heapPop() {
    const h = this.heap;
    const top = h[0];
    const last = h.pop();
    this.heapPos[top] = -1;
    if (h.length) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= h.length) break;
        const r = l + 1;
        const c = r < h.length && this.activity[h[r]] > this.activity[h[l]] ? r : l;
        if (this.activity[h[c]] <= this.activity[last]) break;
        h[i] = h[c]; this.heapPos[h[i]] = i; i = c;
      }
      h[i] = last; this.heapPos[last] = i;
    }
    return top;
  }
}
