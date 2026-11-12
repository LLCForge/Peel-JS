import * as t from '@babel/types';
import { traverse, generate } from '../util/ast.js';
import { parse } from '../core/parse.js';

// 86: paketleri modüllere bölme. webpack 4/5 (dizi ya da nesne modül tablosu, webpackJsonp/webpackChunk parçaları),
// browserify ve esbuild (// yol/dosya.js yorumları) biçimlerindeki modüller ayrı dosyalar olarak çıkarılır.
// Her modül: { id, name, code, deps }. Kod, modül fabrikasının gövdesidir (parametreleri imza satırında korunur).

const MAX_MODULES = 2000;
const code = (node) => generate(node, { comments: true, jsescOption: { minimal: true } }).code;

function factoryText(fn) {
  const params = fn.params.map((p) => code(p)).join(', ');
  const body = t.isBlockStatement(fn.body) ? fn.body.body.map((s) => code(s)).join('\n') : `return ${code(fn.body)};`;
  return `// modül fabrikası (${params})\n${body}\n`;
}

const isFactory = (n) => (t.isFunctionExpression(n) || t.isArrowFunctionExpression(n)) && n.params.length <= 3;

// { "./src/a.js": function (module, exports, __webpack_require__) {…} } ya da [function…, function…]
function tableModules(table, out) {
  if (t.isArrayExpression(table)) {
    table.elements.forEach((e, i) => {
      if (e && isFactory(e)) out.push({ id: String(i), name: `module-${i}.js`, fn: e });
    });
  } else if (t.isObjectExpression(table)) {
    for (const p of table.properties) {
      const v = t.isObjectProperty(p) ? p.value : t.isObjectMethod(p) ? p : null;
      if (!v || !(isFactory(v) || t.isObjectMethod(v))) continue;
      const key = t.isStringLiteral(p.key) ? p.key.value : t.isNumericLiteral(p.key) ? String(p.key.value) : t.isIdentifier(p.key) ? p.key.name : null;
      if (key !== null) out.push({ id: key, name: fileName(key), fn: v });
    }
  }
}

const fileName = (key) => {
  const clean = key.replace(/^\.\/|^\.\.\//g, '').replace(/[^\w./-]/g, '_').replace(/\.\.+/g, '.');
  return /\.(m?js|cjs|jsx|ts|tsx)$/.test(clean) ? clean : `${clean || 'module'}.js`;
};

/**
 * @param {string} source
 * @returns {{ format: string|null, modules: { id:string, name:string, code:string, deps:object }[] }}
 */
export function splitModules(source) {
  let ast;
  try { ast = parse(source); } catch { return { format: null, modules: [] }; }
  const found = [];
  let format = null;
  traverse(ast, {
    // webpack 5: var __webpack_modules__ = ({ … })
    VariableDeclarator(p) {
      if (t.isIdentifier(p.node.id, { name: '__webpack_modules__' }) && p.node.init) {
        format ??= 'webpack 5';
        tableModules(p.node.init, found);
      }
    },
    CallExpression(p) {
      const n = p.node;
      // (self.webpackChunk… = …).push([[ids], { modules }]) ya da webpackJsonp.push(...)
      if (t.isMemberExpression(n.callee) && t.isIdentifier(n.callee.property, { name: 'push' }) &&
        /webpackChunk|webpackJsonp/.test(code(n.callee.object)) && t.isArrayExpression(n.arguments[0])) {
        const [, table] = n.arguments[0].elements;
        if (table) { format ??= 'webpack chunk'; tableModules(table, found); }
        return;
      }
      // webpack 4: (function (modules) { … __webpack_require__ … })([…] | {…})
      const callee = n.callee;
      if (t.isFunctionExpression(callee) && n.arguments.length === 1 && (t.isArrayExpression(n.arguments[0]) || t.isObjectExpression(n.arguments[0]))) {
        const text = code(callee.body);
        if (/__webpack_require__|installedModules|\.m\s*=\s*\w+/.test(text)) {
          format ??= 'webpack 4';
          tableModules(n.arguments[0], found);
          return;
        }
      }
      // browserify: (…)({ 1: [function (require, module, exports) {…}, { "./x": 2 }], … }, {}, [1])
      if (n.arguments.length === 3 && t.isObjectExpression(n.arguments[0]) && t.isArrayExpression(n.arguments[2])) {
        const props = n.arguments[0].properties;
        if (props.length && props.every((p) => t.isObjectProperty(p) && t.isArrayExpression(p.value) && isFactory(p.value.elements[0]))) {
          format ??= 'browserify';
          for (const p of props) {
            const id = t.isNumericLiteral(p.key) ? String(p.key.value) : t.isStringLiteral(p.key) ? p.key.value : code(p.key);
            const deps = {};
            const dmap = p.value.elements[1];
            if (t.isObjectExpression(dmap)) {
              for (const d of dmap.properties) {
                if (t.isObjectProperty(d) && t.isStringLiteral(d.key)) deps[d.key.value] = t.isNumericLiteral(d.value) ? d.value.value : code(d.value);
              }
            }
            found.push({ id, name: `module-${id}.js`, fn: p.value.elements[0], deps });
          }
        }
      }
      // AMD: define("ad", [bağımlılıklar], function (…) {…})
      if (t.isIdentifier(n.callee, { name: 'define' }) && t.isStringLiteral(n.arguments[0]) && isFactory(n.arguments.at(-1))) {
        format ??= 'AMD';
        const deps = t.isArrayExpression(n.arguments[1]) ? Object.fromEntries(n.arguments[1].elements.filter((e) => t.isStringLiteral(e)).map((e, i) => [e.value, i])) : {};
        found.push({ id: n.arguments[0].value, name: fileName(n.arguments[0].value), fn: n.arguments.at(-1), deps });
      }
    },
  });
  if (found.length) {
    // browserify bağımlılık adlarından dosya adı: "./util" → util.js
    const nameById = new Map();
    for (const m of found) for (const [req, id] of Object.entries(m.deps ?? {})) if (!nameById.has(String(id))) nameById.set(String(id), fileName(req));
    const modules = found.slice(0, MAX_MODULES).map((m) => ({
      id: m.id,
      name: nameById.get(m.id) ?? m.name,
      code: factoryText(m.fn),
      deps: m.deps ?? {},
    }));
    return { format, modules: dedupeNames(modules) };
  }
  // esbuild: modül sınırları "// src/a.js" yorumlarıyla işaretlenir
  const marks = (ast.comments ?? []).filter((c) => c.type === 'CommentLine' && /^\s*[\w@.-]+(\/[\w@.-]+)*\.(m?js|cjs|jsx|ts|tsx)\s*$/.test(c.value));
  if (marks.length >= 2) {
    const modules = marks.map((c, i) => {
      const end = i + 1 < marks.length ? marks[i + 1].start : source.length;
      return { id: c.value.trim(), name: fileName(c.value.trim()), code: `${source.slice(c.end, end).trim()}\n`, deps: {} };
    });
    return { format: 'esbuild', modules: dedupeNames(modules) };
  }
  return { format: null, modules: [] };
}

function dedupeNames(modules) {
  const seen = new Map();
  for (const m of modules) {
    const n = seen.get(m.name) ?? 0;
    seen.set(m.name, n + 1);
    if (n) m.name = m.name.replace(/(\.\w+)$/, `-${n}$1`);
  }
  return modules;
}
