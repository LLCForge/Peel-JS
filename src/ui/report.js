import { t, td } from '../i18n.js';

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

export function renderReport(root, report, onExport) {
  root.textContent = '';
  if (!report) {
    root.append(el('p', { class: 'placeholder' }, t('report.empty')));
    return;
  }
  const { runtime } = report;
  const exportBtn = el('button', { type: 'button', class: 'ghost rep-export' }, t('action.export'));
  exportBtn.addEventListener('click', onExport);

  root.append(el('div', { class: 'rep' },
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
    section('report.passes', passTimes(report.passTimes)),
    section('report.rollbacks', report.rollbacks.length
      ? table(['Pass', '', ''], report.rollbacks.map((r) => [r.id, `#${r.round}`, td(r.reason ?? '')]), ['mono', 'num', 'rep-muted'])
      : muted('report.rollbacks.none')),
    exportBtn,
  ));
}
