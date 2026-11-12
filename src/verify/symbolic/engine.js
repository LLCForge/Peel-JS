// Sembolik yürütücü: Babel AST üzerinde JS alt kümesi. Girdiler int32 (sext32 ile), sayılar 64 bit
// terimlerde tam tutulur; 2^53'ü aşabilecek her ara değer "desteklenmiyor" olur (double kesinliği).
// Yol çatallama (if/döngü), birleşme noktalarında ite ile birleştirme, döngü açma sınırı (BMC),
// durum patlaması sınırlayıcı ve isteğe bağlı artımlı kısıt deposuyla olanaksız yol budama.
import { parse } from '../../core/parse.js';
import { traverse } from '../../util/ast.js';
import { mk, bvConst, bvVar, TRUE, FALSE, and, or, not, termCounter } from '../solver/bv.js';
import { ConstraintStore } from '../solver/smt.js';

export class Unsupported extends Error {}
const fail = (msg) => { throw new Unsupported(msg); };

const MAX_BITS = 53;
const num = (t, bits) => (bits > MAX_BITS ? fail('kesinlik: değer 2^53 sınırını aşabilir') : { k: 'num', t, bits });
const bool = (t) => ({ k: 'bool', t });
const UNDEF = { k: 'undef', t: null };

function constBits(v) {
  const a = v < 0n ? -v : v;
  return a.toString(2).length + 1;
}

const toNum = (v) => {
  if (v.k === 'num') return v;
  if (v.k === 'bool') return num(mk('ite', v.t, bvConst(1), bvConst(0)), 2);
  return fail(v.k === 'undef' ? 'undefined sayıya çevriliyor (NaN)' : 'dallarda farklı tipte değer');
};
export const truthy = (v) => (v.k === 'bool' ? v.t : v.k === 'num' ? not(mk('eq', v.t, bvConst(0))) : v.k === 'undef' ? FALSE : fail('dallarda farklı tipte değer'));
const int32 = (v) => mk('sext32', toNum(v).t);
const amt = (v) => mk('and', int32(v), bvConst(31));

function iteVal(c, a, b) {
  if (a === b) return a;
  if (a.k !== b.k) return { k: 'conflict', t: null };
  if (a.k === 'undef' || a.k === 'conflict') return a;
  if (a.k === 'bool') return bool(mk('ite', c, a.t, b.t));
  return num(mk('ite', c, a.t, b.t), Math.max(a.bits, b.bits));
}

function binary(op, a, b) {
  switch (op) {
    case '+': { const x = toNum(a); const y = toNum(b); return num(mk('add', x.t, y.t), Math.max(x.bits, y.bits) + 1); }
    case '-': { const x = toNum(a); const y = toNum(b); return num(mk('sub', x.t, y.t), Math.max(x.bits, y.bits) + 1); }
    case '*': { const x = toNum(a); const y = toNum(b); return num(mk('mul', x.t, y.t), x.bits + y.bits); }
    case '&': return num(mk('and', int32(a), int32(b)), 32);
    case '|': return num(mk('or', int32(a), int32(b)), 32);
    case '^': return num(mk('xor', int32(a), int32(b)), 32);
    case '<<': return num(mk('sext32', mk('shl', int32(a), amt(b))), 32);
    case '>>': return num(mk('ashr', int32(a), amt(b)), 32);
    case '>>>': return num(mk('lshr', mk('zext32', toNum(a).t), amt(b)), 33);
    case '<': return bool(mk('slt', toNum(a).t, toNum(b).t));
    case '<=': return bool(mk('sle', toNum(a).t, toNum(b).t));
    case '>': return bool(mk('slt', toNum(b).t, toNum(a).t));
    case '>=': return bool(mk('sle', toNum(b).t, toNum(a).t));
    case '===': case '!==': {
      let e;
      if (a.k === 'conflict' || b.k === 'conflict') fail('dallarda farklı tipte değer');
      if (a.k !== b.k) e = FALSE;
      else if (a.k === 'undef') e = TRUE;
      else e = mk('eq', a.t, b.t);
      return bool(op === '===' ? e : not(e));
    }
    case '==': case '!=': {
      let e;
      if (a.k === 'undef' || b.k === 'undef') e = a.k === b.k ? TRUE : FALSE;
      else e = mk('eq', toNum(a).t, toNum(b).t);
      return bool(op === '==' ? e : not(e));
    }
    default: return fail(`desteklenmeyen işleç: ${op}`);
  }
}

const cloneState = (s) => ({ env: new Map(s.env), pc: s.pc, flow: s.flow, done: s.done, depth: s.depth });

/**
 * @param {object} fn Babel fonksiyon düğümü
 * @param {object} o
 * @param {number} [o.bound=8]       döngü açma sınırı (BMC)
 * @param {boolean} [o.merge=true]   birleşme noktalarında durumları ite ile birleştir
 * @param {boolean} [o.prune=false]  olanaksız yolları kısıt deposuyla buda
 * @param {number} [o.maxPaths=256] @param {number} [o.maxDepth=64] @param {number} [o.maxTerms=200000]
 * @param {(string|number)[]} [o.symbolic] sembolik parametreler (ad ya da sıra); varsayılan hepsi
 * @param {object} [o.concrete] somut parametre değerleri { ad: sayı|bool }
 * @param {object} [o.globals]  serbest adlar { ad: sayı|bool|'symbolic' }
 * @param {string} [o.prefix='arg'] sembolik girdi değişken adı öneki
 * @param {Map} [o.bind] parametreyi hazır motor değerine bağla (özellik denetimi)
 */
export function execute(fn, o = {}) {
  const opts = { bound: 8, merge: true, prune: false, maxPaths: 256, maxDepth: 64, maxTerms: 200_000, prefix: 'arg', ...o };
  const ctx = { forks: 0, merges: 0, pruned: 0, limited: null, termStart: termCounter(), store: opts.prune ? new ConstraintStore({ timeoutMs: 500, maxConflicts: 5000 }) : null };
  const inputs = [];
  const env = new Map();
  const params = fn.params.map((p, i) => {
    if (p.type !== 'Identifier') fail('yalnızca düz parametreler destekleniyor');
    const symbolic = !opts.symbolic || opts.symbolic.includes(p.name) || opts.symbolic.includes(i);
    if (opts.bind?.has(p.name)) env.set(p.name, opts.bind.get(p.name));
    else if (symbolic) {
      const name = `${opts.prefix}${i}`;
      inputs.push(name);
      env.set(p.name, num(mk('sext32', bvVar(name)), 32));
    } else {
      env.set(p.name, literal(opts.concrete?.[p.name]));
    }
    return p.name;
  });
  let live = 1;
  let doneCount = 0;

  function literal(v) {
    if (v === undefined) return UNDEF;
    if (typeof v === 'boolean') return bool(v ? TRUE : FALSE);
    if (!Number.isSafeInteger(v)) fail(`somut değer tam sayı değil: ${v}`);
    return num(bvConst(v), constBits(BigInt(v)));
  }

  function lookup(s, name) {
    if (s.env.has(name)) {
      const v = s.env.get(name);
      if (v.k === 'conflict') fail(`"${name}" dallarda farklı tipte`);
      return v;
    }
    if (name === 'undefined') return UNDEF;
    const g = opts.globals?.[name];
    if (g === 'symbolic') {
      const vn = `g_${name}`;
      if (!inputs.includes(vn)) inputs.push(vn);
      return num(mk('sext32', bvVar(vn)), 32);
    }
    if (g !== undefined) return literal(g);
    return fail(`tanımsız ad: ${name}`);
  }

  function assign(s, node, value) {
    if (node.type !== 'Identifier') fail('yalnızca değişkene atama destekleniyor');
    if (!s.env.has(node.name)) fail(`bildirilmemiş değişkene atama: ${node.name}`);
    s.env.set(node.name, value);
    return value;
  }

  function mergeEnv(c, sa, sb, s) {
    for (const k of new Set([...sa.env.keys(), ...sb.env.keys()])) {
      s.env.set(k, iteVal(c, sa.env.get(k) ?? UNDEF, sb.env.get(k) ?? UNDEF));
    }
  }

  // İfade değerlendirme durumu yerinde günceller; dallanan alt ifadeler ite ile birleşir
  function ev(s, n) {
    switch (n.type) {
      case 'NumericLiteral':
        if (!Number.isSafeInteger(n.value)) fail(`tam sayı olmayan sabit: ${n.value}`);
        return literal(n.value);
      case 'BooleanLiteral': return literal(n.value);
      case 'Identifier': return lookup(s, n.name);
      case 'ParenthesizedExpression': return ev(s, n.expression);
      case 'SequenceExpression': { let v = UNDEF; for (const e of n.expressions) v = ev(s, e); return v; }
      case 'UnaryExpression': {
        const v = ev(s, n.argument);
        if (n.operator === '-') { const x = toNum(v); return num(mk('neg', x.t), x.bits + 1); }
        if (n.operator === '+') return toNum(v);
        if (n.operator === '~') return num(mk('not', int32(v)), 32);
        if (n.operator === '!') return bool(not(truthy(v)));
        if (n.operator === 'void') return UNDEF;
        return fail(`desteklenmeyen tekli işleç: ${n.operator}`);
      }
      case 'BinaryExpression': { const a = ev(s, n.left); return binary(n.operator, a, ev(s, n.right)); }
      case 'LogicalExpression': {
        if (n.operator === '??') fail('?? desteklenmiyor');
        const a = ev(s, n.left);
        const c = truthy(a);
        const sb = cloneState(s);
        const b = ev(sb, n.right);
        const keep = n.operator === '&&' ? not(c) : c;
        const sa = cloneState(s);
        mergeEnv(keep, sa, sb, s);
        return iteVal(keep, a, b);
      }
      case 'ConditionalExpression': {
        const c = truthy(ev(s, n.test));
        const sa = cloneState(s);
        const a = ev(sa, n.consequent);
        const sb = cloneState(s);
        const b = ev(sb, n.alternate);
        mergeEnv(c, sa, sb, s);
        return iteVal(c, a, b);
      }
      case 'AssignmentExpression': {
        if (n.operator === '=') return assign(s, n.left, ev(s, n.right));
        const op = n.operator.slice(0, -1);
        if (['&&', '||', '??'].includes(op)) fail(`desteklenmeyen atama: ${n.operator}`);
        const cur = ev(s, n.left);
        return assign(s, n.left, binary(op, cur, ev(s, n.right)));
      }
      case 'UpdateExpression': {
        const cur = toNum(ev(s, n.argument));
        const next = binary(n.operator === '++' ? '+' : '-', cur, literal(1));
        assign(s, n.argument, next);
        return n.prefix ? next : cur;
      }
      case 'CallExpression': {
        const c = n.callee;
        if (c.type === 'MemberExpression' && !c.computed && c.object.name === 'Math' && c.property.name === 'imul' && n.arguments.length === 2) {
          const a = ev(s, n.arguments[0]);
          const b = ev(s, n.arguments[1]);
          return num(mk('sext32', mk('mul', int32(a), int32(b))), 32);
        }
        return fail('fonksiyon çağrısı desteklenmiyor');
      }
      default: return fail(`desteklenmeyen ifade: ${n.type}`);
    }
  }

  function finish(s, kind, value = UNDEF) {
    s.done = { kind, value };
    doneCount++;
    live--;
    return [s];
  }

  // E737: sınır aşılırsa yol "limit" olarak kapanır (bırakmak sağlam olmazdı)
  function fork(s, c) {
    if (c === TRUE) return [s, null];
    if (c === FALSE) return [null, s];
    const limit = live + doneCount + 1 > opts.maxPaths ? `yol sınırı (${opts.maxPaths})`
      : s.depth + 1 > opts.maxDepth ? `derinlik sınırı (${opts.maxDepth})`
        : termCounter() - ctx.termStart > opts.maxTerms ? `terim sınırı (${opts.maxTerms})` : null;
    if (limit) {
      ctx.limited ??= limit;
      finish(s, 'limit');
      return [null, s];
    }
    let t = cloneState(s);
    let f = s;
    t.pc = and(s.pc, c);
    f.pc = and(s.pc, not(c));
    t.depth = f.depth = s.depth + 1;
    if (ctx.store) {
      if (ctx.store.feasible(t.pc) === 'unsat') { ctx.pruned++; t = null; }
      else if (ctx.store.feasible(f.pc) === 'unsat') { ctx.pruned++; f = null; }
    }
    if (t && f) { ctx.forks++; live++; }
    return [t, f];
  }

  // E736: aynı akış durumundaki canlı durumlar tek duruma birleşir
  function merge(states) {
    if (!opts.merge) return states;
    const groups = new Map();
    const out = [];
    for (const s of states) {
      if (s.done) { out.push(s); continue; }
      const key = s.flow ?? '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    }
    for (const list of groups.values()) {
      let acc = list[0];
      for (const s of list.slice(1)) {
        const m = { env: new Map(), pc: or(acc.pc, s.pc), flow: acc.flow, done: null, depth: Math.max(acc.depth, s.depth) };
        mergeEnv(s.pc, s, acc, m);
        acc = m;
        ctx.merges++;
        live--;
      }
      out.push(acc);
    }
    return out;
  }

  function stmts(list, states) {
    for (const node of list) {
      states = states.flatMap((s) => (s.done || s.flow ? [s] : stmt(node, s)));
    }
    return states;
  }

  // let/const blok kapsamı: blok sonunda gölgelenen dış bağlar geri yüklenir
  function scoped(names, states, run) {
    const outer = new Map(names.map((k) => [k, states[0].env.get(k)]));
    const res = run();
    for (const s of res) {
      for (const k of names) {
        if (outer.get(k) === undefined) s.env.delete(k);
        else s.env.set(k, outer.get(k));
      }
    }
    return res;
  }

  const blockNames = (body) => body.flatMap((x) => (x.type === 'VariableDeclaration' && x.kind !== 'var' ? x.declarations.map((d) => d.id.name) : []));

  function loop(n, s) {
    const isDo = n.type === 'DoWhileStatement';
    if (n.type === 'ForStatement' && n.init) {
      if (n.init.type === 'VariableDeclaration') stmt(n.init, s);
      else ev(s, n.init);
    }
    let cur = [s];
    const out = [];
    for (let iter = 0; ; iter++) {
      if (!isDo || iter > 0) {
        const next = [];
        for (const st of cur) {
          const c = n.test ? truthy(ev(st, n.test)) : TRUE;
          const [t, f] = fork(st, c);
          if (f) out.push(f);
          if (t) next.push(t);
        }
        cur = next;
      }
      if (!cur.length) break;
      if (iter >= opts.bound) {
        for (const st of cur) finish(st, 'bound');
        out.push(...cur);
        break;
      }
      const res = stmts([n.body], cur);
      cur = [];
      for (const r of res) {
        if (r.done) out.push(r);
        else if (r.flow === 'break') { r.flow = null; out.push(r); }
        else { r.flow = null; cur.push(r); }
      }
      if (n.type === 'ForStatement' && n.update) for (const st of cur) ev(st, n.update);
      cur = merge(cur);
    }
    return merge(out);
  }

  function stmt(n, s) {
    switch (n.type) {
      case 'EmptyStatement': return [s];
      case 'ExpressionStatement': ev(s, n.expression); return [s];
      case 'VariableDeclaration':
        for (const d of n.declarations) {
          if (d.id.type !== 'Identifier') fail('yapı bozumu desteklenmiyor');
          s.env.set(d.id.name, d.init ? ev(s, d.init) : UNDEF);
        }
        return [s];
      case 'BlockStatement': {
        const names = blockNames(n.body);
        return names.length ? scoped(names, [s], () => stmts(n.body, [s])) : stmts(n.body, [s]);
      }
      case 'IfStatement': {
        const [t, f] = fork(s, truthy(ev(s, n.test)));
        const a = t ? stmts([n.consequent], [t]) : [];
        const b = f ? (n.alternate ? stmts([n.alternate], [f]) : [f]) : [];
        return merge([...a, ...b]);
      }
      case 'ReturnStatement': return finish(s, 'return', n.argument ? ev(s, n.argument) : UNDEF);
      case 'ThrowStatement': ev(s, n.argument); return finish(s, 'throw');
      case 'BreakStatement': case 'ContinueStatement':
        if (n.label) fail('etiketli break/continue desteklenmiyor');
        s.flow = n.type === 'BreakStatement' ? 'break' : 'continue';
        return [s];
      case 'WhileStatement': case 'DoWhileStatement': return loop(n, s);
      case 'ForStatement': {
        const names = n.init?.type === 'VariableDeclaration' && n.init.kind !== 'var' ? n.init.declarations.map((d) => d.id.name) : [];
        return names.length ? scoped(names, [s], () => loop(n, s)) : loop(n, s);
      }
      default: return fail(`desteklenmeyen deyim: ${n.type}`);
    }
  }

  const start = { env, pc: TRUE, flow: null, done: null, depth: 0 };
  const body = fn.body.type === 'BlockStatement' ? fn.body.body : [{ type: 'ReturnStatement', argument: fn.body }];
  const end = stmts(body, [start]);
  for (const s of end) if (!s.done) finish(s, 'return');
  return { params, inputs, outcomes: end.map((s) => ({ kind: s.done.kind, pc: s.pc, value: s.done.value })), forks: ctx.forks, merges: ctx.merges, pruned: ctx.pruned, limited: ctx.limited, store: ctx.store?.stats ?? null };
}

// Kaynaktaki ilk fonksiyon düğümü (bildirim, ifade ya da ok)
export function firstFunction(src) {
  const ast = parse(src);
  let found = null;
  traverse(ast, {
    Function(p) {
      if (!found) found = p.node;
      p.stop();
    },
  });
  if (!found) fail('kaynakta fonksiyon yok');
  if (found.async || found.generator) fail('async/generator desteklenmiyor');
  return found;
}

// Tag kodları: sonuç sınıfı (dönüş tipi / throw / sınır) ve değer, eşdeğerlik karşılaştırması için
export const TAG = { num: 0, bool: 1, undef: 2, throw: 3, bound: 4, limit: 5 };

export function encodeResult(outcomes) {
  let tag = bvConst(TAG.limit);
  let val = bvConst(0);
  for (const o of [...outcomes].reverse()) {
    const kind = o.kind === 'return' ? (o.value.k === 'conflict' ? fail('dönüş değeri dallarda farklı tipte') : o.value.k) : o.kind;
    const v = kind === 'num' ? o.value.t : kind === 'bool' ? mk('ite', o.value.t, bvConst(1), bvConst(0)) : bvConst(0);
    tag = mk('ite', o.pc, bvConst(TAG[kind]), tag);
    val = mk('ite', o.pc, v, val);
  }
  return { tag, val };
}
