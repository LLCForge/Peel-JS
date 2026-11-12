import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import { deobfuscate } from './core/pipeline.js';
import { analyze } from './core/analyze.js';
import { sandbox } from './sandbox/client.js';
import { initPanels, els, setOutput } from './ui/panels.js';
import { log, clearLog, toggleLog } from './ui/log.js';
import { renderDiff } from './ui/diff.js';
import { renderReport } from './ui/report.js';
import { createTimeline } from './ui/timeline.js';
import { t, applyI18n, toggleLang } from './i18n.js';
import { SAMPLE } from './sample.js';
import { maskSecrets } from './core/threat.js';

const $ = (id) => document.getElementById(id);
const status = $('status');
const stats = $('stats');
const passbar = $('passbar');
const runBtn = $('btn-run');
const stopBtn = $('btn-stop');
const logBtn = $('btn-log');
const empty = $('empty');
const views = { code: els.output, report: $('view-report'), timeline: $('view-timeline'), diff: $('view-diff') };
const tabs = [...document.querySelectorAll('[role="tab"]')];
const timeline = createTimeline(views.timeline);

// Her çalıştırma tüm pass'leri en yüksek seviyede çalıştırır; davranış testi yanlış dönüşümü geri alır
const LEVEL = 4;

let sandboxOk = true;
let controller = null;
let lastStatus = ['status.ready', {}, ''];
let lastStats = {};
let lastReport = null;
let diffDirty = true;
let activeTab = 'code';

function setStatus(key, vars = {}, cls = '') {
  lastStatus = [key, vars, cls];
  status.textContent = t(key, vars);
  status.className = cls;
}

function setStats(o) {
  lastStats = o;
  stats.textContent = '';
  for (const [k, v] of Object.entries(o)) {
    if (!v) continue;
    const s = document.createElement('span');
    const b = document.createElement('b');
    b.textContent = v.toLocaleString();
    s.append(b, ` ${t(`stat.${k}`)}`);
    stats.appendChild(s);
  }
}

// Kodun cihazdan çıkmadığının kanıtı: sayfanın kendi kökeni dışına giden istek sayısı
function updateNetworkBadge() {
  const external = performance.getEntriesByType('resource')
    .filter((e) => {
      try {
        const u = new URL(e.name);
        return /^https?:$/.test(u.protocol) && u.origin !== location.origin; // data:/blob: yerel kaynaktır
      } catch {
        return false;
      }
    });
  const badge = $('net');
  badge.hidden = false;
  badge.classList.toggle('leak', external.length > 0);
  badge.textContent = external.length ? `${external.length} external` : t('status.offline');
}

function setLog(open) {
  logBtn.setAttribute('aria-expanded', String(toggleLog(open)));
}

function selectTab(name, focus = false) {
  activeTab = name;
  for (const tab of tabs) {
    const on = tab.id === `tab-${name}`;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    if (on && focus) tab.focus();
  }
  for (const [key, view] of Object.entries(views)) view.hidden = key !== name;
  if (name === 'diff' && diffDirty) {
    renderDiff(views.diff, els.input.value, els.output.value);
    diffDirty = false;
  }
}

function syncEmpty() {
  empty.hidden = els.input.value.length > 0;
}

function markPass(id, state) {
  let seg = passbar.querySelector(`i[data-id="${CSS.escape(id)}"]`);
  if (!seg) {
    seg = document.createElement('i');
    seg.dataset.id = id;
    seg.title = id;
    passbar.appendChild(seg);
  }
  // birden çok turda en iyi sonucu koru: bir kez değişiklik yapan pass işaretli kalır
  if (state === 'skip' && seg.className === 'ok') return;
  seg.className = state;
}

function resetResults() {
  setStats({});
  clearLog();
  passbar.textContent = '';
  lastReport = null;
  renderReport(views.report, null);
  timeline.reset();
  diffDirty = true;
}

async function run() {
  if (controller) return;
  const src = els.input.value;
  if (!src.trim()) {
    setStatus('status.empty', {}, 'err');
    els.input.focus();
    return;
  }

  controller = new AbortController();
  runBtn.disabled = true;
  runBtn.setAttribute('aria-busy', 'true');
  stopBtn.hidden = false;
  resetResults();
  setStatus('status.running', {}, 'busy');
  const t0 = performance.now();
  try {
    const res = await deobfuscate(src, {
      level: LEVEL,
      sandbox: sandboxOk ? sandbox : null,
      deep: sandboxOk,
      signal: controller.signal,
      onLog: log,
      onPass: markPass,
      onSnapshot: (s) => timeline.push(s),
    });
    setOutput(res.code);
    timeline.finish();
    if (res.error) {
      log(`Parse: ${res.error}`, 'err');
      setStatus('status.parse', {}, 'err');
      setLog(true);
      return;
    }
    setStats(res.stats);
    const s = ((performance.now() - t0) / 1000).toFixed(2);
    log(`OK (${s}s)`, 'ok');
    if (sandboxOk && !res.verified) {
      // program sandbox'ta çalışamadı: değişiklikler yalnızca sözdizimi düzeyinde doğrulandı
      log(t('status.unverified', { s }), 'warn');
      setStatus('status.unverified', { s }, 'err');
    } else {
      setStatus(res.code.trim() === src.trim() ? 'status.unchanged' : 'status.done', { s }, 'ok');
    }
    lastReport = await analyze({ input: src, text: res.text, output: res.code, events: res.events, sandbox: sandboxOk ? sandbox : null });
    lastReport.stats = res.stats;
    renderReport(views.report, lastReport, exportReport, reportActions);
  } catch (e) {
    log(e.message, 'err');
    if (controller.signal.aborted) setStatus('status.stopped', {}, 'err');
    else setStatus('status.error', { m: e.message }, 'err');
  } finally {
    controller = null;
    runBtn.disabled = false;
    runBtn.removeAttribute('aria-busy');
    stopBtn.hidden = true;
    updateNetworkBadge();
  }
}

function stop() {
  if (!controller) return;
  controller.abort();
  sandbox.kill();
  log(t('status.stopped'), 'warn');
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportReport() {
  if (lastReport) download('peel-report.json', JSON.stringify(lastReport, null, 2), 'application/json');
}

// Rapor eylemleri: YARA / Suricata kuralları ve anahtarları maskelenmiş çıktı (paylaşmadan önce)
const reportActions = {
  yara: () => lastReport?.threat?.yara && download('peel.yar', lastReport.threat.yara, 'text/plain'),
  ids: () => lastReport?.threat?.ids && download('peel.rules', lastReport.threat.ids, 'text/plain'),
  masked: () => {
    const { code, count } = maskSecrets(els.output.value);
    download('peeled.masked.js', code, 'text/javascript');
    setStatus('status.masked', { n: count }, 'ok');
  },
};

function loadSample() {
  els.input.value = SAMPLE;
  els.input.dispatchEvent(new Event('input'));
  els.input.focus();
}

runBtn.addEventListener('click', run);
stopBtn.addEventListener('click', stop);
$('btn-load').addEventListener('click', () => els.fileInput.click());
$('btn-empty-open').addEventListener('click', () => els.fileInput.click());
$('btn-sample').addEventListener('click', loadSample);
$('btn-empty-sample').addEventListener('click', loadSample);
$('btn-clear').addEventListener('click', () => {
  els.input.value = '';
  els.input.dispatchEvent(new Event('input'));
  setOutput('');
  resetResults();
  setStatus('status.ready');
  els.input.focus();
});
$('btn-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(els.output.value);
    setStatus('status.copied', {}, 'ok');
  } catch {
    setStatus('status.copyFail', {}, 'err');
  }
});
$('btn-dl').addEventListener('click', () => download('peeled.js', els.output.value, 'text/javascript'));
logBtn.addEventListener('click', () => setLog());
$('btn-lang').addEventListener('click', () => {
  toggleLang();
  setStatus(...lastStatus);
  setStats(lastStats);
  renderReport(views.report, lastReport, exportReport, reportActions);
  timeline.render();
  diffDirty = true;
  if (activeTab === 'diff') selectTab('diff');
  updateNetworkBadge();
});

for (const tab of tabs) {
  tab.addEventListener('click', () => selectTab(tab.id.slice(4)));
  tab.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = tabs.indexOf(tab) + (e.key === 'ArrowRight' ? 1 : -1);
    selectTab(tabs[(i + tabs.length) % tabs.length].id.slice(4), true);
  });
}

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); }
});

initPanels({
  onInputChange: (n) => {
    $('in-info').textContent = n.toLocaleString();
    diffDirty = true;
    syncEmpty();
  },
  onOutputChange: (n) => {
    $('out-info').textContent = n.toLocaleString();
    diffDirty = true;
    for (const id of ['btn-copy', 'btn-dl']) $(id).disabled = n === 0;
  },
  onError: (msg) => { log(msg, 'err'); status.textContent = msg; status.className = 'err'; },
});

applyI18n();
setStatus('status.ready');
renderReport(views.report, null);
timeline.reset();
syncEmpty();
updateNetworkBadge();

sandbox.health().then((ok) => {
  sandboxOk = ok;
  if (ok) return;
  log('Sandbox unavailable', 'warn');
  setStatus('status.nosandbox', {}, 'err');
});
