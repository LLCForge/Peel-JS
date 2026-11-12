// Bundle ayırma ve source map (isim kurtarma / üretme): node test/bundle-sourcemap.test.js
import assert from 'node:assert/strict';
import { splitBundle, moduleFiles } from '../src/core/bundle.js';
import { recoverNames, generateSourceMap, decodeMappings, vlqEncode } from '../src/core/sourcemap.js';
import { parseZip, zipStore } from '../src/security/archive.js';

// --- E58
const wp4 = `(function(modules){var installedModules={};function __webpack_require__(id){return modules[id].call()}return __webpack_require__(__webpack_require__.s=1)})
([function(module,exports){module.exports="a"},function(module,exports,__webpack_require__){var a=__webpack_require__(0);console.log(a)}]);`;
let s = splitBundle(wp4);
assert.equal(s.kind, 'webpack 4');
assert.equal(s.modules.length, 2);
assert.deepEqual(s.modules[1].deps, ['0']);
assert.deepEqual(s.entry, ['1']);

const wp5 = `(()=>{var __webpack_modules__=({"./src/util.js":(module)=>{module.exports=function(){return 1}},"./src/index.js":(__unused,__exports,__webpack_require__)=>{const u=__webpack_require__("./src/util.js");console.log(u())}});})();`;
s = splitBundle(wp5);
assert.equal(s.kind, 'webpack 5');
assert.deepEqual(s.modules.map((m) => m.name), ['./src/util.js', './src/index.js']);
assert.deepEqual(s.modules[1].deps, ['./src/util.js']);

const chunk = `(self.webpackChunkapp=self.webpackChunkapp||[]).push([[179],{42:(e,t,r)=>{r(7)},7:e=>{e.exports=1}}]);`;
s = splitBundle(chunk);
assert.equal(s.kind, 'webpack chunk');
assert.deepEqual(s.modules.find((m) => m.id === '42').deps, ['7']);

const bfy = `(function(){function r(e,n,t){return e}return r})()({1:[function(require,module,exports){var b=require("./b");},{"./b":2}],2:[function(require,module,exports){module.exports=2},{}]},{},[1]);`;
s = splitBundle(bfy);
assert.equal(s.kind, 'browserify');
assert.deepEqual(s.modules[0].deps, ['2']);
assert.deepEqual(s.entry, ['1']);

const esb = `var require_a = __commonJS({ "src/a.js"(exports, module) { module.exports = 1; } });
var require_b = __commonJS({ "src/b.js"(exports, module) { var a = require_a(); } });`;
s = splitBundle(esb);
assert.equal(s.kind, 'esbuild');
assert.deepEqual(s.modules.find((m) => m.name === 'src/b.js').deps, ['src/a.js']);

const parcel = `parcelRegister("abc", function(module, exports) { module.exports = 1; });`;
assert.equal(splitBundle(parcel).kind, 'parcel');
assert.equal(splitBundle('(function (global, factory) { factory(); })(this, function () {});').kind, 'rollup');

const files = moduleFiles(splitBundle(wp5));
assert.deepEqual(files.map((f) => f.name), ['src/util.js', 'src/index.js']);
const z = zipStore(files);
assert.deepEqual(parseZip(z).map((e) => e.name), ['src/util.js', 'src/index.js']);
assert.equal(new TextDecoder().decode(parseZip(z)[1].data), files[1].text);

// --- E59: kısmi source map ile isim kurtarma
// üretilmiş kod: "function a(b){var c=b+1;return c}"; map b→count, c→next, a→inc
const gen = 'function a(b){var c=b+1;return c}';
const col = (x) => gen.indexOf(x);
const seg = (genCol, srcCol, name) => [genCol, 0, 0, srcCol, name];
const raw = [seg(col('a('), 9, 0), seg(col('b)'), 13, 1), seg(col('c='), 30, 2)];
let prev = [0, 0, 0, 0, 0];
const mappings = raw.map((r) => { const e = r.map((v, i) => vlqEncode(v - prev[i])).join(''); prev = r; return e; }).join(',');
assert.deepEqual(decodeMappings(mappings)[0].map((x) => x[4]), [0, 1, 2]);
const rec = recoverNames(gen, { version: 3, sources: ['inc.js'], names: ['inc', 'count', 'next'], mappings });
assert.equal(rec.renamed.length, 3);
assert.match(rec.code, /function inc\(count\)\s*\{\s*var next = count \+ 1;\s*return next;/);
assert.throws(() => recoverNames(gen, { version: 2 }));

// --- E60: çıktı → girdi haritası
const input = 'var _0x1=["hi"];function f(){return _0x1[0]}console.log(f());';
const output = 'function f() {\n  return "hi";\n}\nconsole.log(f());\n';
const sm = generateSourceMap(input, output);
assert.equal(sm.map.version, 3);
assert.equal(sm.map.sourcesContent[0], input);
assert.ok(sm.coverage > 0.6, `kapsam ${sm.coverage}`);
// "console" tokeni girdideki konumuna eşlenmeli
const lines = decodeMappings(sm.map.mappings);
const consoleSeg = lines[3]?.find((x) => x[0] === 0);
assert.ok(consoleSeg, 'console satırı eşlenmeli');
assert.equal(consoleSeg[3], input.indexOf('console'));
assert.ok(sm.map.names.includes('console'));

console.log('bundle-sourcemap: ok');
