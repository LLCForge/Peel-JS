// Çıktıda kalan kodlanmış string'leri tanıma ve çözme denemesi (rapor için; kod değiştirilmez).
// Her aday için hangi kodlamalar denendiği ve okunabilirlik puanı en yüksek sonuç döner.

const MIN_LEN = 8;
const MAX_LEN = 4096;

// Okunabilir metin puanı: yazdırılabilir oran + harf/boşluk oranı + yaygın İngilizce harf sıklığı
const COMMON = 'etaoinshrdlu';
export function readability(s) {
  if (!s.length) return 0;
  let printable = 0;
  let prose = 0;
  let common = 0;
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if ((c >= 32 && c < 127) || c === 9 || c === 10 || c === 13 || c >= 0xa0) printable++;
    // düzyazı küçük harf ve boşluktan oluşur; yalnızca büyük harf/rakam dizileri (base32, hex) puan almaz
    if (/[a-z\s.,'"!?:;/-]/.test(ch)) prose++;
    if (ch === ' ' || COMMON.includes(ch)) common++;
  }
  return (printable / s.length) * 0.4 + (prose / s.length) * 0.3 + (common / s.length) * 0.3;
}

// İngilizce harf sıklığı (%) — ROT/Vigenère kaydırma seçimi için ki-kare
const EN_FREQ = [8.2, 1.5, 2.8, 4.3, 12.7, 2.2, 2.0, 6.1, 7.0, 0.15, 0.77, 4.0, 2.4, 6.7, 7.5, 1.9, 0.095, 6.0, 6.3, 9.1, 2.8, 0.98, 2.4, 0.15, 2.0, 0.074];
export function chiSquared(s) {
  const counts = new Array(26).fill(0);
  let n = 0;
  for (const ch of s.toLowerCase()) {
    const i = ch.charCodeAt(0) - 97;
    if (i >= 0 && i < 26) { counts[i]++; n++; }
  }
  if (!n) return Infinity;
  return counts.reduce((acc, c, i) => { const e = (EN_FREQ[i] / 100) * n; return acc + ((c - e) ** 2) / e; }, 0);
}

const bytesToLatin1 = (bytes) => String.fromCharCode(...bytes);
const bytesToUtf8 = (bytes) => {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes)); } catch { return null; }
};

function base64(s) {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(s) || s.length % 4 === 1) return null;
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '='));
    return [...bin].map((c) => c.charCodeAt(0));
  } catch { return null; }
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(s) {
  const t = s.toUpperCase().replace(/=+$/, '');
  if (!/^[A-Z2-7]+$/.test(t)) return null;
  const out = [];
  let bits = 0;
  let value = 0;
  for (const ch of t) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return out;
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(s) {
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(s) || s.length > 200) return null;
  let n = 0n;
  for (const ch of s) n = n * 58n + BigInt(B58.indexOf(ch));
  const out = [];
  while (n > 0n) { out.unshift(Number(n % 256n)); n /= 256n; }
  for (const ch of s) { if (ch !== '1') break; out.unshift(0); }
  return out;
}

// Ascii85 (<~ ~> sarmalı isteğe bağlı)
function base85(s) {
  const t = s.replace(/^<~/, '').replace(/~>$/, '').replace(/\s+/g, '');
  if (!/^[!-uz]+$/.test(t)) return null;
  const out = [];
  let group = [];
  for (const ch of t) {
    if (ch === 'z' && !group.length) { out.push(0, 0, 0, 0); continue; }
    group.push(ch.charCodeAt(0) - 33);
    if (group.length === 5) {
      let v = 0;
      for (const d of group) v = v * 85 + d;
      if (v > 0xffffffff) return null;
      out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
      group = [];
    }
  }
  if (group.length) {
    const n = group.length;
    while (group.length < 5) group.push(84);
    let v = 0;
    for (const d of group) v = v * 85 + d;
    for (let i = 0; i < n - 1; i++) out.push((v >>> (24 - 8 * i)) & 255);
  }
  return out;
}

function hex(s) {
  const t = s.replace(/^0x/i, '').replace(/[\s:]/g, '');
  if (!/^[0-9a-f]+$/i.test(t) || t.length % 2) return null;
  return t.match(/../g).map((h) => parseInt(h, 16));
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function htmlEntities(s) {
  if (!/&(#\d+|#x[0-9a-f]+|[a-z]+);/i.test(s)) return null;
  return s.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function rot(s, n) {
  return s.replace(/[a-z]/gi, (c) => {
    const base = c <= 'Z' ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base + n) % 26 + 26) % 26 + base);
  });
}

export const atbash = (s) => s.replace(/[a-z]/gi, (c) => {
  const base = c <= 'Z' ? 65 : 97;
  return String.fromCharCode(base + 25 - (c.charCodeAt(0) - base));
});

// Tek bayt XOR: 255 anahtar içinde okunabilirliği en yüksek olan
export function singleXor(bytes) {
  let best = null;
  for (let k = 1; k < 256; k++) {
    const text = bytesToLatin1(bytes.map((b) => b ^ k));
    const score = readability(text);
    if (!best || score > best.score) best = { key: k, text, score };
  }
  return best;
}

// Çok bayt XOR (Kasiski benzeri): anahtar uzunluğu 2..8 için her konumu ayrı tek bayt XOR olarak çöz
export function multiXor(bytes) {
  if (bytes.length < 16) return null;
  let best = null;
  for (let len = 2; len <= 8; len++) {
    const key = [];
    for (let i = 0; i < len; i++) {
      const column = bytes.filter((_, j) => j % len === i);
      key.push(singleXor(column).key);
    }
    const text = bytesToLatin1(bytes.map((b, j) => b ^ key[j % len]));
    const score = readability(text);
    if (!best || score > best.score + 0.02) best = { key, text, score };
  }
  return best;
}

// Vigenère: anahtar uzunluğu 2..8, her sütunda ROT ile en okunabilir kayma
export function vigenere(s) {
  const letters = s.replace(/[^a-z]/gi, '');
  if (letters.length < 16) return null;
  let best = null;
  for (let len = 2; len <= 8; len++) {
    const shifts = [];
    for (let i = 0; i < len; i++) {
      const col = [...letters].filter((_, j) => j % len === i).join('');
      let top = { n: 0, chi: Infinity };
      for (let n = 0; n < 26; n++) {
        const chi = chiSquared(rot(col, n));
        if (chi < top.chi) top = { n, chi };
      }
      shifts.push(top.n);
    }
    let j = 0;
    const text = s.replace(/[a-z]/gi, (c) => rot(c, shifts[j++ % len]));
    const score = readability(text);
    if (!best || score > best.score + 0.02) best = { key: shifts.map((n) => String.fromCharCode(97 + ((26 - n) % 26))).join(''), text, score };
  }
  return best;
}

// BigInt / bitsel paketleme: tek büyük sayı içinde 8 bit ya da 7 bit karakterler
export function unpackBigInt(s) {
  if (!/^\d{12,}n?$/.test(s)) return null;
  let n = BigInt(s.replace(/n$/, ''));
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 255n)); n >>= 8n; }
  return bytes;
}

// UTF-16 LE/BE (her ikinci bayt 0) bayt dizisi
function utf16(bytes) {
  if (bytes.length < 4 || bytes.length % 2) return null;
  const le = bytes.filter((_, i) => i % 2 === 1).every((b) => b === 0);
  const be = bytes.filter((_, i) => i % 2 === 0).every((b) => b === 0);
  if (!le && !be) return null;
  return bytes.filter((_, i) => (le ? i % 2 === 0 : i % 2 === 1)).map((b) => String.fromCharCode(b)).join('');
}

// Bir string için tüm adayları dene, en iyiyi döndür
export function decodeCandidates(s) {
  if (s.length < MIN_LEN || s.length > MAX_LEN) return [];
  const out = [];
  const push = (encoding, text, extra = {}) => {
    if (text == null || !text.length || text === s) return;
    out.push({ encoding, text: text.slice(0, 300), score: readability(text), ...extra });
  };
  const fromBytes = (name, bytes) => {
    if (!bytes || bytes.length < 4) return;
    const u = utf16(bytes);
    if (u) push(`${name}+utf16`, u);
    push(name, bytesToUtf8(bytes) ?? bytesToLatin1(bytes));
    const sx = singleXor(bytes);
    if (sx && sx.score > 0.85) push(`${name}+xor`, sx.text, { key: `0x${sx.key.toString(16)}` });
    const mx = multiXor(bytes);
    if (mx && mx.score > 0.9) push(`${name}+xor${mx.key.length}`, mx.text, { key: mx.key.map((k) => k.toString(16).padStart(2, '0')).join('') });
  };
  fromBytes('hex', hex(s));
  fromBytes('base64', base64(s));
  fromBytes('base32', base32(s));
  fromBytes('base58', base58(s));
  fromBytes('base85', base85(s));
  fromBytes('bigint', unpackBigInt(s));
  push('html', htmlEntities(s));
  if (/%[0-9a-f]{2}/i.test(s)) { try { push('percent', decodeURIComponent(s)); } catch { /* bozuk kaçış */ } }
  if (/[a-z]{4,}/i.test(s)) {
    let bestRot = null;
    for (let n = 1; n < 26; n++) {
      const text = rot(s, n);
      const chi = chiSquared(text);
      if (!bestRot || chi < bestRot.chi) bestRot = { n, text, chi };
    }
    if (bestRot) push(`rot${bestRot.n}`, bestRot.text, { subst: true });
    push('atbash', atbash(s), { subst: true });
    const v = vigenere(s);
    if (v) push('vigenere', v.text, { key: v.key, subst: true });
  }
  // yalnızca orijinalden belirgin biçimde daha okunabilir sonuçlar
  const base = readability(s);
  // karmaşık kodlamalar (anahtar serbestliği yüksek) aşırı uyum gösterir: küçük ceza
  const penalty = (c) => (c.encoding === 'vigenere' ? 0.08 : /xord/.test(c.encoding) ? 0.04 : 0);
  // harf değiştirme şifreleri: okunabilirlik zaten yüksek olabilir; İngilizce sıklığa belirgin yaklaşma aranır
  const chiBase = chiSquared(s);
  const accept = (c) => (c.subst ? chiSquared(c.text) < chiBase / 3 && c.score > 0.75 : c.score > Math.max(0.75, base + 0.1));
  return out.filter(accept).map(({ subst, ...c }) => c)
    .sort((a, b) => (b.score - penalty(b)) - (a.score - penalty(a))).slice(0, 3);
}

// E95: kodlama raporu — çıktıdaki string'lerden çözülebilen adaylar
export function encodingReport(strings) {
  const rows = [];
  for (const s of strings) {
    const c = decodeCandidates(s);
    if (c.length) rows.push({ value: s.slice(0, 120), best: c[0], others: c.slice(1) });
    if (rows.length >= 50) break;
  }
  return rows;
}
