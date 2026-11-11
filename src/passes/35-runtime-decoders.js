import * as t from '@babel/types';
import { traverse, gen } from '../util/ast.js';
import { literalValue } from '../util/pure.js';

// Closure içinde tanımlı decoder'lar (ör. sarmalayıcı fonksiyonun içindeki M) statik olarak
// erişilemez. Program, her literal argümanlı çağrı __peelCall üzerinden geçecek şekilde
// sandbox'ta çalıştırılır; decoder fonksiyonu ilk çağrıldığı anda yakalanır ve sonra
// tüm çağrılar o fonksiyonla, iki kez çalıştırılıp aynı string'i veriyorsa çözülür.
//
// Argümanı değişkene bağlı çağrılar (M(T + 273), durum makinesi sayaçları) çalışma anında
// gözlenir: her çalıştırmada aynı string'i veren çağrı yeri o string'le değiştirilir.
// shortcut: gözlem tek çalıştırmaya dayanır, gözlenmeyen girdi için yanlış olabilir; bu yüzden yalnızca seviye 3+.

const MIN_CALLS = 3;
const MIN_STRING_RATIO = 0.8;
const MAX_ARGS = 3;

const PRELUDE = `
var __peelFns = {};
var __peelSeen = {};
function __peelCall(id, fn, args) {
  if (typeof fn === "function" && !__peelFns[id]) __peelFns[id] = fn;
  return fn.apply(undefined, args);
}
function __peelObs(k, v) {
  var s = __peelSeen[k];
  if (s === undefined) __peelSeen[k] = typeof v === "string" ? v : null;
  else if (s !== v) __peelSeen[k] = null;
  return v;
}
function __peelEval(id, args) {
  var f = __peelFns[id];
  if (!f) return null;
  var a = f.apply(undefined, args);
  var b = f.apply(undefined, args);
  return typeof a === "string" && a === b ? a : null;
}
`;

const argsKey = (call) => JSON.stringify(call.node.arguments.map((a) => literalValue(a).value));

function collectGroups(ast) {
  const groups = new Map();
  traverse(ast, {
    CallExpression(p) {
      const { callee, arguments: args } = p.node;
      if (!t.isIdentifier(callee) || !args.length || args.length > MAX_ARGS) return;
      if (args.some((a) => t.isSpreadElement(a))) return;
      // sonucu kullanılmayan çağrı decoder değildir, yan etki için yapılıyordur
      if (p.parentPath.isExpressionStatement()) return;
      const b = p.scope.getBinding(callee.name);
      if (!b) return;
      let g = groups.get(b);
      if (!g) groups.set(b, (g = { id: groups.size, name: callee.name, calls: [], dynamic: [] }));
      const lits = args.map(literalValue);
      if (lits.every((l) => l.ok)) {
        if (lits.some((l) => typeof l.value === 'number')) g.calls.push(p);
      } else {
        g.dynamic.push(p);
      }
    },
  });
  return [...groups.values()].filter((g) => g.calls.length >= MIN_CALLS);
}

export async function run(ast, { onLog, bump, sandbox, level }) {
  const groups = collectGroups(ast);
  if (!groups.length) return;
  const observe = level >= 3;

  // Çağrıları geçici olarak sarıp kodu üret, sonra ağacı geri al
  const saved = [];
  const sites = [];
  for (const g of groups) {
    for (const c of g.calls) {
      const { node } = c;
      saved.push([node, node.callee, node.arguments]);
      node.arguments = [t.numericLiteral(g.id), node.callee, t.arrayExpression(node.arguments)];
      node.callee = t.identifier('__peelCall');
    }
    if (!observe) continue;
    for (const c of g.dynamic) {
      const { node } = c;
      const copy = t.callExpression(node.callee, node.arguments);
      saved.push([node, node.callee, node.arguments]);
      node.arguments = [t.numericLiteral(sites.length), copy];
      node.callee = t.identifier('__peelObs');
      sites.push({ group: g, call: c });
    }
  }
  const instrumented = gen(ast);
  for (const [node, callee, args] of saved) {
    node.callee = callee;
    node.arguments = args;
  }

  const opened = await sandbox.open(`${PRELUDE}\ntry {\n${instrumented}\n} catch (e) {}`, { timeoutMs: 10000 });
  if (!opened.ok) {
    onLog(`runtime-decoders: sandbox açılamadı (${opened.error})`, 'warn');
    return;
  }
  try {
    let total = 0;
    const decoders = new Set();
    for (const g of groups) {
      const unique = [...new Set(g.calls.map(argsKey))];
      const r = await sandbox.batchIn(opened.token, unique.map((args) => `__peelEval(${g.id}, ${args})`));
      if (!r.ok) continue;
      const values = new Map();
      unique.forEach((args, i) => {
        const v = r.results[i];
        if (v?.ok && v.type === 'string') values.set(args, v.value);
      });
      if (values.size < unique.length * MIN_STRING_RATIO) continue;
      decoders.add(g);

      let n = 0;
      for (const c of g.calls) {
        const v = values.get(argsKey(c));
        if (v === undefined || !c.node) continue;
        c.replaceWith(t.stringLiteral(v));
        n++;
      }
      total += n;
      if (n) onLog(`runtime-decoders: ${g.name} ile ${n}/${g.calls.length} çağrı çözüldü`, 'info');
    }

    if (sites.length) {
      const r = await sandbox.batchIn(opened.token, ['JSON.stringify(__peelSeen)']);
      const seen = r.ok && r.results[0]?.type === 'string' ? JSON.parse(r.results[0].value) : {};
      let n = 0;
      sites.forEach(({ group, call }, k) => {
        const v = seen[k];
        if (typeof v !== 'string' || !decoders.has(group) || !call.node) return;
        call.replaceWith(t.stringLiteral(v));
        n++;
      });
      total += n;
      if (n) onLog(`runtime-decoders: ${n}/${sites.length} dinamik çağrı çalışma anı gözlemiyle çözüldü`, 'info');
    }
    bump('runtimeDecoder', total);
  } finally {
    await sandbox.close(opened.token);
  }
}
