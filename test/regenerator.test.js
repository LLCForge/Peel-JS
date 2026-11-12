// regenerator durum makinesi → function*/async (E56): node test/regenerator.test.js
// Orijinal kod küçük bir regenerator çalışma zamanıyla, çevrilmiş kod yerel generator/async ile çalıştırılıp
// sonuçlar karşılaştırılır (doğrusal akış, if/else, döngü, continue, try/catch, yield*).
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { deobfuscate } from '../src/core/pipeline.js';

const RUNTIME = `
var regeneratorRuntime = {
  mark: function (f) { return f; },
  wrap: function (inner, outer, self, tryLocs) {
    var RET = {}, DELEGATE = {};
    var delegate = null;
    var ctx = { prev: 0, next: 0, sent: undefined, done: false, rval: undefined, err: undefined,
      abrupt: function (type, arg) { this.done = true; this.rval = arg; return RET; },
      stop: function () { this.done = true; return RET; },
      catch: function () { return this.err; },
      delegateYield: function (iterable, name, nextLoc) { delegate = { it: iterable[Symbol.iterator](), name: name, nextLoc: nextLoc }; return DELEGATE; } };
    var it = { next: function (v) {
      for (;;) {
        if (ctx.done) return { done: true, value: undefined };
        if (delegate) {
          var d = delegate.it.next(v);
          if (!d.done) return { done: false, value: d.value };
          ctx[delegate.name] = d.value; ctx.next = delegate.nextLoc; delegate = null; v = undefined;
        }
        ctx.sent = v;
        var r;
        try { r = inner.call(self, ctx); } catch (e) {
          // hata yönlendirmesi: prev'i kapsayan try girişinin catch konumuna atla
          var entry = (tryLocs || []).find(function (x) { return ctx.prev >= x[0] && ctx.prev < x[1]; });
          if (!entry) throw e;
          ctx.err = e; ctx.next = entry[1]; ctx.prev = entry[1]; continue;
        }
        if (r === DELEGATE) continue;
        if (r === RET || ctx.done) { ctx.done = true; return { done: true, value: ctx.rval }; }
        return { done: false, value: r };
      }
    } };
    it[Symbol.iterator] = function () { return it; };
    return it;
  },
};
function _asyncToGenerator(fn) {
  return function () {
    var gen = fn.apply(this, arguments);
    return new Promise(function (resolve, reject) {
      function step(v) { var r; try { r = gen.next(v); } catch (e) { reject(e); return; }
        if (r.done) resolve(r.value); else Promise.resolve(r.value).then(step, reject); }
      step();
    });
  };
}
`;

const SRC = `
function risky(v) { if (v < 0) throw new Error("negatif"); return v * 2; }
var _marked = regeneratorRuntime.mark(range);
var _marked2 = regeneratorRuntime.mark(safe);
var _marked3 = regeneratorRuntime.mark(outer);
function range(n) {
  var i;
  return regeneratorRuntime.wrap(function range$(_context) {
    while (1) switch (_context.prev = _context.next) {
      case 0:
        i = 0;
      case 1:
        if (!(i < n)) { _context.next = 9; break; }
        if (!(i === 2)) { _context.next = 4; break; }
        _context.next = 6;
        break;
      case 4:
        _context.next = 6;
        return i * 10;
      case 6:
        i++;
        _context.next = 1;
        break;
      case 9:
        return _context.abrupt("return", "bitti");
      case 10:
      case "end":
        return _context.stop();
    }
  }, _marked);
}
var load = _asyncToGenerator(regeneratorRuntime.mark(function _callee(id) {
  var res, body;
  return regeneratorRuntime.wrap(function _callee$(_context2) {
    while (1) switch (_context2.prev = _context2.next) {
      case 0:
        _context2.next = 2;
        return fetchLike(id);
      case 2:
        res = _context2.sent;
        if (res.ok) { _context2.next = 5; break; }
        return _context2.abrupt("return", null);
      case 5:
        _context2.next = 7;
        return res.json();
      case 7:
        body = _context2.sent;
        return _context2.abrupt("return", body.name + "#" + id);
      case 9:
      case "end":
        return _context2.stop();
    }
  }, _callee);
}));
function safe(x) {
  var r;
  return regeneratorRuntime.wrap(function safe$(_context3) {
    while (1) switch (_context3.prev = _context3.next) {
      case 0:
        _context3.prev = 0;
        _context3.next = 3;
        return x;
      case 3:
        r = risky(_context3.sent);
        _context3.next = 9;
        break;
      case 6:
        _context3.prev = 6;
        _context3.t0 = _context3["catch"](0);
        r = "hata: " + _context3.t0.message;
      case 9:
        return _context3.abrupt("return", r);
      case 10:
      case "end":
        return _context3.stop();
    }
  }, _marked2, null, [[0, 6]]);
}
function outer() {
  var total;
  return regeneratorRuntime.wrap(function outer$(_context4) {
    while (1) switch (_context4.prev = _context4.next) {
      case 0:
        return _context4.delegateYield(safe(4), "t1", 1);
      case 1:
        total = _context4.t1;
        _context4.next = 4;
        return total;
      case 4:
      case "end":
        return _context4.stop();
    }
  }, _marked3);
}
`;

// desteklenmeyen biçim: try/finally — makineye dokunulmamalı
const FINALLY = `
var _m = regeneratorRuntime.mark(fin);
function fin() {
  return regeneratorRuntime.wrap(function fin$(_c) {
    while (1) switch (_c.prev = _c.next) {
      case 0:
        _c.prev = 0;
        _c.next = 3;
        return 1;
      case 3:
        _c.prev = 3;
        done();
        return _c.finish(3);
      case 6:
      case "end":
        return _c.stop();
    }
  }, _m, null, [[0, , 3, 6]]);
}
`;

const drain = (g, sends = []) => {
  const o = [];
  let k = 0;
  for (let r = g.next(); ; r = g.next(sends[k++])) { o.push(r.value); if (r.done) break; }
  return o;
};

async function exercise(code) {
  const ctx = { fetchLike: async (id) => ({ ok: id > 0, json: async () => ({ name: 'kayıt' }) }), out: null };
  vm.runInNewContext(`${RUNTIME}\n${code}\n;out = { range: range, load: load, safe: safe, outer: outer };`, ctx);
  return {
    seq: drain(ctx.out.range(5)),
    a: await ctx.out.load(3),
    b: await ctx.out.load(0),
    ok: drain(ctx.out.safe(1), [5]),
    bad: drain(ctx.out.safe(1), [-1]),
    outer: drain(ctx.out.outer(), [7, 8]),
  };
}

const before = await exercise(SRC);
assert.deepEqual(before, { seq: [0, 10, 30, 40, 'bitti'], a: 'kayıt#3', b: null, ok: [1, 10], bad: [1, 'hata: negatif'], outer: [4, 14, undefined] });
const r = await deobfuscate(SRC, { only: ['regenerator'], sandbox: null });
assert.ok(!r.error, r.error);
assert.ok(!r.code.includes('_context'), r.code);
assert.match(r.code, /function\* range\(n\)/);
assert.match(r.code, /while \(true\)/);
assert.match(r.code, /async function _callee\(id\)/);
assert.match(r.code, /res = await fetchLike\(id\)/);
assert.match(r.code, /try \{/);
assert.match(r.code, /catch \(_err0\)/);
assert.match(r.code, /total = yield\* safe\(4\)/);
assert.deepEqual(await exercise(r.code), before);

const keep = await deobfuscate(FINALLY, { only: ['regenerator'], sandbox: null });
assert.ok(keep.code.includes('fin$'), 'finally içeren makineye dokunulmamalı');
console.log('regenerator: ok');
