import * as t from '@babel/types';
import { traverse, gen } from '../util/ast.js';
import { literalOf } from '../util/literal.js';

// Durum makinesini düz koda çevirir.
//
//   while (P + Q !== -1) { switch (P + Q) { case 0: a(); P += 2; break; case 2: … } }
//
// Makine somut durum değerleriyle adım adım yürütülür: her adımda hangi case'e gidildiği hesaplanır,
// case gövdesi çıktıya yazılır, durum güncellemeleri (P += 2) yalnızca iç durumda uygulanır ve
// gövdedeki durum okumaları o anki sabit değerle değiştirilir. Durumdan bağımsız bir koşul (if (x))
// iki yolu da ayrı ayrı yürütülerek gerçek bir if/else'e dönüşür.
// shortcut: aynı (durum, case) bir yolda tekrar ederse makine gerçek bir döngü içeriyordur ve dokunulmaz;
// döngüleri while'a geri kurmak (yol haritası E165/E28) eklenene kadar böyle kalır.

const MAX_STEPS = 4000;      // tüm yollar boyunca toplam dispatch adımı
const MAX_OUTPUT = 400_000;  // üretilen kodun karakter sınırı (dal kopyalama patlamasına karşı)
const MAX_CLONES = 200;

class Unsupported extends Error {}
const fail = (why) => { throw new Unsupported(why); };

// ── yapı tanıma ─────────────────────────────────────────

function isAlwaysTrue(n) {
  return t.isBooleanLiteral(n, { value: true }) || (t.isNumericLiteral(n) && n.value !== 0) ||
    (t.isUnaryExpression(n, { operator: '!' }) && t.isUnaryExpression(n.argument, { operator: '!' }) && t.isArrayExpression(n.argument.argument));
}

// js-confuser: function sum(a) { for (var s = 0, i = 0; i < a.length; i++) { s += a[i]; } return s; }
function isSumFunction(fn) {
  if (!fn || fn.params.length !== 1 || !t.isIdentifier(fn.params[0])) return false;
  const src = gen(fn.body).replace(/\s+/g, '');
  const a = fn.params[0].name.replace(/\$/g, '\\$');
  return new RegExp(`^\\{for\\(var([\\w$]+)=0,([\\w$]+)=0;\\2<${a}(\\.length|\\["length"\\]);\\2\\+\\+\\)\\{?\\1\\+=${a}\\[\\2\\];?\\}?return\\1;?\\}$`).test(src);
}

// while gövdesi: [ (__peelS = E;)?, switch ]  — with/etiket desteklenmez (dinamik kapsam)
function machineOf(loop) {
  if (!t.isWhileStatement(loop)) return null;
  const body = t.isBlockStatement(loop.body) ? loop.body.body : [loop.body];
  let pre = null;
  let sw = null;
  if (body.length === 1 && t.isSwitchStatement(body[0])) sw = body[0];
  else if (body.length === 2 && t.isSwitchStatement(body[1]) && t.isExpressionStatement(body[0]) &&
    t.isAssignmentExpression(body[0].expression, { operator: '=' }) && t.isIdentifier(body[0].expression.left) &&
    t.isIdentifier(body[1].discriminant, { name: body[0].expression.left.name })) {
    pre = body[0].expression;
    sw = body[1];
  }
  if (!sw || sw.cases.length < 2) return null;
  return { loop, sw, disc: pre ? pre.right : sw.discriminant, preName: pre?.left.name ?? null };
}

// ── durum ve değerlendirme ──────────────────────────────

class State {
  constructor(vars = new Map(), arrays = new Map()) { this.vars = vars; this.arrays = arrays; }
  clone() { return new State(new Map(this.vars), new Map([...this.arrays].map(([k, v]) => [k, v.slice()]))); }
  key() { return JSON.stringify([[...this.vars], [...this.arrays]]); }
}

function makeEval(m) {
  const isSum = (n) => t.isCallExpression(n) && t.isIdentifier(n.callee) && m.sumFns.has(n.callee.name) &&
    n.arguments.length === 1 && t.isIdentifier(n.arguments[0]) && m.arrays.has(n.arguments[0].name);

  function ev(n, S) {
    if (t.isNumericLiteral(n) || t.isStringLiteral(n) || t.isBooleanLiteral(n)) return n.value;
    if (t.isParenthesizedExpression(n)) return ev(n.expression, S);
    if (t.isIdentifier(n) && m.vars.has(n.name)) return S.vars.get(n.name);
    if (t.isMemberExpression(n) && n.computed && t.isIdentifier(n.object) && m.arrays.has(n.object.name)) {
      const arr = S.arrays.get(n.object.name);
      const i = ev(n.property, S);
      if (!Number.isInteger(i) || i < 0 || i >= arr.length) fail('dizi indeksi');
      return arr[i];
    }
    if (isSum(n)) return S.arrays.get(n.arguments[0].name).reduce((a, b) => a + b, 0);
    if (t.isUnaryExpression(n)) {
      const v = ev(n.argument, S);
      switch (n.operator) {
        case '-': return -v;
        case '+': return +v;
        case '!': return !v;
        case '~': return ~v;
        default: fail('tekli işleç');
      }
    }
    if (t.isBinaryExpression(n)) {
      const a = ev(n.left, S);
      const b = ev(n.right, S);
      switch (n.operator) {
        case '+': return a + b; case '-': return a - b; case '*': return a * b; case '/': return a / b;
        case '%': return a % b; case '|': return a | b; case '&': return a & b; case '^': return a ^ b;
        case '<<': return a << b; case '>>': return a >> b; case '>>>': return a >>> b;
        case '===': return a === b; case '!==': return a !== b; case '==': return a == b; case '!=': return a != b; // eslint-disable-line eqeqeq
        case '<': return a < b; case '>': return a > b; case '<=': return a <= b; case '>=': return a >= b;
        default: fail('ikili işleç');
      }
    }
    if (t.isLogicalExpression(n)) {
      const a = ev(n.left, S);
      if (n.operator === '&&') return a && ev(n.right, S);
      if (n.operator === '||') return a || ev(n.right, S);
      return a ?? ev(n.right, S);
    }
    if (t.isConditionalExpression(n)) return ev(n.test, S) ? ev(n.consequent, S) : ev(n.alternate, S);
    return fail('değerlendirilemeyen ifade');
  }
  return { ev, isSum };
}

// Düğüm durum okuyor/yazıyor mu? (iç fonksiyonda durum referansı = closure: desteklenmez)
function scanState(node, m) {
  let reads = false;
  let writes = false;
  const isLoc = (n) => (t.isIdentifier(n) && m.vars.has(n.name)) ||
    (t.isMemberExpression(n) && t.isIdentifier(n.object) && m.arrays.has(n.object.name));
  const walk = (n, inFn, parent, key) => {
    if (!n || typeof n !== 'object') return;
    if (t.isIdentifier(n) && (m.vars.has(n.name) || m.arrays.has(n.name))) {
      const isProp = (t.isMemberExpression(parent) && key === 'property' && !parent.computed) ||
        (t.isObjectProperty(parent) && key === 'key' && !parent.computed);
      if (!isProp) {
        if (inFn) fail('iç fonksiyonda durum referansı');
        // dizi durumunun kendisi yalnızca A[i] ya da sum(A) içinde kullanılabilir
        if (m.arrays.has(n.name) && !(t.isMemberExpression(parent) && key === 'object' && parent.computed) &&
            !(t.isCallExpression(parent) && key === 'arguments' && t.isIdentifier(parent.callee) && m.sumFns.has(parent.callee.name))) {
          fail('durum dizisi başka biçimde kullanılıyor');
        }
        reads = true;
      }
    }
    if ((t.isAssignmentExpression(n) && isLoc(n.left)) || (t.isUpdateExpression(n) && isLoc(n.argument))) writes = true;
    if ((t.isVariableDeclarator(n) || t.isFunctionDeclaration(n) || t.isClassDeclaration(n) || t.isCatchClause(n)) &&
        Object.keys(t.getBindingIdentifiers(n.id ?? n.param ?? n)).some((k) => m.vars.has(k) || m.arrays.has(k))) {
      fail('durum adı gölgeleniyor');
    }
    const fnNow = inFn || t.isFunction(n);
    for (const k of t.VISITOR_KEYS[n.type] ?? []) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach((c) => walk(c, fnNow, n, k)); else walk(v, fnNow, n, k);
    }
  };
  walk(node, false, null, null);
  return { reads, writes };
}

// Durum okumalarını sabit değerle değiştirerek kopyalar
function substitute(node, S, m, E) {
  const copy = t.cloneNode(node, true);
  const replace = (n) => {
    if (!n || typeof n !== 'object') return n;
    if ((t.isIdentifier(n) && m.vars.has(n.name)) ||
        (t.isMemberExpression(n) && n.computed && t.isIdentifier(n.object) && m.arrays.has(n.object.name)) || E.isSum(n)) {
      const lit = literalOf(t, E.ev(n, S));
      if (!lit) fail('sabite çevrilemeyen durum');
      return lit;
    }
    for (const k of t.VISITOR_KEYS[n.type] ?? []) {
      // nokta erişimindeki özellik adı ve obje anahtarı değer değil, isimdir
      if ((t.isMemberExpression(n) && k === 'property' && !n.computed) || (t.isObjectProperty(n) && k === 'key' && !n.computed)) continue;
      const v = n[k];
      if (Array.isArray(v)) n[k] = v.map(replace); else n[k] = replace(v);
    }
    return n;
  };
  return replace(copy);
}

// Makineyi hedefleyen (etiketsiz, kendi döngü/switch'i içinde olmayan) break/continue var mı?
function hasMachineJump(node) {
  let found = false;
  const walk = (n, nested) => {
    if (!n || typeof n !== 'object' || found || t.isFunction(n)) return;
    if ((t.isBreakStatement(n) || t.isContinueStatement(n)) && (n.label || !nested)) { found = true; return; }
    const inner = nested || t.isLoop(n) || t.isSwitchStatement(n);
    for (const k of t.VISITOR_KEYS[n.type] ?? []) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach((c) => walk(c, inner)); else walk(v, inner);
    }
  };
  walk(node, false);
  return found;
}

// ── yorumlayıcı ─────────────────────────────────────────

function unflatten(m, S0) {
  const E = makeEval(m);
  const budget = { steps: 0, size: 0 };

  const applyUpdate = (n, S) => {
    const target = t.isAssignmentExpression(n) ? n.left : n.argument;
    const read = () => E.ev(target, S);
    let value;
    if (t.isUpdateExpression(n)) value = n.operator === '++' ? read() + 1 : read() - 1;
    else {
      const rhs = E.ev(n.right, S);
      const op = n.operator;
      if (op === '=') value = rhs;
      else {
        const cur = read();
        const bin = op.slice(0, -1);
        value = E.ev(t.binaryExpression(bin, t.valueToNode(cur), t.valueToNode(rhs)), S);
      }
    }
    if (t.isIdentifier(target)) S.vars.set(target.name, value);
    else {
      const arr = S.arrays.get(target.object.name);
      const i = E.ev(target.property, S);
      if (!Number.isInteger(i) || i < 0 || i >= arr.length) fail('dizi yazma indeksi');
      arr[i] = value;
    }
  };

  // ifade deyimi: durum güncellemeleri uygulanır, geri kalanı sabitlenmiş haliyle yazılır
  const expression = (e, S, out) => {
    if (t.isSequenceExpression(e)) { e.expressions.forEach((x) => expression(x, S, out)); return; }
    const isLoc = (x) => (t.isIdentifier(x) && m.vars.has(x.name)) ||
      (t.isMemberExpression(x) && t.isIdentifier(x.object) && m.arrays.has(x.object.name));
    if ((t.isAssignmentExpression(e) && isLoc(e.left)) || (t.isUpdateExpression(e) && isLoc(e.argument))) {
      applyUpdate(e, S);
      return;
    }
    if (t.isIdentifier(e, { name: m.preName })) return;
    if (t.isAssignmentExpression(e) && t.isIdentifier(e.left, { name: m.preName })) return;
    if (scanState(e, m).writes) fail('iç içe durum yazma');
    out.push(t.expressionStatement(substitute(e, S, m, E)));
  };

  const casesFrom = (S) => {
    const d = E.ev(m.disc, S);
    let idx = m.sw.cases.findIndex((c) => c.test && E.ev(c.test, S) === d);
    if (idx < 0) idx = m.sw.cases.findIndex((c) => !c.test);
    if (idx < 0) fail('eşleşen case yok');
    return m.sw.cases.slice(idx).flatMap((c) => c.consequent);
  };

  function iterate(S, path) {
    if (++budget.steps > MAX_STEPS) fail('adım bütçesi aşıldı');
    if (!isAlwaysTrue(m.loop.test) && !E.ev(m.loop.test, S)) return [];
    const key = `${E.ev(m.disc, S)}|${S.key()}`;
    if (path.has(key)) fail('döngü (aynı durum tekrar etti)');
    const next = new Set(path).add(key);
    return exec(casesFrom(S), S, next);
  }

  function exec(list, S, path) {
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (t.isBreakStatement(s) || t.isContinueStatement(s)) {
        if (s.label) fail('etiketli atlama');
        return out.concat(iterate(S, path));
      }
      if (t.isEmptyStatement(s)) continue;
      if (t.isReturnStatement(s) || t.isThrowStatement(s)) {
        if (scanState(s, m).writes) fail('dönüşte durum yazma');
        out.push(substitute(s, S, m, E));
        return out;
      }
      if (t.isExpressionStatement(s)) { expression(s.expression, S, out); continue; }
      if (t.isBlockStatement(s)) {
        if (s.body.some((x) => t.isVariableDeclaration(x) && x.kind !== 'var')) fail('blok içi let/const');
        list = [...s.body, ...list.slice(i + 1)];
        i = -1;
        continue;
      }
      if (t.isIfStatement(s)) {
        const branch = (b) => (!b ? [] : t.isBlockStatement(b) ? b.body : [b]);
        const rest = list.slice(i + 1);
        let value;
        let known = true;
        try { value = E.ev(s.test, S); } catch (e) { if (!(e instanceof Unsupported)) throw e; known = false; }
        if (known) {
          list = [...branch(value ? s.consequent : s.alternate), ...rest];
          i = -1;
          continue;
        }
        if (scanState(s.test, m).writes) fail('koşulda durum yazma');
        const test = substitute(s.test, S, m, E);
        const yes = exec([...branch(s.consequent), ...rest], S.clone(), path);
        const no = exec([...branch(s.alternate), ...rest], S.clone(), path);
        out.push(t.ifStatement(test, t.blockStatement(yes), no.length ? t.blockStatement(no) : null));
        return out;
      }
      if (t.isVariableDeclaration(s)) {
        if (s.kind !== 'var') fail('case içi let/const');
        if (scanState(s, m).writes) fail('bildirimde durum yazma');
        out.push(substitute(s, S, m, E));
        continue;
      }
      if (t.isFunctionDeclaration(s) || t.isClassDeclaration(s)) fail('case içi bildirim');
      // döngü, try, switch… : makineye atlamıyor ve durum yazmıyorsa olduğu gibi (sabitlenmiş) yazılır
      if (hasMachineJump(s)) fail('iç deyimden makineye atlama');
      if (scanState(s, m).writes) fail('iç deyimde durum yazma');
      out.push(substitute(s, S, m, E));
    }
    // switch'in sonuna düşüldü: döngünün bir sonraki turu
    return out.concat(iterate(S, path));
  }

  const result = iterate(S0, new Set());
  budget.size = gen(t.blockStatement(result)).length;
  if (budget.size > MAX_OUTPUT) fail('çıktı çok büyük');
  return result;
}

// ── sürücüler ───────────────────────────────────────────

function collectSumFns(ast) {
  const sumFns = new Set();
  traverse(ast, {
    FunctionDeclaration(p) { if (p.node.id && isSumFunction(p.node)) sumFns.add(p.node.id.name); },
  });
  return sumFns;
}

// Değişkenli makine: P = 0, Q = 0 sabit başlangıçlı yerel değişkenler, yalnızca döngü içinde değişiyor
function identifierMachine(p, mach, sumFns, onLog) {
  const names = new Set();
  const collect = (n, parent, key) => {
    if (!n || typeof n !== 'object') return;
    if (t.isIdentifier(n) && !(t.isMemberExpression(parent) && key === 'property' && !parent.computed) &&
        !(t.isCallExpression(parent) && key === 'callee')) names.add(n.name);
    for (const k of t.VISITOR_KEYS[n.type] ?? []) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach((c) => collect(c, n, k)); else collect(v, n, k);
    }
  };
  collect(mach.disc, null, null);
  if (!names.size) return false;

  const vars = new Map();
  for (const name of names) {
    const b = p.scope.getBinding(name);
    if (!b?.path.isVariableDeclarator()) return false;
    const init = b.path.node.init;
    const v = t.isNumericLiteral(init) ? init.value
      : t.isUnaryExpression(init, { operator: '-' }) && t.isNumericLiteral(init.argument) ? -init.argument.value : null;
    if (v === null) return false;
    const decl = b.path.parentPath;
    if (decl.parentPath !== p.parentPath || decl.key >= p.key) return false; // aynı blokta, döngüden önce
    const inLoop = (x) => x.findParent((y) => y === p);
    if (!b.constantViolations.every(inLoop) || !b.referencePaths.every(inLoop)) return false;
    vars.set(name, v);
  }
  if (mach.preName) {
    const pb = p.scope.getBinding(mach.preName);
    if (pb && !pb.referencePaths.every((x) => x.findParent((y) => y === p))) return false;
  }

  const m = { ...mach, vars: new Set(vars.keys()), arrays: new Set(), sumFns };
  try {
    const out = unflatten(m, new State(new Map(vars)));
    if (Array.isArray(p.container)) {
      if (out.length) p.replaceWithMultiple(out); else p.remove();
    } else {
      p.replaceWith(t.blockStatement(out));
    }
    onLog(`unflatten: ${[...vars.keys()].join('+')} durum makinesi düz koda çevrildi`, 'info');
    return true;
  } catch (e) {
    if (!(e instanceof Unsupported)) throw e;
    onLog(`unflatten: makine açılamadı (${e.message})`, 'warn');
    return false;
  }
}

// js-confuser 2.x: function main(states, scope = {...}) { while (sum(states) !== N) switch (sum(states)) {...} }
// Başlangıç dizisi çağrı yerinde oluşur; sandbox'ta çağrı başına gözlenir ve her farklı başlangıç için
// makinesi açılmış bir kopya fonksiyon üretilir.
async function arrayMachines(ast, sumFns, { sandbox, onLog }) {
  const targets = [];
  traverse(ast, {
    FunctionDeclaration(p) {
      const body = p.node.body.body;
      if (!p.node.id || body.length !== 1) return;
      const mach = machineOf(body[0]);
      if (!mach || !t.isCallExpression(mach.disc) || !t.isIdentifier(mach.disc.callee) || !sumFns.has(mach.disc.callee.name)) return;
      const arg = mach.disc.arguments[0];
      const pi = p.node.params.findIndex((x) => t.isIdentifier(x, { name: arg?.name }));
      if (pi < 0) return;
      const b = p.parentPath.scope.getBinding(p.node.id.name);
      if (!b) return;
      const calls = b.referencePaths.map((r) => r.parentPath);
      if (!calls.every((c, i) => c.isCallExpression({ callee: b.referencePaths[i].node }) && c.node.arguments.length > pi &&
          !c.node.arguments.some((a) => t.isSpreadElement(a)))) return;
      targets.push({ p, mach, pi, arrayName: arg.name, calls });
    },
  });
  if (!targets.length || !sandbox) return 0;

  // başlangıç dizilerini gözle: main(X) → main(__peelInit(k, X))
  const saved = [];
  let site = 0;
  for (const tg of targets) {
    tg.sites = tg.calls.map((c) => {
      const k = site++;
      saved.push([c.node, c.node.arguments[tg.pi]]);
      c.node.arguments[tg.pi] = t.callExpression(t.identifier('__peelInit'), [t.numericLiteral(k), c.node.arguments[tg.pi]]);
      return k;
    });
  }
  const code = gen(ast);
  for (const [node, arg] of saved) {
    const i = node.arguments.findIndex((a) => t.isCallExpression(a) && t.isIdentifier(a.callee, { name: '__peelInit' }));
    node.arguments[i] = arg;
  }
  const prelude = `var __peelInits = {};
function __peelInit(k, v) {
  var s = Array.isArray(v) && v.every(function (x) { return typeof x === "number"; }) ? JSON.stringify(v) : null;
  if (!(k in __peelInits)) __peelInits[k] = s; else if (__peelInits[k] !== s) __peelInits[k] = null;
  return v;
}`;
  const r = await sandbox.run(`${prelude}\ntry {\n${code}\n} catch (e) {}\n__res.push(__peelInits);`, { timeoutMs: 8000 });
  const inits = r.res?.[0] ?? {};

  let made = 0;
  for (const tg of targets) {
    const m = { ...tg.mach, vars: new Set(), arrays: new Set([tg.arrayName]), sumFns };
    const clones = new Map();
    let converted = 0;
    tg.calls.forEach((c, i) => {
      const json = inits[tg.sites[i]];
      if (typeof json !== 'string' || clones.size >= MAX_CLONES) return;
      let name = clones.get(json);
      if (name === undefined) {
        try {
          const body = unflatten(m, new State(new Map(), new Map([[tg.arrayName, JSON.parse(json)]])));
          name = tg.p.scope.generateUid(`${tg.p.node.id.name}_${clones.size}`);
          const fn = t.cloneNode(tg.p.node, true);
          fn.id = t.identifier(name);
          fn.body = t.blockStatement(body);
          tg.p.insertAfter(fn);
          made++;
        } catch (e) {
          if (!(e instanceof Unsupported)) throw e;
          onLog(`unflatten: ${tg.p.node.id.name} başlangıcı açılamadı (${e.message})`, 'warn');
          name = null;
        }
        clones.set(json, name);
      }
      if (!name) return;
      c.node.callee = t.identifier(name);
      converted++;
    });
    if (converted) onLog(`unflatten: ${tg.p.node.id.name} — ${converted}/${tg.calls.length} çağrı düz koda çevrilmiş kopyaya bağlandı (başlangıç durumu çalışma anında gözlendi)`, 'info');
    tg.p.scope.crawl();
    const b = tg.p.parentPath.scope.getBinding(tg.p.node.id.name);
    if (b && !b.referencePaths.some((x) => !x.findParent((y) => y === tg.p))) tg.p.remove();
  }
  return made;
}

export async function run(ast, { onLog, bump, sandbox }) {
  const sumFns = collectSumFns(ast);
  let n = 0;
  traverse(ast, {
    WhileStatement: {
      exit(p) {
        const mach = machineOf(p.node);
        if (!mach) return;
        if (p.findParent((x) => x.isWithStatement())) return;
        if (identifierMachine(p, mach, sumFns, onLog)) n++;
      },
    },
  });
  n += await arrayMachines(ast, sumFns, { sandbox, onLog });
  bump('unflatten', n);
}
