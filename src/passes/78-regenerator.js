import * as t from '@babel/types';
import { traverse } from '../util/ast.js';

// E56: generator tabanlı durum makinesini düz fonksiyona çevirme (regenerator çıktısı).
//   regeneratorRuntime.wrap(function _callee$(_context) { while (1) switch (_context.prev = _context.next) {
//     case 0: …; _context.next = 2; return fetch(u);  case 2: r = _context.sent; … } }, _callee, this, tryLocs)
//   → yield / await (async sarmalayıcıda), _context.sent tüketen deyimle birleşir; ileri koşullu atlamalar
//   if/else, geri atlamalar while (true) + break/continue, abrupt("return") return, delegateYield yield*,
//   tryLocs içindeki try/catch blokları try { } catch (e) { } olur.
//   _asyncToGenerator(regeneratorRuntime.mark(function f(){…})) → async function; mark'lı bildirim → function*.
//   Tanınmayan yapı (finally, yapısız atlama, blok dışında okunan sent) görülürse makineye dokunulmaz.

class Bail extends Error {}

const isRuntime = (n) => (t.isIdentifier(n) && /^_?regeneratorRuntime$/.test(n.name)) ||
  (t.isCallExpression(n) && t.isIdentifier(n.callee) && /^_?regeneratorRuntime$/.test(n.callee.name) && !n.arguments.length) ||
  (t.isMemberExpression(n) && !n.computed && t.isIdentifier(n.property, { name: 'regeneratorRuntime' }));
const runtimeCall = (n, method) => t.isCallExpression(n) && t.isMemberExpression(n.callee) && !n.callee.computed &&
  t.isIdentifier(n.callee.property, { name: method }) && isRuntime(n.callee.object);

const propOf = (m) => (!m.computed && t.isIdentifier(m.property) ? m.property.name : t.isStringLiteral(m.property) ? m.property.value : null);
const ctxMember = (n, ctx, prop) => t.isMemberExpression(n) && t.isIdentifier(n.object, { name: ctx }) && (prop ? propOf(n) === prop : propOf(n) !== null);

function assignTo(stmt, ctx, prop) {
  if (!t.isExpressionStatement(stmt) || !t.isAssignmentExpression(stmt.expression, { operator: '=' })) return undefined;
  return ctxMember(stmt.expression.left, ctx, prop) ? stmt.expression.right : undefined;
}

// _context.next = N;  → N | 'end' | null
function nextAssign(stmt, ctx) {
  const right = assignTo(stmt, ctx, 'next');
  if (right === undefined) return null;
  if (t.isNumericLiteral(right)) return right.value;
  if (t.isStringLiteral(right, { value: 'end' })) return 'end';
  throw new Bail('dinamik hedef');
}

function flatten(sw) {
  const items = [];
  for (const c of sw.cases) {
    if (!c.test) throw new Bail('default dalı');
    const label = t.isNumericLiteral(c.test) ? c.test.value : t.isStringLiteral(c.test) ? c.test.value : null;
    if (label === null) throw new Bail('etiket');
    items.push({ label });
    for (const s of c.consequent) items.push({ stmt: s });
  }
  return items;
}

// [[try, catch, finally?, after?], …]
function parseTryLocs(node) {
  if (!node) return [];
  if (!t.isArrayExpression(node)) throw new Bail('tryLocs');
  return node.elements.map((e) => {
    if (!t.isArrayExpression(e)) throw new Bail('tryLocs');
    const v = e.elements.map((x) => (x == null ? null : t.isNumericLiteral(x) ? x.value : (() => { throw new Bail('tryLocs'); })()));
    if (v[2] != null) throw new Bail('finally');
    return { tryLoc: v[0], catchLoc: v[1] };
  });
}

function replaceMember(node, ctx, prop, make) {
  let used = 0;
  const visit = (n, parent, key) => {
    if (!n || typeof n !== 'object') return;
    if (ctxMember(n, ctx, prop)) { used++; parent[key] = make(); return; }
    if (t.isFunction(n)) return;
    for (const k of t.VISITOR_KEYS[n.type] ?? []) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach((x, i) => visit(x, v, i)); else visit(v, n, k);
    }
  };
  const holder = { n: node };
  visit(node, holder, 'n');
  return used;
}

const mentionsCtx = (node, ctx) => {
  if (!node || typeof node !== 'object') return false;
  if (t.isIdentifier(node, { name: ctx })) return true;
  if (t.isFunction(node) && node.params.some((p) => t.isIdentifier(p, { name: ctx }))) return false;
  return (t.VISITOR_KEYS[node.type] ?? []).some((k) => (Array.isArray(node[k]) ? node[k].some((x) => mentionsCtx(x, ctx)) : mentionsCtx(node[k], ctx)));
};

function convert(inner, isAsync, tryLocsNode) {
  if (inner.params.length !== 1 || !t.isIdentifier(inner.params[0])) throw new Bail('parametre');
  const ctx = inner.params[0].name;
  const body = inner.body.body;
  if (body.length !== 1) throw new Bail('gövde');
  const outerLoop = body[0];
  const isInfinite = (t.isWhileStatement(outerLoop) && ((t.isNumericLiteral(outerLoop.test) && outerLoop.test.value) || t.isBooleanLiteral(outerLoop.test, { value: true }))) ||
    (t.isForStatement(outerLoop) && !outerLoop.init && !outerLoop.test && !outerLoop.update);
  if (!isInfinite) throw new Bail('döngü');
  const sw = t.isBlockStatement(outerLoop.body) && outerLoop.body.body.length === 1 ? outerLoop.body.body[0] : outerLoop.body;
  if (!t.isSwitchStatement(sw)) throw new Bail('switch');
  const items = flatten(sw);
  const labelPos = new Map(items.map((it, i) => [it.label, i]).filter(([l]) => l !== undefined));
  const tries = parseTryLocs(tryLocsNode);
  const verim = (arg) => (isAsync ? t.awaitExpression(arg) : t.yieldExpression(arg));
  const posOf = (label) => (label === 'end' ? items.length : labelPos.get(label));
  const nextLabelAfter = (i) => items.slice(i).find((x) => x.label !== undefined)?.label;
  const isJumpTo = (i, label) => {
    const s = items[i]?.stmt;
    const b = items[i + 1]?.stmt;
    try { return Boolean(s) && (label === undefined ? nextAssign(s, ctx) !== null : nextAssign(s, ctx) === label) && t.isBreakStatement(b) && !b.label; } catch { return false; }
  };

  // pending: { expr, prop } — son verim noktasının değeri; sonraki deyimde _context[prop] okuması onunla değişir
  const emit = (from, to, loop = null) => {
    const out = [];
    let pending = null;
    const flushPending = () => { if (pending) { out.push(t.expressionStatement(pending.expr)); pending = null; } };
    const pushStmt = (s) => {
      if (pending) {
        const p = pending;
        const used = replaceMember(s, ctx, p.prop, () => p.expr);
        if (used > 1) throw new Bail('gönderilen değer iki kez okunuyor');
        if (!used) out.push(t.expressionStatement(p.expr));
        pending = null;
      }
      if (mentionsCtx(s, ctx)) throw new Bail('_context kullanımı');
      out.push(s);
    };
    for (let i = from; i < to; i++) {
      const it = items[i];
      if (it.label !== undefined) {
        // try/catch: tryLoc etiketi → try bölgesi [tryLoc, catchLoc), catch bölgesi [catchLoc, sonrası)
        const tr = tries.find((x) => x.tryLoc === it.label);
        if (tr) {
          const prevStmt = items[i + 1]?.stmt;
          const pv = assignTo(prevStmt, ctx, 'prev');
          if (!t.isNumericLiteral(pv) || pv.value !== it.label) throw new Bail('try başı');
          const cPos = posOf(tr.catchLoc);
          if (cPos === undefined || cPos <= i || cPos > to || !isJumpTo(cPos - 2)) throw new Bail('try sonu');
          const after = nextAssign(items[cPos - 2].stmt, ctx);
          const aPos = posOf(after);
          if (aPos === undefined || aPos <= cPos || aPos > to) throw new Bail('catch sonu');
          // catch başı: _context.prev = C; _context.t0 = _context["catch"](T);
          const cPrev = assignTo(items[cPos + 1]?.stmt, ctx, 'prev');
          const t0stmt = items[cPos + 2]?.stmt;
          const t0Right = t0stmt && t.isExpressionStatement(t0stmt) && t.isAssignmentExpression(t0stmt.expression) ? t0stmt.expression.right : null;
          if (!t.isNumericLiteral(cPrev) || !t.isCallExpression(t0Right) || !ctxMember(t0Right.callee, ctx, 'catch')) throw new Bail('catch başı');
          const errProp = propOf(t0stmt.expression.left);
          const errId = t.identifier(`_err${it.label}`);
          for (let k = cPos + 3; k < aPos; k++) if (items[k].stmt) replaceMember(items[k].stmt, ctx, errProp, () => t.identifier(errId.name));
          const tryPart = emit(i + 2, cPos - 2, loop);
          if (tryPart.pending) tryPart.out.push(t.expressionStatement(tryPart.pending.expr));
          const catchPart = emit(cPos + 3, aPos, loop);
          if (catchPart.pending) catchPart.out.push(t.expressionStatement(catchPart.pending.expr));
          pushStmt(t.tryStatement(t.blockStatement(tryPart.out), t.catchClause(errId, t.blockStatement(catchPart.out))));
          i = aPos - 1;
          continue;
        }
        // geri atlama hedefi: [etiket, son geri atlama] arası while (true)
        let j = -1;
        for (let k = to - 2; k > i; k--) if (isJumpTo(k, it.label)) { j = k; break; }
        if (j < 0) continue;
        const exitLabel = nextLabelAfter(j + 2) ?? 'end';
        const part = emit(i + 1, j, { head: it.label, exit: exitLabel });
        if (part.pending) part.out.push(t.expressionStatement(part.pending.expr));
        pushStmt(t.whileStatement(t.booleanLiteral(true), t.blockStatement(part.out)));
        i = j + 1;
        continue;
      }
      const s = it.stmt;
      const nx = nextAssign(s, ctx);
      if (nx !== null) {
        const ret = items[i + 1]?.stmt;
        // verim noktası: _context.next = N; return E;
        if (t.isReturnStatement(ret)) {
          flushPending();
          if (nextLabelAfter(i + 2) !== nx) throw new Bail('doğrusal olmayan verim');
          pending = { expr: verim(ret.argument ?? t.identifier('undefined')), prop: 'sent' };
          i++;
          continue;
        }
        if (t.isBreakStatement(ret) && !ret.label) {
          if (loop && (nx === loop.head || nx === loop.exit)) {
            pushStmt(nx === loop.head ? t.continueStatement() : t.breakStatement());
            i++;
            continue;
          }
          if (nx === 'end' && to === items.length) { flushPending(); return { out, pending: null }; }
          const target = posOf(nx);
          if (target === undefined || target <= i || target > to) throw new Bail('yapısız atlama');
          i = target - 1;
          continue;
        }
        throw new Bail('beklenmeyen next ataması');
      }
      // ileri koşullu atlama: if (C) { _context.next = N; break; }
      if (t.isIfStatement(s) && !s.alternate && t.isBlockStatement(s.consequent) && s.consequent.body.length === 2 &&
          t.isBreakStatement(s.consequent.body[1]) && !s.consequent.body[1].label) {
        const target = nextAssign(s.consequent.body[0], ctx);
        if (target !== null) {
          if (loop && (target === loop.head || target === loop.exit)) {
            pushStmt(t.ifStatement(s.test, target === loop.head ? t.continueStatement() : t.breakStatement()));
            continue;
          }
          const end = posOf(target);
          if (end === undefined || end <= i || end > to) throw new Bail('yapısız atlama');
          // if/else: then bölgesi ileri bir X'e koşulsuz atlayarak bitiyorsa [end, X) else bölgesidir
          let elseEnd = null;
          if (end - 2 > i && isJumpTo(end - 2)) {
            const x = nextAssign(items[end - 2].stmt, ctx);
            const xPos = posOf(x);
            if (!(loop && (x === loop.head || x === loop.exit)) && xPos !== undefined && xPos > end && xPos <= to) elseEnd = xPos;
          }
          const thenPart = emit(i + 1, elseEnd === null ? end : end - 2, loop);
          if (thenPart.pending) thenPart.out.push(t.expressionStatement(thenPart.pending.expr));
          let node;
          if (elseEnd === null) node = t.ifStatement(t.unaryExpression('!', s.test), t.blockStatement(thenPart.out));
          else {
            const elsePart = emit(end, elseEnd, loop);
            if (elsePart.pending) elsePart.out.push(t.expressionStatement(elsePart.pending.expr));
            node = t.ifStatement(t.unaryExpression('!', s.test), t.blockStatement(thenPart.out), t.blockStatement(elsePart.out));
          }
          pushStmt(node);
          i = (elseEnd ?? end) - 1;
          continue;
        }
      }
      // return _context.abrupt("return", E) / stop() / delegateYield(gen, "t1", N)
      if (t.isReturnStatement(s) && t.isCallExpression(s.argument) && ctxMember(s.argument.callee, ctx)) {
        const m = propOf(s.argument.callee);
        const args = s.argument.arguments;
        if (m === 'stop') { flushPending(); return { out, pending: null }; }
        if (m === 'abrupt' && t.isStringLiteral(args[0], { value: 'return' })) { pushStmt(t.returnStatement(args[1] ?? null)); continue; }
        if (m === 'delegateYield' && t.isStringLiteral(args[1]) && t.isNumericLiteral(args[2])) {
          flushPending();
          if (nextLabelAfter(i + 1) !== args[2].value) throw new Bail('doğrusal olmayan yield*');
          pending = { expr: t.yieldExpression(args[0], true), prop: args[1].value };
          continue;
        }
        throw new Bail(`desteklenmeyen _context.${m}`);
      }
      if (t.isBreakStatement(s) && !s.label) throw new Bail('serbest break');
      pushStmt(s);
    }
    return { out, pending };
  };
  const r = emit(0, items.length);
  if (r.pending) r.out.push(t.expressionStatement(r.pending.expr));
  return r.out;
}

export async function run(ast, { onLog, bump }) {
  let n = 0;
  const bail = (e) => {
    if (e instanceof Bail) { onLog(`regenerator: dokunulmadı (${e.message})`, 'info'); return true; }
    throw e;
  };
  traverse(ast, {
    CallExpression: {
      exit(p) {
        // X.mark(function f(params) { var …; return X.wrap(function f$(_context) {…}, f, this?, tryLocs?); })
        if (!runtimeCall(p.node, 'mark') || p.node.arguments.length !== 1 || !t.isFunctionExpression(p.node.arguments[0])) return;
        const outer = p.node.arguments[0];
        const ret = outer.body.body[outer.body.body.length - 1];
        if (!t.isReturnStatement(ret) || !runtimeCall(ret.argument, 'wrap') || !t.isFunctionExpression(ret.argument.arguments[0])) return;
        const asyncWrap = p.parentPath.isCallExpression() && t.isIdentifier(p.parentPath.node.callee) && /asyncToGenerator$/.test(p.parentPath.node.callee.name) &&
          p.parentPath.node.arguments.length === 1;
        let stmts;
        try { stmts = convert(ret.argument.arguments[0], asyncWrap, ret.argument.arguments[3]); } catch (e) { if (bail(e)) return; }
        const fn = t.functionExpression(outer.id, outer.params, t.blockStatement([...outer.body.body.slice(0, -1), ...stmts]), !asyncWrap, asyncWrap);
        (asyncWrap ? p.parentPath : p).replaceWith(fn);
        n++;
      },
    },
    // function gen() { return X.wrap(function gen$(_context) {…}, _marked); }  →  function* gen() {…}
    FunctionDeclaration(p) {
      const body = p.node.body.body;
      const ret = body[body.length - 1];
      if (p.node.generator || p.node.async || !t.isReturnStatement(ret) || !runtimeCall(ret.argument, 'wrap') || !t.isFunctionExpression(ret.argument.arguments[0])) return;
      const marked = ret.argument.arguments[1];
      if (!t.isIdentifier(marked)) return;
      // _marked = X.mark(gen) bağlantısı doğrulanır
      const b = p.scope.parent.getBinding(marked.name) ?? p.scope.getBinding(marked.name);
      const init = b && t.isVariableDeclarator(b.path.node) ? b.path.node.init : null;
      const isMark = (x) => runtimeCall(x, 'mark') && t.isIdentifier(x.arguments[0], { name: p.node.id.name });
      if (!init || !(isMark(init) || (t.isArrayExpression(init) && init.elements.some(isMark)))) return;
      let stmts;
      try { stmts = convert(ret.argument.arguments[0], false, ret.argument.arguments[3]); } catch (e) { if (bail(e)) return; }
      p.node.generator = true;
      p.node.body = t.blockStatement([...body.slice(0, -1), ...stmts]);
      // mark artık işlevsiz bir sarmalayıcı: _marked = gen (yan etkisiz)
      if (isMark(init)) b.path.node.init = t.identifier(p.node.id.name);
      n++;
    },
  });
  if (n) onLog(`regenerator: ${n} durum makinesi düz fonksiyona çevrildi`, 'info');
  bump('regenerator', n);
}
