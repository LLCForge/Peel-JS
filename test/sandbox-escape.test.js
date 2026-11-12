// I182: sandbox kaçış testi paketi: node test/sandbox-escape.test.js
import assert from 'node:assert/strict';
import { getQuickJS } from 'quickjs-emscripten';
import { createHost, sandboxApi } from '../src/sandbox/core.js';
import { runEscapeSuite, KNOWN_LIMITS } from '../src/verify/escape.js';

// host ağına çıkış olursa yakalanır: Node'un gerçek fetch'i sandbox çalışırken çağrılmamalı
let hostFetches = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (...a) => { hostFetches++; return realFetch(...a); };

const host = createHost(await getQuickJS());
const sb = sandboxApi(async (m) => host.handle(m));
const r = await runEscapeSuite(sb);
for (const x of r.results) assert.ok(x.pass, `${x.id}: ${x.title} — ${x.error ?? JSON.stringify(x.out)}`);
assert.equal(hostFetches, 0, 'sandbox host ağına istek attı');
assert.equal(({}).__peelPolluted, undefined);
assert.ok(KNOWN_LIMITS.every((k) => k.mitigation));
globalThis.fetch = realFetch;
console.log(`sandbox-escape: ok (${r.passed}/${r.total})`);
