// Sandbox semantik modelleri öz-denetimi (E512, E515–E519, E526, E529–E531, E534, E539, E540):
// node test/analysis-runtime.test.js
import assert from 'node:assert/strict';
import { getQuickJS } from 'quickjs-emscripten';
import { createHost, sandboxApi } from '../src/sandbox/core.js';
import { semanticRuntime, compareRegexEngines, instrumentForSemantics } from '../src/analysis/runtime.js';

const host = createHost(await getQuickJS());
const sandbox = sandboxApi(async (msg) => host.handle(msg));
const val = async (expr, config = null) => {
  const r = await sandbox.run(`__res.push(${expr});`, { config });
  assert.ok(r.ok, r.error);
  return r.res[0];
};

// E529: saat dilimi host'tan bağımsız, yapılandırılabilir
assert.equal(await val('new Date(0).getHours()'), 0);
assert.equal(await val('new Date(0).getTimezoneOffset()'), 0);
assert.equal(await val('new Date(0).toString()'), 'Thu Jan 01 1970 00:00:00 GMT+0000 (Coordinated Universal Time)');
assert.equal(await val('new Date(0).getHours()', { tz: -180 }), 3);
assert.equal(await val('new Date(0).toString()', { tz: -180 }), 'Thu Jan 01 1970 03:00:00 GMT+0300 (GMT+03:00)');
assert.equal(await val('new Date(2020, 0, 1).getTime()', { tz: -180 }), Date.UTC(2020, 0, 1) - 3 * 3600000);
assert.equal(await val('Date.parse("2020-01-01T00:00:00")', { tz: 60 }), Date.UTC(2020, 0, 1) + 3600000);
assert.equal(await val('Date.parse("2020-01-01")', { tz: 60 }), Date.UTC(2020, 0, 1));
assert.equal(await val('(function(){ var d = new Date(0); d.setHours(5); return d.getUTCHours(); })()', { tz: -120 }), 3);
assert.equal(await val('typeof Date()'), 'string');
assert.equal(await val('new Date(0) instanceof Date && new Date(0).constructor === Date'), true);

// E530: toLocaleString
assert.equal(await val('(1234567.891).toLocaleString()'), '1,234,567.891');
assert.equal(await val('(1234567.891).toLocaleString("tr-TR")'), '1.234.567,891');
assert.equal(await val('(1234.5).toLocaleString("de-DE", { minimumFractionDigits: 2 })'), '1.234,50');
assert.equal(await val('[1234, null, 5].toLocaleString()'), '1,234,,5');
assert.equal(await val('new Date(Date.UTC(2023, 0, 2, 15, 4, 5)).toLocaleString("en-US")'), '1/2/2023, 3:04:05 PM');
assert.equal(await val('new Date(Date.UTC(2023, 0, 2, 15, 4, 5)).toLocaleDateString("tr-TR")'), '02.01.2023');

// E531: Intl.NumberFormat (host V8 Intl ile karşılaştır)
const intlCases = [
  ['en-US', {}, 1234567.891], ['en-US', { style: 'percent' }, 0.256], ['en-US', { style: 'currency', currency: 'USD' }, -1234.5],
  ['en-US', { style: 'currency', currency: 'JPY' }, 1234.5], ['en-US', { maximumSignificantDigits: 3 }, 123456],
  ['en-US', { minimumIntegerDigits: 3 }, 7], ['en-US', { useGrouping: false }, 1234567], ['en-US', { notation: 'compact' }, 1234],
  ['en-US', { notation: 'compact' }, 999999], ['en-US', { notation: 'compact' }, 12345678], ['en-US', { notation: 'compact' }, 999.4],
  ['en-US', { signDisplay: 'always' }, 5], ['en-US', { signDisplay: 'exceptZero' }, 0], ['tr-TR', { style: 'percent' }, 0.5],
  ['tr-TR', { style: 'currency', currency: 'TRY' }, 1234.5], ['de-DE', { style: 'currency', currency: 'EUR' }, 1234.5],
  ['de-DE', { style: 'percent' }, 0.5], ['ja-JP', { style: 'currency', currency: 'JPY' }, 1234], ['en-US', {}, NaN], ['en-US', {}, -Infinity],
  ['en-US', { maximumFractionDigits: 0 }, 2.5], ['en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }, 1.005],
];
for (const [loc, opts, n] of intlCases) {
  const expected = new Intl.NumberFormat(loc, opts).format(n);
  const got = await val(`new Intl.NumberFormat(${JSON.stringify(loc)}, ${JSON.stringify(opts)}).format(${Number.isNaN(n) ? 'NaN' : n === -Infinity ? '-Infinity' : n})`);
  assert.equal(got, expected, `${loc} ${JSON.stringify(opts)} ${n}`);
}
assert.equal(await val('new Intl.NumberFormat("en-US").formatToParts(-1234.5).map(function (p) { return p.type; }).join()'),
  new Intl.NumberFormat('en-US').formatToParts(-1234.5).map((p) => p.type).join());
assert.equal(await val('new Intl.NumberFormat("xx-YY").resolvedOptions().locale'), 'en-US');
assert.equal(await val('(function(){ try { new Intl.NumberFormat("en", { style: "currency" }); } catch (e) { return e.name; } })()'), 'TypeError');
assert.equal(await val('(function(){ try { new Intl.NumberFormat("en", { maximumFractionDigits: 1, minimumFractionDigits: 3 }); } catch (e) { return e.name; } })()'), 'RangeError');

// E534: performance.now monoton ve deterministik
assert.equal(await val('(function(){ var a = performance.now(), b = performance.now(); return b > a; })()'), true);
assert.equal(await val('(function(){ var s = performance.now(), n = 0; while (performance.now() - s < 50) n++; return n; })()'), 49);

// E539: Atomics
assert.equal(await val('(function(){ var a = new Int32Array(new SharedArrayBuffer(8)); Atomics.add(a, 0, 5); Atomics.sub(a, 0, 2); Atomics.compareExchange(a, 1, 0, 9); return [Atomics.load(a, 0), a[1], Atomics.exchange(a, 0, 1), Atomics.isLockFree(4)].join(); })()'), '3,9,3,true');
assert.equal(await val('(function(){ try { Atomics.add(new Float64Array(1), 0, 1); } catch (e) { return e.name; } })()'), 'TypeError');
assert.equal(await val('(function(){ try { Atomics.load(new Int8Array(1), 5); } catch (e) { return e.name; } })()'), 'RangeError');
assert.equal(await val('Atomics.store(new Uint8Array(1), 0, 300)'), 300);
assert.equal(await val('(function(){ var a = new Int32Array(new SharedArrayBuffer(4)); return Atomics.waitAsync(a, 0, 1).value; })()'), 'not-equal');

// E540: WeakRef / FinalizationRegistry
assert.equal(await val('(function(){ var o = {}; return new WeakRef(o).deref() === o; })()'), true);
assert.equal(await val('(function(){ try { new WeakRef(1); } catch (e) { return e.name; } })()'), 'TypeError');
assert.equal(await val('(function(){ var r = new FinalizationRegistry(function(){}), t = {}; r.register({}, 1, t); return [r.unregister(t), r.unregister(t)].join(); })()'), 'true,false');

// E519: Error.captureStackTrace
assert.equal(await val('(function(){ function Make() { var o = { name: "E", message: "m" }; Error.captureStackTrace(o, Make); return o.stack.split("\\n")[0]; } return Make(); })()'), 'E: m');
assert.equal(await val('Error.stackTraceLimit'), 10);

// E516: olay döngüsü sırası — senkron → mikro (then, queueMicrotask, await) → makro (setTimeout)
{
  const r = await semanticRuntime(sandbox, `
setTimeout(function timer() {}, 0);
Promise.resolve().then(function first() {});
queueMicrotask(function second() {});
(async function run() { await null; })();
`);
  assert.ok(r.ok, r.error);
  const seq = r.order.map((o) => (o.fn ? `${o.phase}:${o.fn}` : o.phase));
  assert.deepEqual(seq, ['senkron bitti', 'mikro:first', 'mikro:second', 'mikro:await@5', 'makro:timer']);
}

// E517: işlenmeyen ret, sonradan işlenen ret ve E515 thenable
{
  const r = await semanticRuntime(sandbox, `
Promise.reject(new Error("boom"));
var late = Promise.reject(1);
setTimeout(function () { late.catch(function () {}); }, 0);
Promise.reject(2).catch(function () {});
async function f() { throw new Error("af"); }
f();
(async function () { try { await f(); } catch (e) {} })();
var th = { then: function (r) { r(1); } };
(async function () { await th; })();
`);
  const reasons = r.unhandled.map((u) => u.reason).sort();
  assert.deepEqual(reasons, ['1', 'af', 'boom']);
  assert.equal(r.lateHandled, 1);
  assert.ok(r.thenables.some((x) => x.via === 'await'));
}

// E512: üst seviye await sandbox'ta async sarmalayıcıyla çalışır
{
  const inst = instrumentForSemantics('var v = await Promise.resolve(3); console.log(v);');
  assert.equal(inst.topLevelAwait, true);
  const r = await semanticRuntime(sandbox, 'var v = await Promise.resolve(3); console.log(v);');
  assert.ok(r.ok && r.topLevelAwait);
}

// E518: analiz çalıştırmasında stack V8 biçiminde (başlık satırı) ve okuması kaydedilir
{
  const r = await semanticRuntime(sandbox, 'var s = new Error("x").stack; if (s.split("\\n")[0] !== "Error: x") throw new Error("biçim");');
  assert.ok(r.stacks.some((s) => s.api === 'Error.stack'));
  assert.equal(r.errors.length, 0);
}

// E526: motor farkı — v bayrağı QuickJS'te derlenmez, host'ta derlenir
{
  const r = await compareRegexEngines(sandbox, [{ source: '[\\p{L}--[a-z]]', flags: 'v', line: 1 }, { source: 'a(?<=a)b', flags: '', line: 2 }, { source: 'x+', flags: 'g', line: 3 }], ['xx', 'ab']);
  assert.equal(r.compared, 3);
  assert.ok(r.differences.some((d) => d.kind === 'derleme' && d.pattern.endsWith('/v')));
  assert.ok(!r.differences.some((d) => d.pattern === '/x+/g'));
}

console.log('analysis-runtime: ok');
