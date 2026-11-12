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
// Aynı (durum, case) bir yolda tekrar ederse orası gerçek bir döngünün başıdır: etiketli while(true)
// ile sarılır, geri dönüşler continue, makineden çıkan yollar break olur.

const MAX_STEPS = 20000;     // tüm yollar ve izlemeler boyunca toplam dispatch adımı
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

// Döngü gövdesi: [ (__peelS = E;)?, switch ]  — with desteklenmez (dinamik kapsam)
// E158: do { switch } while (T)  — ilk turda test yok
// E159: for (init; T; U) { switch }  — her yeni turdan önce U, sonra T
// E160: etiketli makine — `break L` makineden çıkar, `continue L` yeni tura geçer
function machineOf(loop, label = null) {
  if (!t.isWhileStatement(loop) && !t.isDoWhileStatement(loop) && !t.isForStatement(loop)) return null;
  if (t.isForStatement(loop) && loop.init && !t.isVariableDeclaration(loop.init, { kind: 'var' }) && !t.isExpression(loop.init)) return null;
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
  if (!sw || !sw.cases.length) return null;
  return {
    loop, sw, disc: pre ? pre.right : sw.discriminant, preName: pre?.left.name ?? null,
    test: loop.test ?? null, doWhile: t.isDoWhileStatement(loop), update: t.isForStatement(loop) ? loop.update : null,
    label,
  };
}

// Makineyi bulunduğu yerden çıkarırken değiştirilecek düğüm (etiketliyse etiket) ve for başlangıcı
const machineTarget = (p) => (p.parentPath.isLabeledStatement() ? p.parentPath : p);
const labelOf = (p) => (p.parentPath.isLabeledStatement() ? p.parentPath.node.label.name : null);
const forInit = (loop) => (!t.isForStatement(loop) || !loop.init ? [] : t.isVariableDeclaration(loop.init) ? [loop.init] : [t.expressionStatement(loop.init)]);

// ── durum ve değerlendirme ──────────────────────────────

class State {
  constructor(vars = new Map(), arrays = new Map()) { this.vars = vars; this.arrays = arrays; }
  clone() { return new State(new Map(this.vars), new Map([...this.arrays].map(([k, v]) => [k, v.slice()]))); }
  key() { return JSON.stringify([[...this.vars], [...this.arrays]]); }
}

// Durum konumunun adı: P, states ya da scope.X.Y (js-confuser iç fonksiyon makineleri durumu kapsam nesnesinde tutar)
function pathOf(n) {
  if (t.isIdentifier(n)) return n.name;
  if (t.isMemberExpression(n) && !n.computed && t.isIdentifier(n.property)) {
    const base = pathOf(n.object);
    return base && `${base}.${n.property.name}`;
  }
  return null;
}
const rootOf = (path) => path.split('.')[0];

// Düğüm bir durum dizisinin elemanı mı? (A[i], scope.X.Y[i])
const isArrayElem = (n, m) => t.isMemberExpression(n) && n.computed && m.arrays.has(pathOf(n.object));

function makeEval(m) {
  const isSum = (n) => t.isCallExpression(n) && t.isIdentifier(n.callee) && m.sumFns.has(n.callee.name) &&
    n.arguments.length === 1 && m.arrays.has(pathOf(n.arguments[0]));

  function ev(n, S) {
    if (t.isNumericLiteral(n) || t.isStringLiteral(n) || t.isBooleanLiteral(n)) return n.value;
    if (t.isParenthesizedExpression(n)) return ev(n.expression, S);
    if (t.isIdentifier(n) && m.vars.has(n.name)) return S.vars.get(n.name);
    if (isArrayElem(n, m)) {
      const arr = S.arrays.get(pathOf(n.object));
      const i = ev(n.property, S);
      if (!Number.isInteger(i) || i < 0 || i >= arr.length) fail('dizi indeksi');
      return arr[i];
    }
    if (isSum(n)) return S.arrays.get(pathOf(n.arguments[0])).reduce((a, b) => a + b, 0);
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

const isLocation = (n, m) => (t.isIdentifier(n) && m.vars.has(n.name)) || isArrayElem(n, m) ||
  m.arrays.has(pathOf(n));

// Düğüm durum okuyor/yazıyor mu? İç fonksiyondaki okuma closure demektir: o makinede durum güncellemeleri
// gerçekten yazılır (m.live), böylece closure sonradan çağrılsa da orijinaldeki değeri görür.
function scanState(node, m) {
  let reads = false;
  let writes = false;
  const roots = new Set([...m.vars, ...[...m.arrays].map(rootOf)]);
  const walk = (n, inFn, parent, key) => {
    if (!n || typeof n !== 'object') return;
    const isName = (t.isMemberExpression(parent) && key === 'property' && !parent.computed) ||
      (t.isObjectProperty(parent) && key === 'key' && !parent.computed);
    const p = !isName && (t.isIdentifier(n) || t.isMemberExpression(n)) ? pathOf(n) : null;
    if (p && (m.vars.has(p) || m.arrays.has(p))) {
      if (inFn) m.live = true;
      // dizi durumunun kendisi yalnızca A[i] ya da sum(A) içinde kullanılabilir
      if (m.arrays.has(p) && !(t.isMemberExpression(parent) && key === 'object' && parent.computed) &&
          !(t.isCallExpression(parent) && key === 'arguments' && t.isIdentifier(parent.callee) && m.sumFns.has(parent.callee.name))) {
        fail(`durum dizisi başka biçimde kullanılıyor: ${gen(parent).slice(0, 60)}`);
      }
      reads = true;
      return;
    }
    if ((t.isAssignmentExpression(n) && isLocation(n.left, m)) || (t.isUpdateExpression(n) && isLocation(n.argument, m))) {
      if (inFn) fail('iç fonksiyonda durum yazma');
      writes = true;
    }
    if ((t.isVariableDeclarator(n) || t.isFunctionDeclaration(n) || t.isClassDeclaration(n) || t.isCatchClause(n)) &&
        !inFn && Object.keys(t.getBindingIdentifiers(n.id ?? n.param ?? n)).some((k) => roots.has(k))) {
      fail('durum adı gölgeleniyor');
    }
    // durum kökünü kendi parametresi ya da var'ıyla gölgeleyen iç fonksiyon başka bir nesneye bakar:
    // içindeki referanslar bu makinenin durumu değildir (js-confuser her iç fonksiyona aynı adlı scope verir)
    if (t.isFunction(n)) {
      // fonksiyonun kendi kapsamında bildirilen adlar: parametreler, kendi adı (ifadeyse), gövdedeki
      // var/let/const, fonksiyon ve sınıf bildirimleri (js-confuser kısa adları kapsamlar arasında yeniden kullanır)
      const body = t.isBlockStatement(n.body) ? n.body.body : [];
      const own = [
        ...n.params.flatMap((x) => Object.keys(t.getBindingIdentifiers(x))),
        ...(t.isFunctionExpression(n) && n.id ? [n.id.name] : []),
        ...body.flatMap((s) => (t.isVariableDeclaration(s) ? s.declarations.flatMap((d) => Object.keys(t.getBindingIdentifiers(d.id)))
          : (t.isFunctionDeclaration(s) || t.isClassDeclaration(s)) && s.id ? [s.id.name] : [])),
      ];
      if (own.some((k) => roots.has(k))) return;
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
    // closure gövdesi sonradan çalışır: oradaki okumalar canlı kalır (m.live ile durum gerçekten yazılıyor)
    if (t.isFunction(n)) return n;
    if ((t.isIdentifier(n) && m.vars.has(n.name)) || isArrayElem(n, m) || E.isSum(n)) {
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

// İç switch'i hedefleyen etiketsiz break (kendi döngü/switch'i içinde olmayan)
function breaksOwnSwitch(node) {
  let found = false;
  const walk = (n, nested) => {
    if (!n || typeof n !== 'object' || found || t.isFunction(n)) return;
    if (t.isBreakStatement(n) && !n.label && !nested) { found = true; return; }
    const inner = nested || t.isLoop(n) || t.isSwitchStatement(n);
    for (const k of t.VISITOR_KEYS[n.type] ?? []) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach((c) => walk(c, inner)); else walk(v, inner);
    }
  };
  walk(node, false);
  return found;
}

// Ad, düğüm içinde (iç fonksiyonlar dahil) yazılıyor mu?
function hasWrite(node, name) {
  let found = false;
  t.traverseFast(node, (n) => {
    if ((t.isAssignmentExpression(n) && t.isIdentifier(n.left, { name })) || (t.isUpdateExpression(n) && t.isIdentifier(n.argument, { name }))) found = true;
  });
  return found;
}

// ── yorumlayıcı ─────────────────────────────────────────

function unflatten(m, S0) {
  const E = makeEval(m);
  // ön tarama: case gövdelerindeki closure'lar durumu okuyorsa canlı moda geç
  m.live = false;
  for (const c of m.sw.cases) c.consequent.forEach((s) => scanState(s, m));
  const budget = { steps: 0, size: 0 };

  // somut atama deyimi: P = 5;  states[9] = 1234;
  const assignStmt = (targetNode, index, value) => t.expressionStatement(t.assignmentExpression('=',
    index === null ? t.cloneNode(targetNode, true) : t.memberExpression(t.cloneNode(targetNode, true), t.numericLiteral(index), true),
    literalOf(t, value)));

  const applyUpdate = (n, S, out) => {
    const target = t.isAssignmentExpression(n) ? n.left : n.argument;
    if (!t.isIdentifier(target) && !isArrayElem(target, m)) fail('durum dizisinin tamamına atama');
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
    if (t.isIdentifier(target)) {
      S.vars.set(target.name, value);
      if (m.live) out.push(assignStmt(target, null, value));
      return;
    }
    const arr = S.arrays.get(pathOf(target.object));
    const i = E.ev(target.property, S);
    if (!Number.isInteger(i) || i < 0 || i >= arr.length) fail('dizi yazma indeksi');
    arr[i] = value;
    if (m.live) out.push(assignStmt(target.object, i, value));
  };

  // Makineden çıkışta, dışarıdan okunabilecek durum konumlarını son değerleriyle eşitle (canlı modda gerekmez)
  const exitSync = (S) => {
    if (!m.syncOnExit || m.live) return [];
    const out = [];
    for (const [name, v] of S.vars) if (S0.vars.get(name) !== v) out.push(assignStmt(t.identifier(name), null, v));
    for (const [path, arr] of S.arrays) {
      const node = m.pathNodes.get(path);
      arr.forEach((v, i) => { if (S0.arrays.get(path)[i] !== v) out.push(assignStmt(node, i, v)); });
    }
    return out;
  };

  // ifade deyimi: durum güncellemeleri uygulanır, geri kalanı sabitlenmiş haliyle yazılır
  const expression = (e, S, out) => {
    if (t.isSequenceExpression(e)) { e.expressions.forEach((x) => expression(x, S, out)); return; }
    if ((t.isAssignmentExpression(e) && isLocation(e.left, m)) || (t.isUpdateExpression(e) && isLocation(e.argument, m))) {
      applyUpdate(e, S, out);
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

  // Aynı (durum, case) bu yolda daha önce görüldüyse geri kenardır: orası bir döngünün başı.
  // Başa dönüşte durum birebir aynı olduğu için gövdeye yazılan sabitler her turda geçerlidir.
  const headers = new Map(); // yol üstündeki başlık anahtarı → etiket
  let labelSeq = 0;

  // İzleme (probe) modu: kod üretmeden bir dalın uğradığı dispatch anahtarlarını sırayla toplar;
  // durumdan bağımsız ilk if'te, dönüşte ya da tekrar eden anahtarda durur.
  let probe = null;
  class ProbeStop {}
  const PROBE_STEPS = 600;
  function trace(list, S, path) {
    const saved = probe;
    probe = { keys: [], states: new Map() };
    try { exec(list, S.clone(), path, null); } catch (e) { if (!(e instanceof ProbeStop)) throw e; }
    const res = probe;
    probe = saved;
    return res;
  }

  function iterate(S, path, stop, first = false) {
    if (++budget.steps > MAX_STEPS) fail('adım bütçesi aşıldı');
    // for: her yeni turdan önce güncelleme ifadesi (durum güncellemesi iç durumda, gerisi çıktıya)
    const pre = [];
    if (!first && m.update) expression(m.update, S, pre);
    if (!(first && m.doWhile) && m.test && !isAlwaysTrue(m.test) && !E.ev(m.test, S)) return pre.concat(exitSync(S));
    return pre.concat(dispatch(S, path, stop));
  }

  function dispatch(S, path, stop) {
    const key = `${E.ev(m.disc, S)}|${S.key()}`;
    if (probe) {
      if (path.has(key) || probe.states.has(key) || probe.keys.length > PROBE_STEPS) throw new ProbeStop();
      probe.keys.push(key);
      probe.states.set(key, S.clone());
    }
    // birleşme noktasına gelindi: devamı if/else'ten sonra bir kez yazılacak
    if (stop && key === stop) return [];
    if (path.has(key)) {
      if (!headers.has(key)) headers.set(key, `peel_loop_${++labelSeq}`);
      return [t.continueStatement(t.identifier(headers.get(key)))];
    }
    const body = exec(casesFrom(S), S, new Set(path).add(key), stop);
    const label = headers.get(key);
    if (!label) return body;
    // başka bir dalda aynı başlık yeniden üretilirse yeni etiket alsın
    headers.delete(key);
    return [t.labeledStatement(t.identifier(label), t.whileStatement(t.booleanLiteral(true),
      t.blockStatement([...body, t.breakStatement(t.identifier(label))])))];
  }

  function exec(list, S, path, stop) {
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (t.isBreakStatement(s) || t.isContinueStatement(s)) {
        if (s.label && s.label.name !== m.label) fail('etiketli atlama');
        // E160: break L makineden çıkar (orijinalde döngü biter); continue L ve etiketsiz atlamalar yeni tur
        if (s.label && t.isBreakStatement(s)) return out.concat(exitSync(S));
        return out.concat(iterate(S, path, stop));
      }
      if (t.isEmptyStatement(s)) continue;
      if (t.isReturnStatement(s) || t.isThrowStatement(s)) {
        if (scanState(s, m).writes) fail('dönüşte durum yazma');
        out.push(substitute(s, S, m, E));
        return out;
      }
      if (t.isExpressionStatement(s)) {
        if (t.isSequenceExpression(s.expression)) {
          list = [...s.expression.expressions.map((x) => t.expressionStatement(x)), ...list.slice(i + 1)];
          i = -1;
          continue;
        }
        // E156/E157: durumdan bağımsız koşula bağlı durum ataması iki yola ayrılır
        const split = splitStateAssign(s.expression, S);
        if (split) {
          list = [split, ...list.slice(i + 1)];
          i = -1;
          continue;
        }
        expression(s.expression, S, out);
        continue;
      }
      // E156: durum yazan iç switch (çok yollu dallanma) if zincirine açılır
      if (t.isSwitchStatement(s) && scanState(s, m).writes) {
        list = [switchToIf(s), ...list.slice(i + 1)];
        i = -1;
        continue;
      }
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
        if (probe) throw new ProbeStop();
        if (scanState(s.test, m).writes) fail('koşulda durum yazma');
        const test = substitute(s.test, S, m, E);
        const yesList = [...branch(s.consequent), ...rest];
        const noList = [...branch(s.alternate), ...rest];
        // iki dalın ilk ortak dispatch anahtarı: orada durum birebir aynı, devamı bir kez yazılır
        const a = trace(yesList, S, path);
        const b = trace(noList, S, path);
        const join = a.keys.find((k) => b.states.has(k) && k !== stop) ?? null;
        const yes = exec(yesList, S.clone(), path, join ?? stop);
        const no = exec(noList, S.clone(), path, join ?? stop);
        out.push(t.ifStatement(test, t.blockStatement(yes), no.length ? t.blockStatement(no) : null));
        if (!join) return out;
        return out.concat(iterate(a.states.get(join).clone(), path, stop));
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
    return out.concat(iterate(S, path, stop));
  }

  // Durum atamasının sağ tarafı tek bir durumdan bağımsız koşula bağlıysa (P = c ? 3 : 5, P += (x > 2) * 4)
  // koşul bir kez değerlendirilen gerçek bir if'e çevrilir: if (c) P = 3; else P = 5;
  function splitStateAssign(e, S) {
    if (!t.isAssignmentExpression(e) || !isLocation(e.left, m)) return null;
    try { E.ev(e.right, S); return null; } catch (err) { if (!(err instanceof Unsupported)) throw err; }
    const booleanTyped = (x) => t.isBooleanLiteral(x) || t.isUnaryExpression(x, { operator: '!' }) ||
      (t.isBinaryExpression(x) && ['===', '!==', '==', '!=', '<', '>', '<=', '>=', 'in', 'instanceof'].includes(x.operator)) ||
      (t.isLogicalExpression(x) && x.operator !== '??' && booleanTyped(x.left) && booleanTyped(x.right));
    const evaluable = (x) => { try { E.ev(x, S); return true; } catch (err) { if (!(err instanceof Unsupported)) throw err; return false; } };
    const readsState = (x) => { try { return scanState(x, m).reads; } catch (err) { if (err instanceof Unsupported) return true; throw err; } };
    // en küçük değerlendirilemeyen alt ifadeler: boolean türlü ya da ?: testi olan durumdan bağımsız ifade bir yaprak
    const unknown = [];
    const visit = (n, parent, key) => {
      if (!n || typeof n !== 'object' || unknown.length > 1 || evaluable(n)) return;
      const asTest = Boolean(parent) && t.isConditionalExpression(parent) && key === 'test';
      if (!readsState(n) && (booleanTyped(n) || asTest)) { unknown.push({ n, ok: true }); return; }
      let inner = false;
      for (const k of t.VISITOR_KEYS[n.type] ?? []) {
        const v = n[k];
        for (const c of Array.isArray(v) ? v : [v]) {
          if (c && typeof c === 'object' && t.isExpression(c) && !evaluable(c)) { inner = true; visit(c, n, k); }
        }
      }
      if (!inner) unknown.push({ n, ok: false });
    };
    visit(e.right, null, null);
    if (unknown.length !== 1 || !unknown[0].ok) return null;
    const u = unknown[0].n;
    const branch = (value) => {
      const copy = t.cloneNode(e, true);
      // klon üzerinde aynı konumu bul: orijinal düğüm kimliğiyle eşleşen yol
      const mapNodes = (a, b, f) => {
        if (a === u) return f(b);
        if (!a || typeof a !== 'object') return b;
        for (const k of t.VISITOR_KEYS[a.type] ?? []) {
          const va = a[k];
          if (Array.isArray(va)) b[k] = va.map((c, j) => mapNodes(c, b[k][j], f)); else if (va && typeof va === 'object') b[k] = mapNodes(va, b[k], f);
        }
        return b;
      };
      return t.expressionStatement(mapNodes(e, copy, () => t.booleanLiteral(value)));
    };
    return t.ifStatement(t.cloneNode(u, true), t.blockStatement([branch(true)]), t.blockStatement([branch(false)]));
  }

  // switch (d) { case A: X; break; case B: Y; break; default: Z }  →  if (d === A) {X} else if (d === B) {Y} else {Z}
  function switchToIf(sw) {
    const d = sw.discriminant;
    if (!(t.isIdentifier(d) || t.isNumericLiteral(d) || t.isStringLiteral(d))) fail('iç switch ayırıcısı');
    if (t.isIdentifier(d) && hasWrite(sw, d.name)) fail('iç switch ayırıcısı değişiyor');
    const bodies = [];
    for (let i = 0; i < sw.cases.length; i++) {
      const c = sw.cases[i];
      if (c.test && !t.isStringLiteral(c.test) && !t.isNumericLiteral(c.test) && !t.isBooleanLiteral(c.test) && !t.isNullLiteral(c.test)) fail('iç switch case testi');
      // düşen gövdeler birleştirilir; sondaki break atılır, başka break iç switch'i hedefliyorsa desteklenmez
      let stmts = [];
      let j = i;
      let terminated = false;
      for (; j < sw.cases.length && !terminated; j++) {
        for (const st of sw.cases[j].consequent) {
          if (t.isBreakStatement(st) && !st.label) { terminated = true; break; }
          if (t.isVariableDeclaration(st) && st.kind !== 'var') fail('iç switch let/const');
          stmts.push(st);
          const last = st;
          if (t.isReturnStatement(last) || t.isThrowStatement(last) || t.isContinueStatement(last)) { terminated = true; break; }
        }
      }
      if (stmts.some((st) => breaksOwnSwitch(st))) fail('iç switch break');
      bodies.push({ test: c.test, stmts });
    }
    const def = bodies.find((b) => !b.test);
    let out = def ? t.blockStatement(def.stmts.map((x) => t.cloneNode(x, true))) : null;
    for (const b of bodies.filter((x) => x.test).reverse()) {
      out = t.ifStatement(t.binaryExpression('===', t.cloneNode(d), t.cloneNode(b.test)), t.blockStatement(b.stmts.map((x) => t.cloneNode(x, true))), out);
    }
    return out ?? t.emptyStatement();
  }

  const result = iterate(S0, new Set(), null, true);
  budget.size = gen(t.blockStatement(result)).length;
  if (budget.size > MAX_OUTPUT) fail('çıktı çok büyük');
  return result;
}

// ── üretilen döngüleri toparlama ────────────────────────
// L: while (true) { S; if (c) {} else { continue L; } break L; }  →  do { S } while (!c);

const negate = (e) => (t.isUnaryExpression(e, { operator: '!' }) ? e.argument : t.unaryExpression('!', e));

// L'ye giden bir atlama başka bir döngü/switch içinde mi? (öyleyse etiket gerekli)
function labelNeeded(body, label) {
  let needed = false;
  const walk = (n, nested) => {
    if (!n || typeof n !== 'object' || needed || t.isFunction(n)) return;
    if ((t.isBreakStatement(n) || t.isContinueStatement(n)) && n.label?.name === label && nested) { needed = true; return; }
    const inner = nested || t.isLoop(n) || t.isSwitchStatement(n);
    for (const k of t.VISITOR_KEYS[n.type] ?? []) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach((c) => walk(c, inner)); else walk(v, inner);
    }
  };
  body.forEach((s) => walk(s, false));
  return needed;
}

function dropLabel(node, label) {
  if (!node || typeof node !== 'object' || t.isFunction(node)) return;
  if ((t.isBreakStatement(node) || t.isContinueStatement(node)) && node.label?.name === label) node.label = null;
  for (const k of t.VISITOR_KEYS[node.type] ?? []) {
    const v = node[k];
    if (Array.isArray(v)) v.forEach((c) => dropLabel(c, label)); else dropLabel(v, label);
  }
}

// Etiketsiz break bu döngüyü mü hedefliyor? (kendi döngü/switch'i içinde olmayan)
function breaksLoop(stmts) {
  let found = false;
  const walk = (n, nested) => {
    if (!n || typeof n !== 'object' || found || t.isFunction(n)) return;
    if (t.isBreakStatement(n) && !n.label && !nested) { found = true; return; }
    const inner = nested || t.isLoop(n) || t.isSwitchStatement(n);
    for (const k of t.VISITOR_KEYS[n.type] ?? []) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach((c) => walk(c, inner)); else walk(v, inner);
    }
  };
  stmts.forEach((s) => walk(s, false));
  return found;
}

const isEmptyBlock = (b) => t.isBlockStatement(b) && !b.body.length;
const isJump = (s, type) => (type === 'continue' ? t.isContinueStatement(s) : t.isBreakStatement(s)) && !s.label;

function tidyList(stmts) {
  return stmts.flatMap((s) => {
    if (t.isIfStatement(s)) {
      if (t.isBlockStatement(s.consequent)) s.consequent.body = tidyList(s.consequent.body);
      if (t.isBlockStatement(s.alternate)) s.alternate.body = tidyList(s.alternate.body);
      if (isEmptyBlock(s.alternate)) s.alternate = null;
      if (isEmptyBlock(s.consequent) && s.alternate) {
        s.test = negate(s.test);
        s.consequent = t.isBlockStatement(s.alternate) ? s.alternate : t.blockStatement([s.alternate]);
        s.alternate = null;
      }
      return [s];
    }
    if (t.isLabeledStatement(s) && t.isWhileStatement(s.body) && t.isBlockStatement(s.body.body)) {
      const label = s.label.name;
      let body = tidyList(s.body.body.body);
      if (labelNeeded(body, label)) { s.body.body.body = body; return [s]; }
      body.forEach((x) => dropLabel(x, label));
      body = tidyList(body);
      // sonda: if (C) { continue; } break;  →  do { … } while (C)
      const [last, prev] = [body[body.length - 1], body[body.length - 2]];
      if (isJump(last, 'break') && t.isIfStatement(prev) && !prev.alternate && t.isBlockStatement(prev.consequent) &&
          prev.consequent.body.length === 1 && isJump(prev.consequent.body[0], 'continue')) {
        return [t.doWhileStatement(prev.test, t.blockStatement(body.slice(0, -2)))];
      }
      // tek deyim: if (C) { X; continue; } else { Y }  →  while (C) { X } Y   (X döngüden break etmemeli)
      const only = body.length === 1 ? body[0] : body.length === 2 && isJump(body[1], 'break') ? body[0] : null;
      if (t.isIfStatement(only) && only.alternate) {
        const asList = (b) => (t.isBlockStatement(b) ? b.body : [b]);
        let [test, loopPart, exitPart] = [only.test, asList(only.consequent), asList(only.alternate)];
        if (!isJump(loopPart[loopPart.length - 1], 'continue') && isJump(exitPart[exitPart.length - 1], 'continue')) {
          [test, loopPart, exitPart] = [negate(test), exitPart, loopPart];
        }
        const x = loopPart.slice(0, -1);
        const y = isJump(exitPart[exitPart.length - 1], 'break') ? exitPart.slice(0, -1) : exitPart;
        if (isJump(loopPart[loopPart.length - 1], 'continue') && !breaksLoop(x) && !hasMachineJump(t.blockStatement(y))) {
          return [t.whileStatement(test, t.blockStatement(x)), ...y];
        }
      }
      if (isJump(body[body.length - 1], 'continue')) body.pop();
      return [t.whileStatement(t.booleanLiteral(true), t.blockStatement(body))];
    }
    return [s];
  });
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
    const target = machineTarget(p);
    // aynı blokta döngüden önce ya da for başlangıcında
    if (decl.parentPath !== p && (decl.parentPath !== target.parentPath || decl.key >= target.key)) return false;
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
    const out = [...forInit(p.node), ...tidyList(unflatten(m, new State(new Map(vars))))];
    const target = machineTarget(p);
    if (Array.isArray(target.container)) {
      if (out.length) target.replaceWithMultiple(out); else target.remove();
    } else {
      target.replaceWith(t.blockStatement(out));
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
      // gövde: [ …önce çalışan deyimler (parametre açma vb.), makine döngüsü ]
      const body = p.node.body.body;
      if (!p.node.id || !body.length) return;
      const mach = machineOf(body[body.length - 1]);
      if (!mach || !t.isCallExpression(mach.disc) || !t.isIdentifier(mach.disc.callee) || !sumFns.has(mach.disc.callee.name)) return;
      const arg = mach.disc.arguments[0];
      const pi = p.node.params.findIndex((x) => t.isIdentifier(x, { name: arg?.name }));
      if (pi < 0) return;
      // döngüden önceki deyimler durum dizisine dokunmamalı: başlangıç değeri çağrı yerindeki argümandır
      const prefix = body.slice(0, -1);
      if (prefix.some((s) => gen(s).match(new RegExp(`\\b${arg.name.replace(/\$/g, '\\$')}\\b`)))) return;
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

  const used = new Set();
  traverse(ast, { Identifier(q) { used.add(q.node.name); } });
  const uniqueName = (base) => {
    let name = `_${base}`;
    for (let i = 2; used.has(name); i++) name = `_${base}${i}`;
    used.add(name);
    return name;
  };
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
          const body = tidyList(unflatten(m, new State(new Map(), new Map([[tg.arrayName, JSON.parse(json)]]))));
          // js-confuser aynı adı farklı kapsamlarda yeniden kullanır: generateUid yalnızca üst kapsamlara bakar,
          // çağrı yerini saran iç kapsamdaki aynı adlı kopya yeni fonksiyonu gölgeleyebilir. Ad program genelinde benzersiz olmalı.
          name = uniqueName(`${tg.p.node.id.name}_${clones.size}`);
          const fn = t.cloneNode(tg.p.node, true);
          fn.id = t.identifier(name);
          fn.body = t.blockStatement([...fn.body.body.slice(0, -1), ...body]);
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

// Diğer sürücülerin açamadığı makineler (başlangıcı sabit olmayan değişkenler, scope.X.Y gibi kapsam
// nesnesinde tutulan durum dizileri): döngüye giriş anındaki durum sandbox'ta gözlenir. Yalnızca tek bir
// başlangıç gözlenirse makine yerinde açılır; çıkışta değişen durum değerleri gerçekten yazılır.
async function observedMachines(ast, sumFns, { sandbox, onLog }) {
  if (!sandbox) return 0;
  const cands = [];
  traverse(ast, {
    'WhileStatement|DoWhileStatement|ForStatement'(p) {
      const mach = machineOf(p.node, labelOf(p));
      // for başlangıcı döngüye girişten önce çalışır: giriş kaydı onu göremez
      if (!mach || (t.isForStatement(p.node) && p.node.init) || !Array.isArray(machineTarget(p).container) ||
          p.findParent((x) => x.isWithStatement())) return;
      const vars = new Set();
      const arrays = new Map();
      let ok = true;
      const collect = (n, parent, key) => {
        if (!n || typeof n !== 'object' || !ok) return;
        if (t.isCallExpression(n) && t.isIdentifier(n.callee) && sumFns.has(n.callee.name)) {
          const path = n.arguments.length === 1 ? pathOf(n.arguments[0]) : null;
          if (!path) { ok = false; return; }
          arrays.set(path, n.arguments[0]);
          return;
        }
        if (t.isIdentifier(n) && !(t.isMemberExpression(parent) && key === 'property' && !parent.computed)) {
          const b = p.scope.getBinding(n.name);
          if (!b) { ok = false; return; }
          // değişkeni başka bir fonksiyon değiştiriyorsa makine modeli eksik kalır
          const fn = p.getFunctionParent();
          if (!b.constantViolations.every((v) => v.getFunctionParent() === fn)) { ok = false; return; }
          vars.add(n.name);
          return;
        }
        for (const k of t.VISITOR_KEYS[n.type] ?? []) {
          const v = n[k];
          if (Array.isArray(v)) v.forEach((c) => collect(c, n, k)); else collect(v, n, k);
        }
      };
      collect(mach.disc, null, null);
      vars.delete(mach.preName);
      if (!ok || (!vars.size && !arrays.size)) return;
      cands.push({ p, mach, vars: [...vars], arrays });
    },
  });
  if (!cands.length) return 0;

  // döngüden hemen önce __peelEntry(k, [P, Q], [scope.X.Y]) ile giriş durumunu kaydet
  const inserted = [];
  cands.forEach((c, k) => {
    const stmt = t.expressionStatement(t.callExpression(t.identifier('__peelEntry'), [
      t.numericLiteral(k),
      t.arrayExpression(c.vars.map((v) => t.identifier(v))),
      t.arrayExpression([...c.arrays.values()].map((n) => t.cloneNode(n, true))),
    ]));
    const target = machineTarget(c.p);
    target.container.splice(target.container.indexOf(target.node), 0, stmt);
    inserted.push([target.container, stmt]);
  });
  const code = gen(ast);
  for (const [container, stmt] of inserted) container.splice(container.indexOf(stmt), 1);

  const prelude = `var __peelEntries = {};
function __peelEntry(k, v, a) {
  var ok = v.every(function (x) { return typeof x === "number"; }) &&
    a.every(function (x) { return Array.isArray(x) && x.every(function (y) { return typeof y === "number"; }); });
  var s = ok ? JSON.stringify([v, a]) : null;
  if (!(k in __peelEntries)) __peelEntries[k] = s; else if (__peelEntries[k] !== s) __peelEntries[k] = null;
}`;
  const r = await sandbox.run(`${prelude}\ntry {\n${code}\n} catch (e) {}\n__res.push(__peelEntries);`, { timeoutMs: 8000 });
  const entries = r.res?.[0] ?? {};

  let n = 0;
  cands.forEach((c, k) => {
    const json = entries[k];
    if (!c.p.node) return;
    if (typeof json !== 'string') {
      onLog(`unflatten: makine açılamadı (${k in entries ? 'birden çok farklı başlangıç durumu' : 'çalıştırmada makineye girilmedi'})`, 'warn');
      return;
    }
    const [v, a] = JSON.parse(json);
    const paths = [...c.arrays.keys()];
    const m = {
      ...c.mach, vars: new Set(c.vars), arrays: new Set(paths), sumFns, syncOnExit: true,
      pathNodes: new Map(paths.map((path) => [path, c.arrays.get(path)])),
    };
    const S0 = new State(new Map(c.vars.map((name, i) => [name, v[i]])), new Map(paths.map((path, i) => [path, a[i]])));
    try {
      const out = tidyList(unflatten(m, S0));
      const target = machineTarget(c.p);
      if (out.length) target.replaceWithMultiple(out); else target.remove();
      n++;
      onLog(`unflatten: ${[...c.vars, ...paths].join(', ')} makinesi düz koda çevrildi (başlangıç durumu çalışma anında gözlendi)`, 'info');
    } catch (e) {
      if (!(e instanceof Unsupported)) throw e;
      onLog(`unflatten: makine açılamadı (${e.message})`, 'warn');
    }
  });
  return n;
}

export async function run(ast, { onLog, bump, sandbox }) {
  const sumFns = collectSumFns(ast);
  let n = 0;
  traverse(ast, {
    'WhileStatement|DoWhileStatement|ForStatement': {
      exit(p) {
        const mach = machineOf(p.node, labelOf(p));
        if (!mach) return;
        if (p.findParent((x) => x.isWithStatement())) return;
        if (identifierMachine(p, mach, sumFns, onLog)) n++;
      },
    },
  });
  n += await arrayMachines(ast, sumFns, { sandbox, onLog });
  n += await observedMachines(ast, sumFns, { sandbox, onLog });
  bump('unflatten', n);
}
