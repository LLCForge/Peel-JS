// Terim dili: 64 bit bitvektör + bool. JS sayıları int32 girdilerden türeyen tam sayılar olarak
// 64 bitte tam temsil edilir (2^53 sınırını motor denetler); bitsel işlemler sext32 ile ToInt32 olur.
// Terimler hash-consing ile tekildir: aynı yapı aynı nesne, blaster önbelleği id ile çalışır.

export const W = 64;
const BOOL = 'bool';
const BV = 'bv';
const BOOL_OPS = new Set(['bconst', 'bvar', 'eq', 'slt', 'sle', 'ult', 'bnot', 'band', 'bor']);
const COMMUTATIVE = new Set(['add', 'mul', 'and', 'or', 'xor', 'band', 'bor', 'eq']);

let table = new Map();
let nextId = 1;

const s64 = (x) => BigInt.asIntN(W, x);
// Oluşturulan terim sayacı (sınırlayıcı için)
export const termCounter = () => nextId;

function intern(op, args, val) {
  const key = `${op}|${args.map((a) => a.id).join(',')}|${val ?? ''}`;
  let t = table.get(key);
  if (t) return t;
  // shortcut: tablo büyüyünce sıfırlanır; eski terimler geçerli kalır, yalnızca paylaşım kaybolur
  if (table.size > 500_000) table = new Map();
  const sort = op === 'ite' ? args[1].sort : BOOL_OPS.has(op) ? BOOL : BV;
  t = { id: nextId++, op, args, val, sort };
  table.set(key, t);
  return t;
}

export const bvConst = (n) => intern('const', [], s64(BigInt(n)));
export const bvVar = (name) => intern('var', [], String(name));
export const boolConst = (b) => intern('bconst', [], b ? 1 : 0);
export const boolVar = (name) => intern('bvar', [], String(name));
export const TRUE = boolConst(true);
export const FALSE = boolConst(false);

const isC = (t) => t.op === 'const' || t.op === 'bconst';
const ZERO = bvConst(0);
const ONES = bvConst(-1);

// Sabit katlama ve basit özdeşlikler; kalan her şey yapısal terim olur
export function mk(op, ...args) {
  if (COMMUTATIVE.has(op) && args[0].id > args[1].id) args = [args[1], args[0]];
  if (args.length && args.every(isC)) return evalTerm(intern(op, args), {}, true);
  const [a, b, c] = args;
  switch (op) {
    case 'add': if (a === ZERO) return b; if (b === ZERO) return a; break;
    case 'sub': if (b === ZERO) return a; if (a === b) return ZERO; break;
    case 'mul': if (a === ZERO || b === ZERO) return ZERO; if (a.op === 'const' && a.val === 1n) return b; if (b.op === 'const' && b.val === 1n) return a; break;
    case 'and': if (a === ZERO || b === ZERO) return ZERO; if (a === ONES) return b; if (b === ONES) return a; if (a === b) return a; break;
    case 'or': if (a === ZERO) return b; if (b === ZERO) return a; if (a === b) return a; break;
    case 'xor': if (a === ZERO) return b; if (b === ZERO) return a; if (a === b) return ZERO; break;
    case 'not': if (a.op === 'not') return a.args[0]; break;
    case 'sext32': case 'zext32': if (a.op === op) return a; break;
    case 'ite': if (a === TRUE) return b; if (a === FALSE) return c; if (b === c) return b; if (b === TRUE && c === FALSE) return a; break;
    case 'bnot': if (a.op === 'bnot') return a.args[0]; break;
    case 'band': if (a === FALSE || b === FALSE) return FALSE; if (a === TRUE) return b; if (b === TRUE) return a; if (a === b) return a; 
      if ((a.op === 'bnot' && a.args[0] === b) || (b.op === 'bnot' && b.args[0] === a)) return FALSE;
      break;
    case 'bor': if (a === TRUE || b === TRUE) return TRUE; if (a === FALSE) return b; if (b === FALSE) return a; if (a === b) return a; 
      if ((a.op === 'bnot' && a.args[0] === b) || (b.op === 'bnot' && b.args[0] === a)) return TRUE;
      // (P && c) || (P && !c) → P: birleştirilen dalların yol koşulu sadeleşir
      if (a.op === 'band' && b.op === 'band') {
        for (const [p, q] of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
          const x = a.args[1 - p]; const y = b.args[1 - q];
          if (a.args[p] === b.args[q] && ((x.op === 'bnot' && x.args[0] === y) || (y.op === 'bnot' && y.args[0] === x))) return a.args[p];
        }
      }
      break;
    case 'eq': if (a === b) return TRUE; break;
    case 'slt': case 'ult': if (a === b) return FALSE; break;
    case 'sle': if (a === b) return TRUE; break;
  }
  return intern(op, args);
}

export const and = (...xs) => xs.reduce((a, b) => mk('band', a, b), TRUE);
export const or = (...xs) => xs.reduce((a, b) => mk('bor', a, b), FALSE);
export const not = (a) => mk('bnot', a);

const sh = (n) => n & 63n;

// Somut değerlendirme: env { varName: bigint|boolean }; atanmamış değişken 0/false
export function evalTerm(t, env = {}, fold = false) {
  const memo = new Map();
  const ev = (x) => {
    if (memo.has(x.id)) return memo.get(x.id);
    const v = ev1(x);
    memo.set(x.id, v);
    return v;
  };
  const ev1 = (x) => {
    const a = x.args.map((y) => (x.op === 'ite' && y !== x.args[0] ? y : ev(y)));
    switch (x.op) {
      case 'const': return x.val;
      case 'bconst': return x.val === 1;
      case 'var': return s64(BigInt(env[x.val] ?? 0));
      case 'bvar': return Boolean(env[x.val]);
      case 'add': return s64(a[0] + a[1]);
      case 'sub': return s64(a[0] - a[1]);
      case 'mul': return s64(a[0] * a[1]);
      case 'and': return a[0] & a[1];
      case 'or': return a[0] | a[1];
      case 'xor': return a[0] ^ a[1];
      case 'not': return ~a[0];
      case 'neg': return s64(-a[0]);
      case 'shl': return s64(a[0] << sh(a[1]));
      case 'ashr': return a[0] >> sh(a[1]);
      case 'lshr': return s64(BigInt.asUintN(W, a[0]) >> sh(a[1]));
      case 'sext32': return BigInt.asIntN(32, a[0]);
      case 'zext32': return BigInt.asUintN(32, a[0]);
      case 'ite': return a[0] ? ev(x.args[1]) : ev(x.args[2]);
      case 'eq': return a[0] === a[1];
      case 'slt': return a[0] < a[1];
      case 'sle': return a[0] <= a[1];
      case 'ult': return BigInt.asUintN(W, a[0]) < BigInt.asUintN(W, a[1]);
      case 'bnot': return !a[0];
      case 'band': return a[0] && a[1];
      case 'bor': return a[0] || a[1];
      default: throw new Error(`bilinmeyen terim: ${x.op}`);
    }
  };
  const v = ev(t);
  if (!fold) return v;
  return typeof v === 'boolean' ? boolConst(v) : bvConst(v);
}

// Terimdeki değişken adları (model okumak için)
export function varsOf(terms) {
  const seen = new Set();
  const out = new Map();
  const walk = (x) => {
    if (seen.has(x.id)) return;
    seen.add(x.id);
    if (x.op === 'var' || x.op === 'bvar') out.set(x.val, x);
    x.args.forEach(walk);
  };
  terms.forEach(walk);
  return [...out.values()];
}

export function termSize(t) {
  const seen = new Set();
  const walk = (x) => { if (!seen.has(x.id)) { seen.add(x.id); x.args.forEach(walk); } };
  walk(t);
  return seen.size;
}

const INFIX = { add: '+', sub: '-', mul: '*', and: '&', or: '|', xor: '^', shl: '<<', ashr: '>>', lshr: '>>>',
  eq: '==', slt: '<', sle: '<=', ult: '<u', band: '&&', bor: '||' };

// İnsan okunur biçim (yol koşulu raporları); uzun terimler kısaltılır
export function show(t, max = 300) {
  const s = (x) => {
    if (x.op === 'const') return String(x.val);
    if (x.op === 'bconst') return x.val ? 'true' : 'false';
    if (x.op === 'var' || x.op === 'bvar') return x.val;
    if (INFIX[x.op]) return `(${s(x.args[0])} ${INFIX[x.op]} ${s(x.args[1])})`;
    if (x.op === 'ite') return `(${s(x.args[0])} ? ${s(x.args[1])} : ${s(x.args[2])})`;
    if (x.op === 'bnot') return `!${s(x.args[0])}`;
    if (x.op === 'not') return `~${s(x.args[0])}`;
    if (x.op === 'neg') return `-${s(x.args[0])}`;
    return `${x.op}(${x.args.map(s).join(', ')})`;
  };
  const out = s(t);
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

// Tseitin bit-blaster: terimleri SAT değişkenlerine çevirir; kapılar yapısal olarak önbelleklenir
export class Blaster {
  constructor(sat) {
    this.sat = sat;
    this.T = sat.newVar();
    sat.addClause([this.T]);
    this.gates = new Map();
    this.cache = new Map();
    this.varBits = new Map();
  }

  AND(a, b) {
    const T = this.T;
    if (a === -T || b === -T || a === -b) return -T;
    if (a === T) return b;
    if (b === T || a === b) return a;
    const key = a < b ? `a${a},${b}` : `a${b},${a}`;
    let g = this.gates.get(key);
    if (g) return g;
    g = this.sat.newVar();
    this.sat.addClause([-g, a]);
    this.sat.addClause([-g, b]);
    this.sat.addClause([g, -a, -b]);
    this.gates.set(key, g);
    return g;
  }

  OR(a, b) { return -this.AND(-a, -b); }

  XOR(a, b) {
    const T = this.T;
    if (a === -T) return b;
    if (b === -T) return a;
    if (a === T) return -b;
    if (b === T) return -a;
    if (a === b) return -T;
    if (a === -b) return T;
    let sign = 1;
    if (a < 0) { a = -a; sign = -sign; }
    if (b < 0) { b = -b; sign = -sign; }
    const key = a < b ? `x${a},${b}` : `x${b},${a}`;
    let g = this.gates.get(key);
    if (!g) {
      g = this.sat.newVar();
      this.sat.addClause([-g, a, b]);
      this.sat.addClause([-g, -a, -b]);
      this.sat.addClause([g, -a, b]);
      this.sat.addClause([g, a, -b]);
      this.gates.set(key, g);
    }
    return sign * g;
  }

  MUX(c, x, y) {
    if (c === this.T) return x;
    if (c === -this.T) return y;
    if (x === y) return x;
    return this.OR(this.AND(c, x), this.AND(-c, y));
  }

  addBits(a, b, cin) {
    const out = [];
    let c = cin;
    for (let i = 0; i < W; i++) {
      const ab = this.XOR(a[i], b[i]);
      out.push(this.XOR(ab, c));
      c = this.OR(this.AND(a[i], b[i]), this.AND(c, ab));
    }
    return out;
  }

  constBits(v) {
    const u = BigInt.asUintN(W, v);
    return Array.from({ length: W }, (_, i) => ((u >> BigInt(i)) & 1n ? this.T : -this.T));
  }

  shift(x, amt, kind) {
    let cur = x;
    for (let s = 0; s < 6; s++) {
      const k = 1 << s;
      const fill = kind === 'ashr' ? cur[W - 1] : -this.T;
      const moved = cur.map((_, i) => (kind === 'shl' ? (i >= k ? cur[i - k] : -this.T) : (i + k < W ? cur[i + k] : fill)));
      cur = cur.map((bit, i) => this.MUX(amt[s], moved[i], bit));
    }
    return cur;
  }

  // a <u b: en yüksek farklı bit karar verir
  ult(a, b) {
    let lt = -this.T;
    for (let i = 0; i < W; i++) lt = this.MUX(this.XOR(a[i], b[i]), b[i], lt);
    return lt;
  }

  bits(t) {
    const hit = this.cache.get(t.id);
    if (hit) return hit;
    const A = () => this.bits(t.args[0]);
    const B = () => this.bits(t.args[1]);
    let r;
    switch (t.op) {
      case 'const': r = this.constBits(t.val); break;
      case 'var': r = Array.from({ length: W }, () => this.sat.newVar()); this.varBits.set(t.val, r); break;
      case 'add': r = this.addBits(A(), B(), -this.T); break;
      case 'sub': r = this.addBits(A(), B().map((x) => -x), this.T); break;
      case 'neg': r = this.addBits(this.constBits(0n), A().map((x) => -x), this.T); break;
      case 'mul': {
        // sabit taraf çarpan olsun: 0 bitleri hiç kısmi toplam üretmez
        let [x, y] = t.args;
        if (x.op === 'const') [x, y] = [y, x];
        const a = this.bits(x);
        const b = this.bits(y);
        r = this.constBits(0n);
        for (let i = 0; i < W; i++) {
          if (b[i] === -this.T) continue;
          const part = Array.from({ length: W }, (_, j) => (j < i ? -this.T : this.AND(a[j - i], b[i])));
          r = this.addBits(r, part, -this.T);
        }
        break;
      }
      case 'and': { const a = A(); const b = B(); r = a.map((x, i) => this.AND(x, b[i])); break; }
      case 'or': { const a = A(); const b = B(); r = a.map((x, i) => this.OR(x, b[i])); break; }
      case 'xor': { const a = A(); const b = B(); r = a.map((x, i) => this.XOR(x, b[i])); break; }
      case 'not': r = A().map((x) => -x); break;
      case 'shl': case 'ashr': case 'lshr': r = this.shift(A(), B(), t.op); break;
      case 'sext32': { const a = A(); r = a.map((x, i) => (i < 32 ? x : a[31])); break; }
      case 'zext32': { const a = A(); r = a.map((x, i) => (i < 32 ? x : -this.T)); break; }
      case 'ite': {
        const c = this.lit(t.args[0]);
        const x = this.bits(t.args[1]);
        const y = this.bits(t.args[2]);
        r = x.map((b, i) => this.MUX(c, b, y[i]));
        break;
      }
      default: throw new Error(`bitvektör değil: ${t.op}`);
    }
    this.cache.set(t.id, r);
    return r;
  }

  lit(t) {
    const hit = this.cache.get(t.id);
    if (hit !== undefined) return hit;
    let r;
    const [x, y, z] = t.args;
    switch (t.op) {
      case 'bconst': r = t.val ? this.T : -this.T; break;
      case 'bvar': r = this.sat.newVar(); this.varBits.set(t.val, [r]); break;
      case 'bnot': r = -this.lit(x); break;
      case 'band': r = this.AND(this.lit(x), this.lit(y)); break;
      case 'bor': r = this.OR(this.lit(x), this.lit(y)); break;
      case 'ite': r = this.MUX(this.lit(x), this.lit(y), this.lit(z)); break;
      case 'eq':
        if (x.sort === BOOL) { r = -this.XOR(this.lit(x), this.lit(y)); break; }
        r = this.bits(x).reduce((acc, b, i) => this.AND(acc, -this.XOR(b, this.bits(y)[i])), this.T);
        break;
      case 'ult': r = this.ult(this.bits(x), this.bits(y)); break;
      case 'slt': case 'sle': {
        // işaret bitini çevirince işaretli sıra işaretsiz sıraya döner
        const flip = (v) => v.map((b, i) => (i === W - 1 ? -b : b));
        const a = flip(this.bits(x));
        const b = flip(this.bits(y));
        r = t.op === 'slt' ? this.ult(a, b) : -this.ult(b, a);
        break;
      }
      default: throw new Error(`bool değil: ${t.op}`);
    }
    this.cache.set(t.id, r);
    return r;
  }

  // Model: değişken adı → bigint|boolean
  read(model, vars) {
    const out = {};
    for (const v of vars) {
      const bits = this.varBits.get(v.val);
      if (!bits) { out[v.val] = v.sort === BOOL ? false : 0n; continue; }
      if (v.sort === BOOL) { out[v.val] = model[bits[0]] === 1; continue; }
      let u = 0n;
      for (let i = W - 1; i >= 0; i--) u = (u << 1n) | (model[bits[i]] === 1 ? 1n : 0n);
      out[v.val] = s64(u);
    }
    return out;
  }
}
