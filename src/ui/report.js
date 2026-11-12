import { t, td } from '../i18n.js';
import { renderVmReport } from './vm/index.js';
import { render as renderSemantics } from './analysis/semantics.js';

const MAX_ROWS = 60;

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

function section(titleKey, ...body) {
  return el('section', { class: 'rep-section' }, el('h3', {}, t(titleKey)), ...body);
}

const muted = (key) => el('p', { class: 'rep-muted' }, t(key));
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

function detection(fp) {
  if (!fp.length) return muted('report.detect.none');
  return el('div', { class: 'detect' }, ...fp.map((f) => el('div', { class: 'detect-row' },
    el('span', { class: 'detect-name' }, td(f.name), el('small', {}, `${Math.round(f.confidence * 100)}%`)),
    el('span', { class: 'detect-ev' }, f.evidence.map(td).join(' · ')))));
}

function metrics(m) {
  const row = (key, before, after) => [el('dt', {}, t(key)), el('dd', {}, before === undefined ? '' : String(before)), el('dd', {}, after)];
  const dl = el('dl', { class: 'kv' });
  for (const cells of [
    row('report.metric.size', kb(m.inBytes), `→ ${kb(m.outBytes)}`),
    row('report.metric.hexCalls', m.hexCallsBefore, `→ ${m.hexCallsAfter}`),
    row('report.metric.ids', m.obfuscatedIdsBefore, `→ ${m.obfuscatedIdsAfter}`),
    row('report.metric.vm', undefined, String(m.vmMarks)),
    row('report.metric.functions', undefined, String(m.functions)),
    row('report.metric.hash', undefined, m.outputHash),
  ]) dl.append(...cells);
  return dl;
}

function table(headers, rows, classes) {
  return el('table', { class: 'rep-table' },
    el('thead', {}, el('tr', {}, ...headers.map((h) => el('th', {}, h)))),
    el('tbody', {}, ...rows.slice(0, MAX_ROWS).map((r) => el('tr', {}, ...r.map((c, i) => el('td', { class: classes[i] ?? '' }, String(c)))))));
}

function iocs(data) {
  const groups = ['domains', 'urls', 'ips', 'emails', 'wallets', 'jwts', 'secrets'].filter((k) => data[k]?.length);
  if (!groups.length) return muted('report.iocs.none');
  return el('div', {}, ...groups.map((k) => el('div', { class: 'ioc-group' },
    el('h4', {}, `${t(`report.ioc.${k}`)} (${data[k].length})`),
    el('ul', { class: 'ioc-list' }, ...data[k].slice(0, MAX_ROWS).map((v) => el('li', {}, v))))));
}

function passTimes(list) {
  const max = Math.max(1, ...list.map((p) => p.ms));
  return el('div', { class: 'bars' }, ...list.slice(0, 16).map((p) => {
    const bar = el('i');
    bar.style.width = `${Math.max(2, (p.ms / max) * 100)}%`;
    return el('div', { class: 'bar' }, el('span', {}, p.id), el('span', {}, bar), el('span', {}, `${p.ms} ms`));
  }));
}

function threat(th, runtime, actions) {
  const risk = el('div', { class: `risk risk-${th.risk.level}` },
    el('b', {}, String(th.risk.score)), el('span', {}, t(`report.risk.${th.risk.level}`)));
  const classes = th.classes.length
    ? table([t('report.threat.class'), t('report.threat.evidence')], th.classes.map((c) => [t(`report.class.${c.id}`), c.evidence.map(td).join(' · ')]), ['', 'rep-muted'])
    : muted('report.threat.none');
  const libs = th.libraries.length
    ? el('div', { class: 'chips' }, ...th.libraries.map((l) => el('span', { class: 'chip' }, l.name, l.version ? el('b', {}, l.version) : null)))
    : muted('report.libs.none');
  const pv = th.privacy;
  const dl = el('dl', { class: 'kv' });
  const row = (key, value) => dl.append(el('dt', {}, t(key)), el('dd', {}, value), el('dd', {}, ''));
  row('report.privacy.third', pv.thirdParties.join(', ') || '–');
  row('report.privacy.cookies', t(pv.cookies ? 'yes' : 'no'));
  row('report.privacy.storage', t(pv.storage ? 'yes' : 'no'));
  row('report.privacy.fp', pv.fingerprinting.join(', ') || '–');
  const post = runtime.post;
  if (post) {
    row('report.post.fired', `${post.fired} (${[...new Set(post.handlers)].join(', ') || '–'}; setInterval: ${post.timers})`);
    row('report.post.globals', post.globals.map((g) => `${g.name}: ${g.type}`).join(', ') || '–');
  }
  row('report.missing', th.missingGlobals.join(', ') || '–');
  const crypto = runtime.crypto?.length
    ? table(['op', 'alg', 'data'], runtime.crypto.map((c) => [c.op, c.alg, c.data || '–']), ['mono', 'mono', 'mono'])
    : null;
  const btn = (key, fn) => {
    const b = el('button', { type: 'button', class: 'ghost' }, t(key));
    b.addEventListener('click', fn);
    return b;
  };
  return el('div', {}, risk, classes,
    el('h4', {}, t('report.libs')), libs,
    el('h4', {}, t('report.privacy')), dl,
    crypto ? el('h4', {}, t('report.crypto')) : null, crypto,
    el('div', { class: 'rep-actions' },
      th.yara ? btn('action.yara', actions.yara) : null,
      th.ids ? btn('action.ids', actions.ids) : null,
      btn('action.masked', actions.masked)));
}

function vmSection(data) {
  const box = el('div');
  renderVmReport(box, data);
  return box;
}

// Çözme motoru analizi: obfuscator ayarları, akış, bütünlük, ölü kod türleri, paket modülleri
function engine(e, stats) {
  const parts = [];
  if (e.obfuscator) {
    const dl = el('dl', { class: 'kv' });
    for (const [k, v] of Object.entries(e.obfuscator.settings)) dl.append(el('dt', { class: 'mono' }, k), el('dd', {}, String(v)), el('dd', {}, ''));
    parts.push(el('h4', {}, t('report.engine.obf')), dl, el('p', { class: 'rep-muted' }, e.obfuscator.evidence.join(' · ')));
  }
  const f = e.flow;
  if (f) {
    parts.push(el('h4', {}, t('report.engine.flow')), el('p', {}, t('report.engine.flowStats', {
      f: f.functions, l: f.loops, d: f.maxDepth, c: f.complexity, b: f.dispatchersBefore ?? '–', a: f.dispatchersAfter,
    })));
    parts.push(el('h4', {}, t('report.engine.recursion')), f.recursion.length
      ? el('div', { class: 'chips' }, ...f.recursion.map((r) => el('span', { class: 'chip' }, r.functions.join(' ↔ '), el('b', {}, r.kind))))
      : muted('report.engine.recursion.none'));
    if (f.mostComplex.length) {
      parts.push(el('h4', {}, t('report.engine.complex')),
        table(['Fn', '#', ''], f.mostComplex.map((x) => [x.name, x.cyclomatic, x.line ?? '']), ['mono', 'num', 'num']));
    }
    if (f.unresolved.length) {
      parts.push(el('h4', {}, t('report.engine.unresolved')), ...f.unresolved.map((u) => el('details', {},
        el('summary', {}, `${u.function} · ${u.discriminant} · ${u.states}/${u.edges}`),
        el('pre', { class: 'mono' }, u.mermaid), el('pre', { class: 'mono' }, u.dot))));
    }
  }
  const ig = e.integrity;
  if (ig) {
    parts.push(el('h4', {}, t('report.engine.integrity')), ig.checks.length
      ? el('div', {}, el('p', {}, t('report.engine.integrity.summary', { n: ig.checks.length, x: ig.neutralized, r: ig.remaining })),
        table(['', 'Fn', 'Hash', ''], ig.checks.map((c) => [c.kind, c.function ?? '–', c.hasher, c.protects]), ['mono', 'mono', 'mono', 'mono']))
      : muted('report.engine.integrity.none'));
    if (ig.console.length) {
      parts.push(el('h4', {}, t('report.engine.console')), table(['', '', ''], ig.console.map((c) => [c.kind, c.where, c.detail]), ['mono', '', 'rep-muted']));
    }
  }
  const dead = e.deadCode ?? Object.entries(stats ?? {}).filter(([k, v]) => k.startsWith('dead.') && v > 0)
    .map(([k, count]) => ({ type: k.slice(5), count })).sort((a, b) => b.count - a.count);
  parts.push(el('h4', {}, t('report.engine.dead')), dead.length
    ? table(['', '#'], dead.map((d) => [d.type, d.count]), ['mono', 'num'])
    : muted('report.engine.dead.none'));
  parts.push(el('h4', {}, t('report.engine.bundle', { k: e.bundle?.kind ?? '–' })), e.bundle
    ? table(['Modül', 'B', 'Bağımlılık'], e.bundle.modules.map((m) => [m.id, m.size, m.deps.join(', ') || '–']), ['mono', 'num', 'mono'])
    : muted('report.engine.bundle.none'));
  return el('div', {}, ...parts);
}

function semanticsBody(data) {
  const box = el('div', { class: 'rep-semantics' });
  renderSemantics(box, data);
  return box;
}

export function renderReport(root, report, onExport, actions = {}) {
  root.textContent = '';
  if (!report) {
    root.append(el('p', { class: 'placeholder' }, t('report.empty')));
    return;
  }
  const { runtime } = report;
  const exportBtn = el('button', { type: 'button', class: 'ghost rep-export' }, t('action.export'));
  exportBtn.addEventListener('click', onExport);

  root.append(el('div', { class: 'rep' },
    report.threat ? section('report.threat', threat(report.threat, runtime, actions)) : null,
    section('report.detect', detection(report.fingerprint)),
    section('report.metrics', metrics(report.metrics)),
    section('report.network',
      runtime.error ? el('p', { class: 'rep-error' }, t('report.runtimeError', { m: runtime.error })) : null,
      runtime.network.length
        ? table(['API', 'Method', 'URL', 'Body'], runtime.network.map((n) => [n.api, n.method || '–', n.url, n.body || '–']), ['', '', 'mono', 'mono'])
        : muted('report.network.none')),
    section('report.reads', runtime.reads.length
      ? el('div', { class: 'chips' }, ...runtime.reads.slice(0, 80).map((r) => el('span', { class: 'chip' }, r.key, el('b', {}, String(r.count)))))
      : muted('report.reads.none')),
    section('report.apis', report.apis.length
      ? table(['API', '', '#'], report.apis.map((a) => [a.name, td(a.why), a.count]), ['mono', 'rep-muted', 'num'])
      : muted('report.apis.none')),
    section('report.iocs', iocs(report.iocs)),
    section('report.encodings', report.encodings?.length
      ? table([t('report.enc.value'), t('report.enc.kind'), t('report.enc.decoded')],
        report.encodings.map((e) => [e.value, e.best.key ? `${e.best.encoding} (${e.best.key})` : e.best.encoding, e.best.text]), ['mono', 'mono', 'mono'])
      : muted('report.encodings.none')),
    report.vm ? section('report.vm', vmSection(report.vm)) : null,
    section('report.passes', passTimes(report.passTimes)),
    section('report.rollbacks', report.rollbacks.length
      ? table(['Pass', '', ''], report.rollbacks.map((r) => [r.id, `#${r.round}`, td(r.reason ?? '')]), ['mono', 'num', 'rep-muted'])
      : muted('report.rollbacks.none')),
    report.engine ? section('report.engine', engine(report.engine, report.stats)) : null,
    report.semantics ? section('report.semantics', semanticsBody(report.semantics)) : null,
    exportBtn,
  ));
}
