import * as t from '@babel/types';
import { gen } from '../util/ast.js';
import { fnv1a } from '../util/hash.js';
import { findVms } from '../core/vm/detect.js';
import { HOLE } from '../core/vm/interp.js';
import { collectNames } from '../core/vm/lift.js';
import { staticValues, instrument, captureRun, decodeCapture } from '../core/vm/values.js';
import { analyzeVm, stateVarsFor } from '../core/vm/analysis.js';

// Bytecode VM'leri (jsvmp tarzı yorumlayıcılar) düz JavaScript'e çevirir (madde 31/32, E192, E649–E651).
//
// Her VM için bytecode, sabit havuzu ve giriş durumu önce statik olarak, bulunamazsa sandbox'ta döngü
// girişinde yakalanır (madde 38). Aynı çalıştırmada her komutun pc'si ve yığın tepesi kaydedilir
// (dinamik adlandırma, kapsam, adım adım iz). Ardından VM somut bytecode ile kısmen değerlendirilir.
// Fonksiyon VM'lerinde (function run(code, …)) her farklı bytecode için o bytecode'a özel bir kopya
// üretilir ve çağrı yerleri kopyaya bağlanır; program/yerel VM'ler yerinde değiştirilir.
// Çevrilemeyen VM'e okunur yorumlayıcı açıklamaları (case başına komut adı ve anlamı) eklenir (E652).

const LIFT = ' PEEL VM-LIFT';
const NOTE = ' PEEL VM |';
const hasNote = (node) => (node.leadingComments ?? []).some((c) => c.value.startsWith(NOTE) || c.value.startsWith(LIFT));

// Kod üretilmiş bir bölgenin içinde mi (iç içe VM derinliği, E654)
function liftDepth(path) {
  let depth = 0;
  for (let p = path; p; p = p.parentPath) {
    for (const c of p.node?.leadingComments ?? []) {
      const m = c.value.match(/^ PEEL VM-LIFT .*derinlik=(\d+)/);
      if (m) depth = Math.max(depth, Number(m[1]));
    }
    if (p.isFunction() || p.isProgram()) {
      for (const st of p.node.body?.body ?? p.node.body ?? []) {
        for (const c of st?.leadingComments ?? []) {
          const m = c.value.match(/^ PEEL VM-LIFT .*derinlik=(\d+)/);
          if (m) depth = Math.max(depth, Number(m[1]));
        }
      }
    }
  }
  return depth;
}

function callSites(vm) {
  const fn = vm.fnPath;
  if (!fn.isFunctionDeclaration() || !fn.node.id) return null;
  const codeB = vm.loopPath.scope.getBinding(vm.roles.code);
  if (codeB?.kind !== 'param') return null;
  const b = fn.parentPath.scope.getBinding(fn.node.id.name);
  if (!b || b.constantViolations.length) return null;
  const sites = [];
  for (const [j, ref] of b.referencePaths.entries()) {
    const call = ref.parentPath;
    if (!call.isCallExpression({ callee: ref.node }) || call.node.arguments.some((a) => t.isSpreadElement(a))) return null;
    if (ref.findParent((x) => x === fn)) return null; // özyineleme: kopya kendini çağırırdı
    let unsafe = false;
    walk(call.node, (n) => { if (t.isAwaitExpression(n) || t.isYieldExpression(n)) unsafe = true; });
    if (unsafe) return null;
    sites.push({ id: `${vm.id}:${j}`, path: call });
  }
  return sites.length ? sites : null;
}

function walk(node, fn) {
  if (!node || typeof node !== 'object') return;
  fn(node);
  for (const k of t.VISITOR_KEYS[node.type] ?? []) {
    const v = node[k];
    if (Array.isArray(v)) v.forEach((c) => walk(c, fn)); else walk(v, fn);
  }
}

function mergeValues(stat, cap, roles) {
  const arrays = new Map(stat.arrays);
  const state = new Map(stat.state);
  let captured = false;
  if (cap) {
    const arrNames = [roles.code, roles.consts].filter(Boolean);
    arrNames.forEach((n, i) => {
      if (!arrays.has(n) && cap.arrays[i] != null) { arrays.set(n, cap.arrays[i]); captured = true; }
    });
    for (const [n, v] of cap.state) if (!state.has(n)) { state.set(n, v); captured = true; }
  }
  let stackInit = stat.stackInit;
  if (stackInit === null && cap && Number.isInteger(cap.depth) && cap.depth >= 0) { stackInit = cap.depth; captured = true; }
  return { arrays, state, stackInit: stackInit ?? 0, captured, stackKnown: stackInit !== null };
}

// Yol: fonksiyon düğümünden döngü deyimine anahtar zinciri (kopyada aynı yeri bulmak için)
function keyPath(root, target) {
  const path = [];
  const find = (n) => {
    if (n === target) return true;
    for (const k of t.VISITOR_KEYS[n.type] ?? []) {
      const v = n[k];
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) {
          if (v[i] && typeof v[i] === 'object') { path.push([k, i]); if (find(v[i])) return true; path.pop(); }
        }
      } else if (v && typeof v === 'object') { path.push([k, null]); if (find(v)) return true; path.pop(); }
    }
    return false;
  };
  return find(root) ? path : null;
}

function placeAt(root, path, stmts) {
  let parent = root;
  for (let i = 0; i < path.length - 1; i++) { const [k, idx] = path[i]; parent = idx === null ? parent[k] : parent[k][idx]; }
  const [k, idx] = path[path.length - 1];
  if (idx !== null && Array.isArray(parent[k])) parent[k].splice(idx, 1, ...stmts);
  else parent[k] = t.blockStatement(stmts);
}

function replaceInPlace(vm, stmts) {
  if (Array.isArray(vm.stmtPath.container)) vm.stmtPath.replaceWithMultiple(stmts);
  else vm.stmtPath.replaceWith(t.blockStatement(stmts));
}

// Register dizisini (R = [] ve yalnızca R[sabit] kullanımı) ayrı değişkenlere böl: R[2] → _r2
function scalarizeRegisters(fnNode, name, used) {
  const body = t.isProgram(fnNode) ? fnNode.body : fnNode.body?.body;
  if (!name || !Array.isArray(body)) return false;
  let declIndex = -1;
  let declarator = null;
  body.forEach((s, i) => {
    if (t.isVariableDeclaration(s)) for (const d of s.declarations) if (t.isIdentifier(d.id, { name })) { declIndex = i; declarator = d; }
  });
  if (!declarator || !t.isArrayExpression(declarator.init) || declarator.init.elements.some((e) => e && !t.isLiteral(e))) return false;
  let ok = true;
  const sites = [];
  const visit = (n, parent, key, idx, inner) => {
    if (!n || typeof n !== 'object' || !ok) return;
    if (inner && t.isFunction(n)) {
      const own = [...n.params.flatMap((p) => Object.keys(t.getBindingIdentifiers(p)))];
      if (own.includes(name)) return;
    }
    if (t.isIdentifier(n, { name }) && n !== declarator.id) {
      const isName = (t.isMemberExpression(parent) && key === 'property' && !parent.computed) || (t.isObjectProperty(parent) && key === 'key' && !parent.computed);
      if (!isName) {
        if (!(t.isMemberExpression(parent) && key === 'object' && parent.computed && t.isNumericLiteral(parent.property) && Number.isInteger(parent.property.value))) ok = false;
        else sites.push(parent);
      }
    }
    for (const k of t.VISITOR_KEYS[n.type] ?? []) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach((c, i) => visit(c, n, k, i, inner || t.isFunction(n))); else visit(v, n, k, null, inner || t.isFunction(n));
    }
  };
  body.forEach((s, i) => {
    if (i < declIndex) walk(s, (n) => { if (t.isIdentifier(n, { name })) ok = false; });
    else visit(s, null, null, null, false);
  });
  if (!ok || !sites.length) return false;
  const names = new Map();
  const nameFor = (i) => {
    if (!names.has(i)) {
      let k = 0;
      let nm;
      do { nm = `_r${i}${k ? `_${k}` : ''}`; k++; } while (used.has(nm));
      used.add(nm);
      names.set(i, nm);
    }
    return names.get(i);
  };
  const elems = declarator.init.elements;
  elems.forEach((_, i) => nameFor(i));
  for (const m of sites) {
    const id = t.identifier(nameFor(m.property.value));
    Object.keys(m).forEach((k) => { if (!['leadingComments', 'trailingComments'].includes(k)) delete m[k]; });
    Object.assign(m, id);
  }
  const decl = body[declIndex];
  const idx = decl.declarations.indexOf(declarator);
  const fresh = [...names].sort((a, b) => a[0] - b[0]).map(([i, nm]) => t.variableDeclarator(t.identifier(nm), elems[i] ? t.cloneNode(elems[i]) : null));
  decl.declarations.splice(idx, 1, ...fresh);
  return true;
}

// Çevrilemeyen VM: döngüye neden ve case'lere komut adı/anlam açıklaması
function annotate(vm, a) {
  const loopNode = vm.stmtPath.node;
  t.addComment(loopNode, 'leading', `${NOTE} bytecode VM #${vm.id} | ${vm.style} | ${vm.handlers.length} handler | düz koda çevrilemedi: ${a.reason ?? 'bilinmiyor'}`, false);
  const byKey = new Map(a.handlers.map((h) => [String(h.key), h]));
  vm.handlers.forEach((h) => {
    const info = byKey.get(String(h.key));
    if (!info) return;
    const text = ` ${info.staticName ?? `OP_${h.key}`}${info.dynName && info.dynName !== info.staticName ? ` (iz: ${info.dynName})` : ''} — ${info.semantics}`;
    const target = vm.style === 'switch' ? h.node : vm.style === 'table' ? h.fn : h.node;
    t.addComment(target, 'leading', text.slice(0, 300), false);
  });
}

function serializable(a, extra) {
  const { lifter, lifted, ...rest } = a;
  return { ...rest, ...extra };
}

export async function run(ast, ctx) {
  const { onLog, bump, sandbox } = ctx;
  const all = findVms(ast).filter((vm) => !hasNote(vm.stmtPath.node) && !hasNote(vm.loopPath.node));
  if (!all.length) return;
  // iç içe statik VM'lerde önce en içteki çevrilir; dıştaki bir sonraki turda yeniden analiz edilir
  const vms = all.filter((vm) => !all.some((o) => o !== vm && o.loopPath.findParent((x) => x === vm.loopPath)));
  vms.forEach((vm, i) => { vm.id = i; });

  for (const vm of vms) {
    const sv = stateVarsFor(vm);
    vm.stateVars = sv.stateVars;
    const scope = vm.loopPath.scope;
    const names = sv.stateVars.filter((n) => {
      const b = scope.getBinding(n);
      return b && (b.kind === 'var' || b.kind === 'param' || b.kind === 'hoisted') && !b.path.findParent((x) => x === vm.loopPath);
    });
    vm.capture = { names, arrays: [vm.roles.code, vm.roles.consts].filter(Boolean), sites: callSites(vm) };
  }

  let seen = {};
  let traces = {};
  if (sandbox) {
    const code = instrument(ast, vms);
    const r = await captureRun(sandbox, code);
    seen = r.seen;
    traces = r.trace;
  }

  const used = collectNames(ast);
  let lifted = 0;
  const touched = [];
  for (const vm of vms) {
    const depth = liftDepth(vm.loopPath) + 1;
    const sites = vm.capture.sites;
    const steps = traces[vm.id] ?? null;
    const plans = [];
    if (sites) {
      for (const site of sites) {
        const stat = staticValues(vm, vm.stateVars, site.path.node.arguments);
        const cap = decodeCapture(seen[`${vm.id}|${site.id}`]);
        plans.push({ site, values: mergeValues(stat, cap, vm.roles) });
      }
    } else {
      const stat = staticValues(vm, vm.stateVars, null);
      plans.push({ site: null, values: mergeValues(stat, decodeCapture(seen[`${vm.id}|*`]), vm.roles) });
    }

    // aynı bytecode'lu çağrı yerleri tek kopyayı paylaşır
    const groups = new Map();
    for (const p of plans) {
      const code = p.values.arrays.get(vm.roles.code);
      const key = code === undefined ? `?${groups.size}` : JSON.stringify([
        typeof code === 'string' ? code : code.map((x) => (x === HOLE ? '\u0000' : x)),
        [...p.values.state].map(([k, v]) => [k, v === undefined ? '\u0000u' : v]), p.values.stackInit,
        vm.roles.consts ? (p.values.arrays.get(vm.roles.consts) ?? []).map((x) => (x === HOLE ? '\u0000' : x)) : null,
      ]);
      if (!groups.has(key)) groups.set(key, { values: p.values, sites: [] });
      if (p.site) groups.get(key).sites.push(p.site);
    }

    let firstAnalysis = null;
    let anyOk = false;
    let gi = 0;
    for (const g of groups.values()) {
      const origin = {
        bytecode: g.values.arrays.has(vm.roles.code) ? (g.values.captured ? 'çalışma anında yakalandı' : 'statik') : 'bilinmiyor',
        source: sourceOf(vm, g.sites[0]),
        sites: g.sites.length,
        depth,
      };
      const a = analyzeVm(vm, g.values, { used, steps, origin });
      firstAnalysis = firstAnalysis ?? a;
      ctx.findings?.vm?.push(serializable(a, { lifted: a.ok, raw: rawHash(vm), rawSource: gen(vm.fnPath.isProgram() ? vm.stmtPath.node : vm.fnPath.node).slice(0, 20000) }));
      if (!a.ok) continue;
      const comment = `${LIFT} | VM #${vm.id} | ${vm.style} | ${a.disasm.length} komut → ${a.blocksOut} blok | bytecode: ${origin.bytecode} | ham gövde: ${rawHash(vm)} | derinlik=${depth}`;
      t.addComment(a.lifted[0], 'leading', comment, false);
      if (!sites) {
        replaceInPlace(vm, a.lifted);
        touched.push({ fn: vm.fnPath.node, regs: vm.roles.regs });
      } else {
        const fnNode = vm.fnPath.node;
        const kp = keyPath(fnNode, vm.stmtPath.node);
        const clone = t.cloneNode(fnNode, true);
        let name;
        let k = gi;
        do { name = `${fnNode.id.name}_vm${k++}`; } while (used.has(name));
        used.add(name);
        clone.id = t.identifier(name);
        clone.leadingComments = null;
        clone.trailingComments = null;
        placeAt(clone, kp, a.lifted);
        vm.fnPath.insertAfter(clone);
        for (const s of g.sites) s.path.node.callee = t.identifier(name);
        touched.push({ fn: clone, regs: vm.roles.regs });
      }
      anyOk = true;
      gi++;
      lifted++;
      onLog(`vm-lift: VM #${vm.id} (${vm.style}, ${a.disasm.length} komut, bytecode ${origin.bytecode}) düz koda çevrildi`, 'info');
    }
    if (!anyOk && firstAnalysis) {
      annotate(vm, firstAnalysis);
      onLog(`vm-lift: VM #${vm.id} çevrilemedi (${firstAnalysis.reason}); handler'lar açıklandı`, 'warn');
    }
    if (anyOk && sites) {
      // orijinal yorumlayıcıya başka başvuru kalmadıysa kaldır
      const fn = vm.fnPath;
      fn.parentPath.scope.crawl();
      const b = fn.parentPath.scope.getBinding(fn.node.id.name);
      if (b && !b.referencePaths.some((r) => !r.findParent((x) => x === fn))) fn.remove();
    }
  }
  for (const tch of touched) scalarizeRegisters(tch.fn, tch.regs, used);
  if (lifted) bump('vmLift', lifted);
}

function sourceOf(vm, site) {
  const b = vm.loopPath.scope.getBinding(vm.roles.code);
  if (site && b?.kind === 'param') {
    const i = vm.fnPath.node.params.findIndex((p) => t.isIdentifier(p, { name: vm.roles.code }));
    const arg = site.path.node.arguments[i];
    return arg ? gen(arg).slice(0, 200) : null;
  }
  if (b?.path.isVariableDeclarator() && b.path.node.init) return gen(b.path.node.init).slice(0, 200);
  return null;
}

// Ham yorumlayıcının (döngü + handler'lar) özeti: rapordaki ham gövdeyle eşleştirme (E182)
function rawHash(vm) {
  return fnv1a(gen(vm.loopPath.node));
}

