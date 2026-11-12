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
  'vm-lift': {
    tr: 'Bytecode yorumlayıcılarını (jsvmp tarzı VM) bulur, bytecode dizisini yakalar, komutları adlandırır ve yorumlayıcıyı doğrulanmış düz koda çevirir.',
    en: 'Finds bytecode interpreters (jsvmp-style VMs), captures the bytecode, names the opcodes and lifts the VM to verified plain code.',
  },
  'anti-timing': {
    tr: 'Date.now / performance.now farkıyla hata ayıklayıcıyı yakalayan anti-debug kontrollerini kaldırır (normal yol korunur).',
    en: 'Removes anti-debug checks that detect a debugger via Date.now / performance.now differences (the normal path is kept).',
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
  sourcemap: {
    tr: 'Satır içi kaynak haritasında adı bulunan bağlamalara özgün adlarını geri verir.',
    en: 'Restores original names for bindings that an inline source map names.',
  },
  integrity: {
    tr: 'Kaynak metninin özetine bakan bütünlük denetimlerini özgün sonuçlarıyla değiştirir, js-confuser selfDefending denetimini kaldırır.',
    en: 'Replaces source-hash integrity checks with their original outcome and removes js-confuser selfDefending checks.',
  },
  'static-decode': {
    tr: 'decodeURIComponent, parseInt gibi saf global çağrıları sabit argümanlarla sandbox olmadan katlar.',
    en: 'Folds pure global calls such as decodeURIComponent and parseInt with constant arguments, without a sandbox.',
  },
  'iife-args': {
    tr: 'jfogs: değerleri parametreye taşıyan IIFE\'nin çözücü önsözünü çalıştırıp değerleri kullanım yerlerine yazar.',
    en: 'jfogs: runs the decoder prelude of the parameter-hoisting IIFE and writes the values back to their uses.',
  },
  'static-strings': {
    tr: 'obfuscator.io string dizisini ofset, kodlama ve rotasyonu statik çözerek sandbox olmadan açar.',
    en: 'Decodes the obfuscator.io string array without a sandbox by solving offset, encoding and rotation statically.',
  },
  'eval-inline': {
    tr: 'Fonksiyonun tek deyimi olan sabit eval("…") kodunu (webpack eval devtool) fonksiyon gövdesine yerleştirir.',
    en: 'Inlines a constant eval("…") that is a function\'s only statement (webpack eval devtool) into the body.',
  },
  rgf: {
    tr: 'js-confuser RGF: eval ile üretilen string fonksiyonları gerçek fonksiyona, kabukları özgün gövdeye çevirir.',
    en: 'js-confuser RGF: turns eval-generated string functions into real functions and shells back into their bodies.',
  },
  confuser: {
    tr: 'js-confuser dispatcher\'ını ve variableMasking rest dizisini açar, __generator durum makinesini function*\'a çevirir.',
    en: 'Unpacks the js-confuser dispatcher and variableMasking rest array, turns __generator machines into function*.',
  },
  indirection: {
    tr: 'Getter/this/bind proxy\'leri ve destructuring ile gizlenmiş atamalar gibi dolaylılıkları söker.',
    en: 'Removes indirections such as getter/this/bind proxies and destructuring-hidden assignments.',
  },
  'flat-fns': {
    tr: 'js-confuser flatten: program düzeyine taşınan gövdeyi düz nesneden arındırıp kabuğuna geri koyar.',
    en: 'js-confuser flatten: moves the hoisted body back into its shell, resolving the flat object.',
  },
  'opaque-smt': {
    tr: 'Kalan opak koşulları bit-vektör çözücüyle kanıtlayıp sabite çevirir.',
    en: 'Proves remaining opaque conditions with a bit-vector solver and replaces them with constants.',
  },
  'ssa-opt': {
    tr: 'SSA üzerinde sabit yayılımı, kopya yayılımı, ortak alt ifade ve ölü atama eleme.',
    en: 'Constant and copy propagation, common subexpression and dead store elimination on SSA.',
  },
  'loop-opt': {
    tr: 'Döngü değişmezi taşıma, indüksiyon değişkeni sadeleştirme ve sabit turlu döngüleri açma.',
    en: 'Loop-invariant motion, induction variable simplification and unrolling of constant-trip loops.',
  },
  specialize: {
    tr: 'Sabit argümanlarla çağrılan fonksiyonun o sabitlerle sadeleşmiş kopyasını üretir.',
    en: 'Creates a copy of a function specialised for the constant arguments it is called with.',
  },
  flow: {
    tr: 'try/catch ile gizlenmiş akış, küçük switch\'ler ve zamanlama tabanlı anti-debug gibi akış biçimlerini düzeltir.',
    en: 'Normalises flow such as try/catch-hidden jumps, small switches and timing-based anti-debug.',
  },
  regenerator: {
    tr: 'regenerator durum makinesini yield/await kullanan düz fonksiyona çevirir.',
    en: 'Turns a regenerator state machine back into a plain function using yield/await.',
  },
  'cfg-opt': {
    tr: 'switch normalizasyonu, atlama ipekleme ve if-dönüşümü gibi kontrol akışı sadeleştirmeleri.',
    en: 'Control-flow clean-ups such as switch normalisation, jump threading and if-conversion.',
  },
  restructure: {
    tr: 'Literal kaynaklı destructuring gibi yapısal gizlemeleri anlamı koruyarak düz biçime çevirir.',
    en: 'Rewrites structural disguises such as literal-sourced destructuring into plain form.',
  },
  'dead-extra': {
    tr: 'Kullanılmayan parametre, import, yinelenen tanım ve erişilemeyen kod gibi fazlalıkları siler.',
    en: 'Deletes leftovers such as unused parameters and imports, duplicate definitions and unreachable code.',
  },
  'cff-scope': {
    tr: 'js-confuser kontrol akışı düzleştirmesinin makine kopyalarını kabuklarına taşır, kapsam nesnesi özelliklerini yerel değişkenlere böler.',
    en: 'Moves js-confuser flattening machine copies back into their shells and splits scope-object properties into locals.',
  },
  webpack: {
    tr: 'webpack paketinde modül tablosunu ve require fonksiyonunu tanır, webpack adlarını geri verir, modülleri işaretler.',
    en: 'Recognises the webpack module table and require function, restores webpack names and marks modules.',
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
