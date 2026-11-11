import { t } from '../i18n.js';

// LCS tablosu n*m hücre: büyük dosyada belleği patlatmasın
const MAX_CELLS = 4_000_000;

function lcs(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push(['same', a[i]]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push(['del', a[i]]); i++; }
    else { out.push(['add', b[j]]); j++; }
  }
  while (i < n) out.push(['del', a[i++]]);
  while (j < m) out.push(['add', b[j++]]);
  return out;
}

export function renderDiff(el, a, b) {
  el.textContent = '';
  const h = document.createElement('div');
  h.className = 'hdr';
  h.textContent = t('diff.header');
  el.appendChild(h);

  const left = a.split('\n');
  const right = b.split('\n');
  if (left.length * right.length > MAX_CELLS) {
    const msg = document.createElement('p');
    msg.className = 'placeholder';
    msg.textContent = t('diff.tooBig', { a: left.length, b: right.length });
    el.appendChild(msg);
    return;
  }

  const frag = document.createDocumentFragment();
  let ln = 1;
  for (const [kind, text] of lcs(left, right)) {
    const r = document.createElement('div');
    r.className = kind === 'same' ? 'row' : `row ${kind}`;
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = kind === 'del' ? '' : String(ln++);
    const c = document.createElement('span');
    c.className = 'c';
    c.textContent = text;
    r.append(n, c);
    frag.appendChild(r);
  }
  el.appendChild(frag);
}
