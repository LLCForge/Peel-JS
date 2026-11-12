// E58: bundle ayırma. webpack 4/5 (dizi/nesne modül tablosu ve webpackChunk push), browserify,
// esbuild (__commonJS/__esm) ve Parcel (parcelRequire.register / parcelRegister) paketlerini
// modüllere böler: kimlik, varsa yol adı, bağımlılıklar ve modül kodu. Rollup tek kapsamda
// birleştirdiği için modül sınırı yoktur; bu durum raporlanır.
import * as t from '@babel/types';
import { parse } from './parse.js';
import { traverse, generate } from '../util/ast.js';

const keyOf = (k) => (t.isIdentifier(k) ? k.name : t.isStringLiteral(k) || t.isNumericLiteral(k) ? String(k.value) : null);
const isFn = (n) => t.isFunctionExpression(n) || t.isArrowFunctionExpression(n);
const src = (n) => generate(n, { jsescOption: { minimal: true } }).code;

// Modül gövdesindeki require çağrıları: req("./x") / __webpack_require__(12) / __webpack_require__.n(…) hariç
function depsOf(fnNode, reqNames) {
  const deps = new Set();
  traverse(t.file(t.program([t.expressionStatement(t.isFunctionExpression(fnNode) || t.isArrowFunctionExpression(fnNode) ? fnNode : t.functionExpression(null, fnNode.params, fnNode.body))])), {
    CallExpression(p) {
      const c = p.node.callee;
      if (t.isIdentifier(c) && reqNames.has(c.name) && p.node.arguments.length === 1) {
        const v = keyOf(p.node.arguments[0]);
        if (v !== null) deps.add(v);
      }
    },
  });
  return [...deps];
}

function moduleEntry(id, fn, reqParamIndex, name = null) {
  const params = fn.params ?? [];
  const req = params[reqParamIndex];
  const reqNames = new Set(['__webpack_require__', 'require', ...(t.isIdentifier(req) ? [req.name] : [])]);
  return { id: String(id), name, deps: depsOf(fn, reqNames), code: src(fn) };
}

// { 12: function (module, exports, __webpack_require__) {…} } ya da [function…, function…]
function tableModules(table, reqParamIndex) {
  const mods = [];
  if (t.isArrayExpression(table)) {
    table.elements.forEach((e, i) => { if (e && isFn(e)) mods.push(moduleEntry(i, e, reqParamIndex)); });
  } else if (t.isObjectExpression(table)) {
    for (const p of table.properties) {
      const k = keyOf(p.key);
      if (k === null) continue;
      if (t.isObjectProperty(p) && isFn(p.value)) mods.push(moduleEntry(k, p.value, reqParamIndex, /[/.]/.test(k) ? k : null));
      else if (t.isObjectMethod(p)) mods.push(moduleEntry(k, t.functionExpression(null, p.params, p.body), reqParamIndex, /[/.]/.test(k) ? k : null));
    }
  }
  return mods;
}

const looksLikeTable = (n) => (t.isArrayExpression(n) && n.elements.length >= 1 && n.elements.every((e) => !e || isFn(e))) ||
  (t.isObjectExpression(n) && n.properties.length >= 1 && n.properties.every((p) => (t.isObjectProperty(p) && isFn(p.value)) || t.isObjectMethod(p)));

export function splitBundle(code) {
  let ast;
  try { ast = parse(code); } catch (e) { return { kind: null, modules: [], entry: [], error: e.message }; }
  const found = [];
  let kind = null;
  const entry = new Set();
  traverse(ast, {
    // webpack 5: var __webpack_modules__ = ({ … })
    VariableDeclarator(p) {
      if (t.isIdentifier(p.node.id, { name: '__webpack_modules__' }) && looksLikeTable(p.node.init)) {
        kind ??= 'webpack 5';
        found.push(...tableModules(p.node.init, 2));
      }
    },
    CallExpression(p) {
      const { callee, arguments: args } = p.node;
      // webpack 4: (function (modules) { … __webpack_require__ … })([…] | {…})
      if (isFn(callee) && args.length === 1 && looksLikeTable(args[0]) && /__webpack_require__|installedModules/.test(src(callee).slice(0, 4000))) {
        kind ??= 'webpack 4';
        found.push(...tableModules(args[0], 2));
        const m = src(callee).match(/__webpack_require__\.s\s*=\s*["']?([\w./-]+)["']?/);
        if (m) entry.add(m[1]);
        return;
      }
      // webpackChunk / webpackJsonp: (self.webpackChunkX = …).push([[ids], { modules }])
      if (t.isMemberExpression(callee) && keyOf(callee.property) === 'push' && /webpackChunk|webpackJsonp/.test(src(callee.object)) &&
          args.length === 1 && t.isArrayExpression(args[0]) && looksLikeTable(args[0].elements[1])) {
        kind ??= 'webpack chunk';
        found.push(...tableModules(args[0].elements[1], 2));
        return;
      }
      // browserify: (…)({ 1: [function (require, module, exports) {…}, { "./a": 2 }] }, {}, [1])
      if (args.length === 3 && t.isObjectExpression(args[0]) && t.isArrayExpression(args[2]) && args[0].properties.length &&
          args[0].properties.every((q) => t.isObjectProperty(q) && t.isArrayExpression(q.value) && isFn(q.value.elements[0]))) {
        kind ??= 'browserify';
        for (const q of args[0].properties) {
          const [fn, map] = q.value.elements;
          const deps = t.isObjectExpression(map) ? map.properties.map((d) => ({ request: keyOf(d.key), id: keyOf(d.value) })) : [];
          found.push({ id: keyOf(q.key), name: null, deps: deps.map((d) => d.id).filter((x) => x !== null), requests: deps, code: src(fn) });
        }
        for (const e of args[2].elements) if (e) entry.add(keyOf(e));
        return;
      }
      // esbuild: __commonJS({ "src/a.js"(exports, module) {…} }) / __esm({…})
      if (t.isIdentifier(callee) && /^__(commonJS|esm)$/.test(callee.name) && args.length === 1 && t.isObjectExpression(args[0])) {
        kind ??= 'esbuild';
        const mods = tableModules(args[0], -1);
        // esbuild modülü değişkene atanır: var require_a = __commonJS(...) → require_a() çağrıları bağımlılıktır
        const holder = p.parentPath.isVariableDeclarator() && t.isIdentifier(p.parentPath.node.id) ? p.parentPath.node.id.name : null;
        for (const m of mods) found.push({ ...m, holder });
        return;
      }
      // Parcel: parcelRequire.register("id", function (module, exports) {…}) / parcelRegister("id", …)
      if ((t.isMemberExpression(callee) && keyOf(callee.property) === 'register' && /parcelRequire/.test(src(callee.object))) ||
          (t.isIdentifier(callee) && /^parcelRegister$/.test(callee.name))) {
        if (args.length === 2 && isFn(args[1])) {
          kind ??= 'parcel';
          found.push(moduleEntry(keyOf(args[0]) ?? '?', args[1], 0));
        }
      }
    },
  });
  // esbuild: holder adlarıyla bağımlılık çözümü
  const holders = new Map(found.filter((m) => m.holder).map((m) => [m.holder, m.id]));
  if (holders.size) {
    for (const m of found) {
      const deps = new Set(m.deps);
      for (const [h, id] of holders) if (new RegExp(`\\b${h}\\(\\)`).test(m.code) && id !== m.id) deps.add(id);
      m.deps = [...deps];
      delete m.holder;
    }
  }
  if (!found.length && /^\s*\(function \(global, factory\)|Object\.defineProperty\(exports, ['"]__esModule/.test(code)) {
    return { kind: 'rollup', modules: [], entry: [], note: 'Rollup modülleri tek kapsamda birleştirir: ayrılabilir modül sınırı yok' };
  }
  return { kind, modules: found, entry: [...entry] };
}

// Modülleri dosya adlarına çevirir (ZIP/indirme için): güvenli ad, çakışmada kimlik eki
export function moduleFiles(split) {
  const used = new Set();
  return split.modules.map((m) => {
    const base = (m.name ?? `module-${m.id}`).replace(/^(\.\.?\/)+/, '').replace(/[^\w./-]/g, '_').replace(/\.\.+/g, '.').replace(/^\/+/, '');
    let name = /\.(m?js|cjs|ts|jsx|tsx)$/.test(base) ? base : `${base}.js`;
    if (used.has(name)) name = name.replace(/(\.\w+)$/, `.${m.id}$1`);
    used.add(name);
    const header = `// PEEL modül ${m.id}${m.name ? ` (${m.name})` : ''}${m.deps.length ? ` — bağımlılıklar: ${m.deps.join(', ')}` : ''}\n`;
    return { name, text: `${header}module.exports = (${m.code});\n` };
  });
}
