import { getLang } from '../../i18n.js';

// Çalışma anı arayüz modülleri için küçük DOM yardımcıları. Tüm metinler textContent ile yazılır (rapor verisi
// sandbox'tan gelir: güvenilmez). Uygulamanın mevcut sınıfları kullanılır; yeni stil eklenmez.

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c instanceof Node ? c : String(c));
  return node;
}

const STR = {
  tr: {
    runtime: 'Çalışma anı', settings: 'Sandbox ayarları', profile: 'Tarayıcı profili', now: 'Zaman (zaman makinesi)', seed: 'Rastgelelik tohumu',
    cookie: 'Çerez (document.cookie)', storage: 'localStorage (JSON nesnesi)', responses: 'Sahte yanıtlar (JSON dizisi: match, status, body)',
    memory: 'Bellek sınırı (MB)', timeout: 'Süre sınırı (ms)', verifyLevel: 'Doğrulama seviyesi', watch: 'İzlenen yollar (virgülle; ör. navigator.userAgent)',
    save: 'Kaydet', reset: 'Varsayılan', saved: 'Kaydedildi; sonraki çalıştırmada uygulanır.', invalid: 'Geçersiz alan', engineDefault: 'motor varsayılanı',
    coverage: 'Coverage', covered: 'çalışan deyim', callgraph: 'Çalışma anı çağrı grafiği', calls: 'çağrı', loops: 'Döngüler', traps: 'Sonsuz döngü / anti-debug tuzakları',
    infinite: 'Program zaman aşımına uğradı; olası sonsuz döngü', taint: 'Taint akışları', dyncode: 'Çalışma anında üretilen kod', wasm: 'WebAssembly modülleri',
    workers: 'Worker kodu (ayrı sandbox)', fp: 'Canvas / WebGL / Audio parmak izi çağrıları', hooks: 'Kanca kayıtları', effects: 'Etki günlüğü',
    trust: 'Güven skoru', passRisk: 'Pass riski', success: 'Başarı metriği', checks: 'Doğrulama denetimleri', failure: 'Başarısız kanıt raporu', rationale: 'Dönüşüm gerekçeleri',
    memoryUse: 'Bellek kullanımı', telemetry: 'Motor telemetrisi', observed: 'gözlemle üretilen değer', hit: 'çalıştı', miss: 'çalışmadı',
    tools: 'Araçlar', compare: 'Profilleri karşılaştır', realdom: 'Gerçek DOM\'da çalıştır', consent: 'Kodun gerçek tarayıcı motorunda, ağ ve sayfa erişimi engellenmiş yalıtılmış bir çerçevede çalışmasını onaylıyorum.',
    fuzz: 'Diferansiyel fuzz', equiv: 'Fonksiyon denkliği', determinism: 'Determinizm ve idempotans', replay: 'Kaydet ve yeniden oynat', escape: 'Kaçış testi paketi',
    issue: 'Yanlış sonuç bildir', proof: 'İmzalı kanıt paketi', signedReport: 'İmzalı rapor', running: 'Çalışıyor…', none: 'yok', step: 'Adım',
    skipped: 'atlandı', passed: 'geçti', failed: 'başarısız', noSandbox: 'Sandbox yok', mutation: 'Doğrulama gücü (mutant)', copy: 'Panoya kopyala', download: 'İndir',
    includeCode: 'Kodu ekle (maskelenmiş)', ms: 'ms', level: 'seviye', budget: 'bütçe',
  },
  en: {
    runtime: 'Runtime', settings: 'Sandbox settings', profile: 'Browser profile', now: 'Time (time machine)', seed: 'Random seed',
    cookie: 'Cookie (document.cookie)', storage: 'localStorage (JSON object)', responses: 'Fake responses (JSON array: match, status, body)',
    memory: 'Memory limit (MB)', timeout: 'Time limit (ms)', verifyLevel: 'Verification level', watch: 'Watched paths (comma separated, e.g. navigator.userAgent)',
    save: 'Save', reset: 'Defaults', saved: 'Saved; applied on the next run.', invalid: 'Invalid field', engineDefault: 'engine default',
    coverage: 'Coverage', covered: 'statements executed', callgraph: 'Runtime call graph', calls: 'calls', loops: 'Loops', traps: 'Infinite loop / anti-debug traps',
    infinite: 'The program timed out; possible infinite loop', taint: 'Taint flows', dyncode: 'Code generated at runtime', wasm: 'WebAssembly modules',
    workers: 'Worker code (separate sandbox)', fp: 'Canvas / WebGL / Audio fingerprint calls', hooks: 'Hook records', effects: 'Effect log',
    trust: 'Trust score', passRisk: 'Pass risk', success: 'Success metric', checks: 'Verification checks', failure: 'Failed proof report', rationale: 'Transformation rationale',
    memoryUse: 'Memory use', telemetry: 'Engine telemetry', observed: 'value produced by observation', hit: 'executed', miss: 'not executed',
    tools: 'Tools', compare: 'Compare profiles', realdom: 'Run in real DOM', consent: 'I consent to running the code in the real browser engine inside an isolated frame with network and page access blocked.',
    fuzz: 'Differential fuzz', equiv: 'Function equivalence', determinism: 'Determinism and idempotence', replay: 'Record and replay', escape: 'Escape test suite',
    issue: 'Report wrong result', proof: 'Signed proof bundle', signedReport: 'Signed report', running: 'Running…', none: 'none', step: 'Step',
    skipped: 'skipped', passed: 'passed', failed: 'failed', noSandbox: 'No sandbox', mutation: 'Verification strength (mutants)', copy: 'Copy', download: 'Download',
    includeCode: 'Include code (masked)', ms: 'ms', level: 'level', budget: 'budget',
  },
};

export const tx = (k) => STR[getLang()]?.[k] ?? STR.tr[k] ?? k;

export function section(title, ...body) {
  return el('section', { class: 'rep-section' }, el('h3', {}, title), ...body);
}

export const muted = (text) => el('p', { class: 'rep-muted' }, text);

export function table(headers, rows, classes = [], max = 60) {
  return el('table', { class: 'rep-table' },
    el('thead', {}, el('tr', {}, ...headers.map((h) => el('th', {}, h)))),
    el('tbody', {}, ...rows.slice(0, max).map((r) => el('tr', {}, ...r.map((c, i) => el('td', { class: classes[i] ?? '' }, c instanceof Node ? c : String(c ?? '')))))));
}

export function button(label, onClick) {
  return el('button', { type: 'button', class: 'ghost', onclick: onClick }, label);
}

export function download(name, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  el('a', { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
