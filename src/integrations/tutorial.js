import { TECHNIQUES } from './techniques.js';

// Eğitim modu (J191): her pass'in ne yaptığı ve bir dersin adım adım oynatılması.
// Ders, ansiklopedideki gerçek örneği gerçek motorla çözer; her anlık görüntü (onSnapshot) bir adım olur
// ve o adımı üreten pass'in açıklamasıyla gösterilir.

export const PASS_DOCS = {
  normalize: {
    tr: 'Parse edilemeyen girdiyi düzeltir (BOM, HTML yorum işaretleri gibi). Geçerli koda dokunmaz.',
    en: 'Repairs input that does not parse (BOM, HTML comment markers). Leaves valid code untouched.',
  },
  unpack: {
    tr: 'eval(...), Function(...) ve packer gibi programı string içinde taşıyan sarmalayıcıları açar.',
    en: 'Unwraps eval(...), Function(...) and packer wrappers that carry the program inside a string.',
  },
  predecoders: {
    tr: 'JSFuck, aaencode, jjencode gibi kendini çalıştıran kodlamaları sandbox\'ta çalıştırıp içindeki programı çıkarır.',
    en: 'Runs self-executing encodings (JSFuck, aaencode, jjencode) in the sandbox and extracts the inner program.',
  },
  literals: {
    tr: 'Okunabilirlik: 0x1f → 31, "\\x48" → "H", a["b"] → a.b; anlamı değiştirmez.',
    en: 'Readability: 0x1f → 31, "\\x48" → "H", a["b"] → a.b; meaning is unchanged.',
  },
  'const-arrays': {
    tr: 'Hiç değiştirilmeyen ve yalnızca sabit indeksle okunan literal dizilerinin elemanlarını yerine yazar.',
    en: 'Inlines elements of literal arrays that are never mutated and only read with constant indexes.',
  },
  'const-objects': {
    tr: 'Sabit değer ve küçük vekil fonksiyon taşıyan nesneleri (obfuscator.io kontrol nesneleri) yerine yazar.',
    en: 'Inlines objects holding constants and tiny proxy functions (obfuscator.io control objects).',
  },
  wrappers: {
    tr: 'Argümanları yalnızca başka bir çağrıya ileten sarmalayıcı fonksiyonları kaldırır.',
    en: 'Removes wrapper functions that only forward their arguments to another call.',
  },
  'string-array': {
    tr: 'String dizisini ve çözücüsünü sandbox\'ta çalıştırır (rotasyon dahil), her çağrıyı gerçek string\'le değiştirir.',
    en: 'Runs the string array and its decoder in the sandbox (rotation included) and replaces each call with the real string.',
  },
  'runtime-decoders': {
    tr: 'Closure içindeki çözücüleri çalışma anında yakalar ve literal argümanlı çağrıları sonuçlarıyla değiştirir.',
    en: 'Captures decoders hidden in closures at runtime and replaces calls with literal arguments by their results.',
  },
  'runtime-functions': {
    tr: 'Çalışma anında new Function ile üretilen fonksiyonların kaynağını yakalayıp koda geri koyar.',
    en: 'Captures the source of functions generated at runtime with new Function and puts it back into the code.',
  },
  proxy: {
    tr: 'Yalnızca bir işlemi ya da çağrıyı ileten vekil fonksiyonları kullanıldıkları yere açar.',
    en: 'Inlines proxy functions that only forward one operation or call.',
  },
  'const-fold': {
    tr: 'Sabit ifadeleri hesaplar ("a" + "b" → "ab", 3 * 4 → 12); şüpheli olanları sandbox\'ta doğrular.',
    en: 'Evaluates constant expressions ("a" + "b" → "ab", 3 * 4 → 12), checking doubtful ones in the sandbox.',
  },
  'dead-code': {
    tr: 'Hiç çalışmayan dalları, debugger korumalarını ve kendini savunma kodunu kaldırır.',
    en: 'Removes branches that never run, debugger protection and self-defending code.',
  },
  opaque: {
    tr: 'Sonucu her zaman aynı olan koşulları ("x" === "x") sabitine indirger.',
    en: 'Reduces conditions that always have the same result ("x" === "x") to constants.',
  },
  'state-var': {
    tr: 'switch(P + Q + R) gibi hesaplanan durumları tek bir durum değişkenine toplar; sonraki pass\'lere zemin hazırlar.',
    en: 'Gathers computed switch states such as switch(P + Q + R) into one state variable for later passes.',
  },
  unflatten: {
    tr: 'Durum makinesine çevrilmiş kodu, durum geçişlerini izleyerek yeniden düz koda çevirir.',
    en: 'Turns state-machine code back into straight-line code by following the state transitions.',
  },
  vm: {
    tr: 'Döngü içindeki durum makinelerini tespit eder ve gözlenen geçişleri koda yorum olarak yazar; kodu değiştirmez.',
    en: 'Detects state machines in loops and writes observed transitions as comments; does not change code.',
  },
  'control-flow': {
    tr: '"2|0|1".split("|") ile sıralanan switch döngülerini gerçek sıraya dizer.',
    en: 'Reorders switch loops driven by "2|0|1".split("|") into their real order.',
  },
  simplify: {
    tr: 'Anlamı birebir koruyan küçük sadeleştirmeler: !0 → true, void 0 → undefined, virgül ifadelerini deyimlere ayırma.',
    en: 'Small meaning-preserving cleanups: !0 → true, void 0 → undefined, splitting comma expressions.',
  },
  unused: {
    tr: 'Hiç kullanılmayan değişken ve fonksiyonları siler (eval/with varsa dokunmaz).',
    en: 'Deletes variables and functions that are never used (skipped when eval/with is present).',
  },
  rename: {
    tr: 'Üretilmiş _0x adlarını türüne göre okunur adlarla değiştirir (fn1, arg1, v1); anlamlı adlara dokunmaz.',
    en: 'Renames generated _0x names by kind (fn1, arg1, v1); meaningful names are left alone.',
  },
};

export const LESSONS = TECHNIQUES.filter((x) => x.example);

/**
 * Dersi gerçek motorla oynatır ve adımları döndürür.
 * @param {string} id  teknik kimliği
 * @param {(input: string, o: object) => Promise<object>} deobfuscate  pipeline.deobfuscate
 * @param {object} [o]  deobfuscate seçenekleri (sandbox vb.)
 * @returns {Promise<{lesson: object, steps: Array<{pass: string, round: number, code: string, doc: {tr: string, en: string}}>, result: string}>}
 */
export async function playLesson(id, deobfuscate, o = {}) {
  const lesson = LESSONS.find((x) => x.id === id);
  if (!lesson) throw new Error(`Ders bulunamadı: ${id}`);
  const steps = [];
  const res = await deobfuscate(lesson.example, {
    level: 4,
    deep: Boolean(o.sandbox),
    ...o,
    onSnapshot: (s) => steps.push({
      pass: s.id,
      round: s.round,
      code: s.code,
      doc: PASS_DOCS[s.id] ?? { tr: 'Parse edilmiş girdi.', en: 'Parsed input.' },
    }),
  });
  return { lesson, steps, result: res.code, solved: res.code.includes(lesson.expect) };
}
