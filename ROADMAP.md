# PEEL Yol Haritası / Roadmap

`[x]` yapıldı · done   `[~]` kısmen · partial   `[ ]` planlandı · planned

Katkı yapmak istersen bir maddeyi seç ve aynı numarayla issue aç. / Pick an item and open an issue with its number.

## A. Çözme motoru · Deobfuscation engine

- [x] 1. Obfuscator parmak izi: hangi araçla (obfuscator.io, js-confuser, packer…) üretildiğini tahmin etme
- [ ] 2. obfuscator.io ayarlarını (rotate, encoding, threshold) çıktıdan geri çıkarma
- [~] 3. RC4/base64 string kodlaması — sandbox ile çözülüyor, statik çözüm yok
- [x] 4. Fonksiyon içine gömülmüş string dizileri (`_0x1234()` getter biçimi)
- [ ] 5. Decoder ofsetini sembolik çıkarma
- [x] 6. Kendini değiştiren decoder'lar — ilk çağrıda yakalanan fonksiyonla çözülüyor
- [x] 7. Obje tabanlı proxy'leri satır içi yazma — sabit nesne özellikleri ve ardışık kurulum (const-objects)
- [x] 8. Operatör proxy'leri (`o.KJs(a, b)` → `a + b`) — a+b, a<b, f(x) proxy nesneleri
- [ ] 9. js-confuser dispatcher fonksiyonları
- [x] 10. js-confuser global gizleme tabloları (switch proxy + çalışma anında global nesne çözümü)
- [ ] 11. Integrity/hash kontrollerini etkisizleştirip raporlama
- [x] 12. Tekrarlanan literalleri geri birleştirme (js-confuser sabit literal dizisi)
- [x] 13. Sayısal artıkları katlama
- [~] 14. Template literal'lara gizlenmiş string'ler — ifadesiz olanlar katlanıyor
- [x] 15. toString tabanlı tamper kontrolünü kaldırma
- [x] 16. `/abc/.source` regex string'lerini katlama
- [ ] 17. Destructuring ile gizlenmiş atamalar
- [x] 18. `void 0` artıkları ve virgül zincirleri
- [x] 19. `!0` / `!1` → `true` / `false`
- [x] 20. `a && b()` → if, iç içe ternary → if/else — a && b(), a || b(), ternary deyim → if; virgül zinciri → ayrı deyimler
- [ ] 21. js-confuser `M.length = 2; M[0]` → gerçek parametreler
- [ ] 22. Generator tabanlı durum makinelerini düz fonksiyona çevirme
- [ ] 23. Sabit nesneli `with` bloklarını açık erişime çevirme
- [ ] 24. Webpack/Rollup/esbuild bundle'larını modüllere ayırma
- [ ] 25. Kısmi source map ile isim kurtarma

## B. VM / durum makinesi · VM / state machines

- [ ] 26. Geçiş tablosuna koşulları ekleme
- [ ] 27. Concolic çoklu yol keşfi
- [~] 28. Durum makinesini düz koda çevirme — if/else, while, do-while geri kuruluyor; desteklenmeyen biçimler bırakılıyor
- [~] 29. Sayaç aritmetiği — `switch (P+Q+R)` tek durum değişkenine indiriliyor
- [ ] 30. z3.wasm ile opaque koşul kanıtı
- [ ] 31. jsvmp bytecode VM'ler için disassembler
- [ ] 32. VM bytecode → JS lifter
- [ ] 33. Stack VM derinlik analizi
- [ ] 34. Opcode handler'larını davranıştan adlandırma
- [ ] 35. İnteraktif geçiş grafiği
- [ ] 36. Ulaşılmayan case'leri işaretleme
- [ ] 37. VM sürümlerini eşleştirme
- [ ] 38. Şifreli bytecode'u çalışma anında yakalama
- [ ] 39. VM'nin çağırdığı native API listesi
- [ ] 40. Durum başına yan etki özeti
- [ ] 41. Adım adım durum makinesi debugger'ı
- [ ] 42. Geçiş tablosunda arama
- [ ] 43. İç içe VM'ler
- [ ] 44. Zamanlama tabanlı anti-debug nötralizasyonu
- [ ] 45. Makineyi orijinal fonksiyon sınırlarına bölme

## C. Sandbox ve dinamik analiz · Sandbox & dynamic analysis

- [~] 46. Seçilebilir tarayıcı profilleri — dört profil (Chrome/Windows, Firefox/Linux, Safari/iPhone, headless bot) sandbox yapılandırmasında; arayüzde seçici yok
- [~] 47. Bot ve gerçek kullanıcı profili karşılaştırması — profil yapılandırmasıyla iki çalıştırma yapılabiliyor; yan yana karşılaştırma ekranı yok
- [x] 48. Ağ çağrılarını engelleyip kaydetme (fetch, XHR, WebSocket, beacon, image, script)
- [x] 49. Sahte fetch/XHR yanıtları — yapılandırmadaki URL eşleşmesine göre fetch/XHR yanıtı
- [~] 50. Zaman makinesi — sabit zaman ve tohum yapılandırılabilir; arayüzden ayar yok
- [x] 51. Eksik global detektörü — ReferenceError mesajlarından
- [x] 52. Fingerprint envanteri (navigator/screen/document/location okumaları)
- [~] 53. Canvas/WebGL/Audio fingerprint — statik API taraması + toDataURL sayımı + profil okumaları
- [ ] 54. Taint takibi
- [~] 55. eval/Function ile üretilen kod — sarmalayıcılar ve js-confuser rgf (new Function) çağrı yerinde gerçek fonksiyona çevriliyor
- [x] 56. Timer ve Promise kuyruğunu sırayla çalıştırma — Promise iş kuyruğu boşaltılıyor; setInterval geri çağrıları analizde bir kez çalıştırılıyor
- [x] 57. Sentetik olaylarla handler tetikleme — kayıtlı işleyiciler analizde sentetik olayla tetikleniyor
- [ ] 58. Sandbox anlık görüntüsü
- [ ] 59. Deterministik replay
- [x] 60. Global nesne ağacı — programın eklediği global ad ve tipleri
- [ ] 61. Çalışma anı çağrı grafiği
- [ ] 62. Coverage renklendirme
- [ ] 63. Sonsuz döngü / anti-debug tuzağını gösterme
- [ ] 64. WASM import/export
- [ ] 65. Onaylı gerçek DOM modu
- [ ] 66. Worker kodunu ayrı sandbox'ta çalıştırma
- [~] 67. Cookie ve localStorage'ı önceden doldurma — çerez ve localStorage yapılandırmadan doldurulabiliyor; arayüz yok
- [x] 68. `subtle.encrypt` girdi/çıktısını yakalama — crypto.subtle çağrıları algoritma ve veri önizlemesiyle
- [x] 69. Pass başına süre profili
- [ ] 70. Bellek/süre sınırlarını arayüzden ayarlama

## D. Anlamlandırma · Making sense of code

- [ ] 71. Yerel LLM ile adlandırma (WebGPU)
- [ ] 72. Kural tabanlı ad önerisi
- [ ] 73. Fonksiyon açıklama yorumları
- [x] 74. Bilinen kütüphaneleri tanıma (LZString, CryptoJS) — imza tablosu: jQuery, lodash, CryptoJS, LZString, pako, FingerprintJS, GA, Facebook Pixel, CoinHive, React, axios, forge, JSEncrypt
- [~] 75. Kütüphane sürümü tespiti — sürüm bilgisi yorum/sabitten okunabiliyorsa
- [ ] 76. TypeScript tip çıkarımı
- [ ] 77. Prototype → `class`
- [ ] 78. ES5 → modern sözdizimi
- [ ] 79. Babel/regenerator kalıntılarını geri çevirme
- [ ] 80. Satır satır açıklama modu
- [ ] 81. Tek paragraf özet
- [ ] 82. Sihirli sayıları adlandırma
- [x] 83. URL, anahtar ve regex listesi
- [ ] 84. Ölü kodu katlanmış gösterme
- [ ] 85. Kopya fonksiyonları birleştirme
- [ ] 86. Modüllere bölme
- [ ] 87. Kalıcı yeniden adlandırma
- [ ] 88. Paylaşılabilir ad haritaları
- [ ] 89. CFG görseli
- [ ] 90. Tanım-kullanım zinciri
- [ ] 91. Sekans diyagramı
- [~] 92. Okunabilirlik ölçümü — önce/sonra metrikleri
- [ ] 93. Karmaşıklık ısı haritası
- [~] 94. Çözülemeyenler — kalan hex argümanlı çağrı ve _0x sayısı
- [ ] 95. Açıklamalı diff

## E. Güvenlik ve tehdit analizi · Security & threat analysis

- [x] 96. Skimmer/miner/keylogger sınıflandırması — skimmer, madenci, tuş kaydedici, kimlik toplama, yönlendirme, parmak izi, dinamik kod
- [x] 97. Magecart tespiti — ödeme alanları + dışarı gönderim
- [~] 98. Exfiltration haritası — çalışma anı ağ çağrıları tablosu
- [x] 99. IOC çıkarma (domain, URL, IP, e-posta, cüzdan, JWT, gömülü anahtar) + JSON dışa aktarma
- [ ] 100. Onaylı VirusTotal/URLhaus sorgusu
- [x] 101. YARA kuralı üretme — çözülmüş string ve IOC'lerden
- [x] 102. IDS imzası — Suricata DNS/TLS SNI/HTTP URI kuralları
- [~] 103. Anti-bot sinyal raporu — fingerprint okumaları + bot tespiti API'leri
- [x] 104. Gizlilik (GDPR) raporu — üçüncü taraflar, çerez, depolama, parmak izi
- [ ] 105. npm supply-chain karşılaştırması
- [ ] 106. Tarayıcı eklentisi (.crx/.xpi) analizi
- [~] 107. Phishing kit endpoint'leri — kimlik alanları + gönderim sınıflandırması; uç nokta listesi ağ tablosunda
- [x] 108. Redirect zinciri — location.href/assign/replace ve window.open kaydı
- [x] 109. Risk skoru kartı — 0–100 skor, sınıf ağırlıkları
- [x] 110. Şüpheli API kullanımı
- [x] 111. Dışarıdan yüklenen ikinci aşama script'ler (script src / image / fetch yakalama)
- [ ] 112. Polimorfik varyant aileleri
- [ ] 113. Script değişim takibi
- [ ] 114. Olay müdahale raporu
- [x] 115. Paylaşmadan önce anahtar maskeleme — JWT, Stripe/AWS/Google/GitHub/Slack anahtarları, e-posta, uzun gizli string

## F. Arayüz ve editör · UI & editor

- [ ] 116. Monaco/CodeMirror editör
- [ ] 117. Senkron kaydırma
- [ ] 118. Çıktıdan girdiye kaynak eşleme
- [x] 119. Pass zaman çizelgesi
- [ ] 120. Pass hariç tutup yeniden çözme
- [ ] 121. Komut paleti
- [ ] 122. F2 yeniden adlandırma
- [ ] 123. Go to definition / references
- [ ] 124. String/çağrı içinde regex arama
- [ ] 125. Çok sekme
- [ ] 126. Proje modu (klasör/zip)
- [ ] 127. 10 MB+ için sanal kaydırma
- [ ] 128. Kalan süre tahmini
- [ ] 129. Aydınlık tema / yüksek kontrast
- [ ] 130. Mobil okuma modu
- [ ] 131. IndexedDB oturum kaydı
- [ ] 132. Satır notları ve yer imleri
- [x] 133. Sonuç kartı (rapor + durum çubuğu özeti)
- [ ] 134. Onaylı URL'den indirme
- [ ] 135. Zip/crx/har sürükle-bırak
- [ ] 136. HAR toplu çözme
- [ ] 137. Kısayol rehberi
- [ ] 138. Biçimlendirme tercihleri
- [x] 139. Girdi/çıktı fark görünümü
- [~] 140. Erişilebilirlik — klavye ile sekmeler, ARIA rolleri, odak halkaları

## G. Karşılaştırma ve sürüm takibi · Comparison & versioning

- [ ] 141. Semantik diff
- [ ] 142. Sürümler arası fonksiyon raporu
- [ ] 143. Script izleme
- [ ] 144. "Bunu daha önce gördün" uyarısı
- [ ] 145. BinDiff tarzı eşleştirme
- [ ] 146. Çözüm geçmişi
- [ ] 147. Adları yeni sürüme taşıma
- [ ] 148. Yeni teknik uyarısı
- [x] 149. Regresyon kontrolü (`npm test`, davranış karşılaştırmalı fixture'lar)
- [x] 150. Çıktı özeti (FNV-1a)
- [ ] 151. Git commit dizisi olarak dışa aktarma
- [ ] 152. Paylaşılabilir önce/sonra raporu
- [ ] 153. Çoklu dosya sembol eşleme
- [ ] 154. Electron asar açma
- [ ] 155. Sürüm etiketi ve not

## H. Entegrasyon · Integrations

- [x] 156. CLI (`peel input.js -o out.js --report report.json`)
- [ ] 157. npm kütüphane API'si
- [ ] 158. VS Code eklentisi
- [ ] 159. Tarayıcı eklentisi
- [ ] 160. DevTools paneli
- [ ] 161. Burp Suite / mitmproxy eklentisi
- [ ] 162. GitHub Action
- [ ] 163. Self-host REST API
- [ ] 164. `.peel` proje formatı
- [ ] 165. Pass eklenti sistemi
- [ ] 166. İmzalı eklenti paylaşımı
- [ ] 167. Dönüşüm kuralı dili
- [ ] 168. Jupyter/Observable
- [ ] 169. Slack/Discord botu
- [x] 170. CI'da fixture regresyonu (`npm test`)
- [ ] 171. ESLint/Prettier yapılandırmasına uyma
- [ ] 172. Semgrep
- [ ] 173. SARIF dışa aktarma
- [ ] 174. PWA / çevrimdışı
- [ ] 175. Tauri masaüstü sürümü

## I. Doğrulama ve güven · Verification & trust

- [~] 176. Güven skoru — gözlemle yapılan değişiklikler log'da ayrı belirtiliyor
- [ ] 177. Gözlemle yapılan değişiklikleri ayrı renkle gösterme
- [ ] 178. Diferansiyel fuzz
- [ ] 179. Fonksiyon bazında eşdeğerlik testi
- [x] 180. Geri alınan pass'lerin nedeni
- [ ] 181. Pass başına risk rozeti
- [ ] 182. Sandbox kaçış testi paketi
- [x] 183. Gerçek obfuscator benchmark'ı (`npm run bench`: 12 obfuscator.io + 10 js-confuser ayarı)
- [~] 184. Başarı metriği — kalan decoder çağrısı / _0x sayısı
- [ ] 185. Yanlış sonuç bildirme şablonu
- [ ] 186. Determinizm kontrolü
- [x] 187. Pass süre bütçesi
- [ ] 188. Bellek göstergesi
- [ ] 189. İmzalı sürümler ve SBOM
- [x] 190. "Dış ağ isteği yok" göstergesi

## J. Öğrenme ve paylaşım · Learning & sharing

- [ ] 191. Eğitim modu
- [ ] 192. CTF modu
- [ ] 193. Obfuscation teknikleri ansiklopedisi
- [ ] 194. Kendi kodunu obfuscate edip test etme
- [ ] 195. Dayanıklılık skoru
- [ ] 196. Uçtan uca şifreli paylaşım
- [ ] 197. Anonimleştirilmiş fixture katkısı
- [x] 198. Türkçe / İngilizce arayüz
- [ ] 199. "Neden gizlenmiş olabilir" açıklaması
- [ ] 200. Yeni kalıplar changelog'u

---

# Genişletilmiş yol haritası / Extended roadmap (E26–E750)

Önerilen numaralar korunmuştur; yukarıdaki 1–200 ile çakışanlar burada da yer alır.
Henüz tanımlanmamış aralıklar: E241–E250 (I) ve E331–E500 (M–T).
Numbering follows the proposal; overlaps with items 1–200 are kept. Ranges E241–E250 and E331–E500 are not defined yet.

## E-A. Motor, dedeksiyon, yapılandırma (E26–E60)

- [~] E26. Obfuscator imza veritabanı (40+ araç, skor eşiğiyle otomatik profil) — 9 aile tanınıyor
- [ ] E27. Pass başına 0–100 güven skoru
- [ ] E28. Yapılandırma geri çıkarma (rotate, threshold, splitStrings)
- [~] E29. Araç parmak izi raporu — raporda tespit ve gerekçeler
- [ ] E30. Aynı aracın sürümlerini ayırt etme
- [x] E31. Bilinmeyen araç modu — her çalıştırma tüm pass'leri en yüksek seviyede koşar
- [ ] E32. Pass sırası arama
- [ ] E33. Kademeli saldırı
- [ ] E34. Bağımlı pass'leri de kapsayan geri alma zinciri
- [x] E35. Deterministik mod
- [ ] E36. Seçili bölgede artımlı çözme
- [x] E37. Fonksiyon içi string dizi getter'ı
- [~] E38. Decoder ofset çözümü — sandbox ile, sembolik değil
- [x] E39. Kendini değiştiren decoder
- [~] E40. Çok katmanlı decoder zinciri — turlar arasında çözülüyor
- [ ] E41. Obje proxy satır içi yazma
- [ ] E42. Operatör proxy
- [ ] E43. js-confuser dispatcher
- [x] E44. Global gizleme tablosu — çağrılar global adlara çözülüyor
- [x] E45. Bölünmüş string birleştirme
- [x] E46. Tekrarlanan literal toplama (sabit indeksli okumalar yerine yazılıyor)
- [x] E47. Sayısal artefakt katlama
- [x] E48. `toString` tamper tespiti ve silme (obfuscator.io selfDefending dahil)
- [ ] E49. Regex `.source/.flags/.length` katlama
- [ ] E50. Destructuring gizleme açma
- [~] E51. `void 0` ve virgül zinciri — virgül zinciri deyimlere bölünüyor
- [x] E52. `!0` / `!1` → boolean
- [ ] E53. `a && b()` → if
- [ ] E54. İç içe ternary → if/else
- [ ] E55. `M.length=2; M[0]` → gerçek parametreler
- [ ] E56. Generator tabanlı durum makinesi
- [ ] E57. Sabit `with` bloğu açma
- [ ] E58. Bundle ayırma
- [ ] E59. Source map ile isim kurtarma
- [ ] E60. Çıktı için source map üretme

## E-B. String kodlama ve çözme (E61–E95)

- [~] E61. Base64 varyantları — koddaki decoder sandbox'ta çalışınca; js-confuser base91 dahil
- [x] E62. Base32/Base58/Base85 — Base32, Base58, Ascii85 (rapor)
- [x] E63. Hex string
- [x] E64. Unicode kaçışları
- [x] E65. Octal kaçışları
- [x] E66. HTML entity — HTML entity (rapor)
- [~] E67. Percent encoding — `eval(decodeURIComponent(…))`
- [~] E68. UTF-16 / UTF-7 / CESU-8 — UTF-16 LE/BE bayt dizileri; UTF-7/CESU-8 yok
- [x] E69. ROT-n — ROT-n, İngilizce harf sıklığı (ki-kare)
- [x] E70. Atbash
- [x] E71. Vigenère / Sezar — Vigenère anahtarı sütun sütun ki-kare ile; Sezar = ROT-n
- [x] E72. Tek bayt XOR — 255 anahtar, okunabilirlik puanı
- [x] E73. Çok bayt XOR (Kasiski) — anahtar uzunluğu 2–8, sütun başına tek bayt XOR
- [x] E74. RC4 (obfuscator.io rc4 benchmark'ta tam)
- [ ] E75. AES-CBC/CTR
- [ ] E76. DES/3DES
- [ ] E77. RSA parça çözümü
- [ ] E78. TEA/XTEA/XXTEA
- [ ] E79. Blowfish
- [x] E80. Özel alfabeli base64
- [x] E81. `String.fromCharCode(...)`
- [x] E82. `fromCharCode.apply(null, arr)`
- [~] E83. `join` tabanlı sayı çözümü — saf ifadeyse
- [~] E84. `parseInt(x, 16)` zinciri — saf ifadeyse
- [~] E85. `unescape`/`escape`
- [~] E86. `encodeURI` ailesi
- [x] E87. BigInt ile paketlenmiş string — büyük tamsayıdan bayt açma
- [~] E88. Bitsel paketleme — 8 bit paketleme; 7 bit ve özel genişlikler yok
- [~] E89. Uint8Array + TextDecoder — çalışma anında TextDecoder stub'ı üzerinden
- [~] E90. Sıkıştırılmış blob — LZString programın kendi koduyla; pako/gzip/brotli yok
- [x] E91. `atob(x).split("").reverse().join("")`
- [~] E92. Çok katmanlı zincir — katman sayısı raporlanmıyor
- [~] E93. Ayrı fonksiyondan anahtar toplayan şifreli tablo
- [x] E94. Çalışma anında üretilen alfabe
- [x] E95. Kodlama raporu — rapor: çıktıdaki string'lerin kodlama adayları ve çözümleri

## E-C. Proxy ve dolaylılık (E96–E120)

- [x] E96. Switch proxy
- [ ] E97. Fonksiyon proxy (`W("k")(...)`)
- [x] E98. İki argümanlı proxy — const-objects
- [~] E99. Proxy zinciri — turlar arasında
- [ ] E100. Getter proxy
- [ ] E101. Sınıf üye proxy
- [x] E102. `window["x"]` → nokta notasyonu
- [x] E103. Global alias sadeleştirme
- [~] E104. `self`/`globalThis` birleştirme
- [~] E105. `this` proxy — yalnızca `Function("return this")()`
- [x] E106. `arguments[0]` → parametre adı
- [ ] E107. `bind` düzleştirme
- [x] E108. `.call/.apply` düzleştirme — yalnızca this undefined iken
- [ ] E109. Kısmi uygulama açma
- [x] E110. Sarmalayıcı fonksiyon sökme — literal argümanlı sarmalayıcılar çağrı yerinde açılıyor (wrappers)
- [x] E111. Kimlik fonksiyonu
- [~] E112. Operatör fonksiyonu — nesne içindeki operatör fonksiyonları; bağımsız fonksiyonlar kullanıcı kodu olabileceği için açılmıyor
- [x] E113. Sabit döndüren fonksiyon
- [x] E114. `o["m"].call(o, …)` → `o.m(…)`
- [ ] E115. `Object.create` sarmalını açma
- [ ] E116. `Reflect.get/set`
- [ ] E117. `Object.defineProperty` sabit değer
- [ ] E118. Symbol anahtarlarını isimlendirme
- [x] E119. `eval` sarmalayıcı
- [x] E120. `Function` sarmalayıcı

## E-D. Sabit katlama ve sadeleştirme (E121–E150)

- [x] E121. Aritmetik
- [x] E122. Bitsel
- [x] E123. Karşılaştırma
- [x] E124. Mantıksal
- [x] E125. `typeof`
- [~] E126. `instanceof` / `in` — `in` boş fonksiyon/obje tuzaklarında
- [x] E127. Dizi metotları
- [x] E128. String metotları
- [x] E129. `Math.*` (random hariç)
- [x] E130. `JSON.parse/stringify`
- [x] E131. `Number/String/Boolean`
- [x] E132. `parseInt/parseFloat`
- [x] E133. İfadesiz şablon literal
- [x] E134. Parçaları sabit şablon literal
- [x] E135. RegExp `.source/.test`
- [~] E136. `!!x` → `Boolean(x)` — boolean bağlamda !!x → x
- [x] E137. `~~x` — x int32 iken
- [ ] E138. `+""`
- [x] E139. `x|0` — x int32 iken
- [ ] E140. `0+x`
- [x] E141. `x*1`, `x+0`, `x**1` — x number iken
- [~] E142. `x*0` — uygulanmadı: x negatifse x*0 = -0, katlama anlamı değiştirir
- [x] E143. De Morgan
- [x] E144. Çift olumsuzlama kaldırma
- [x] E145. `true?x:y` / `false?x:y`
- [x] E146. `x?x:y` → `x||y`
- [x] E147. `x?y:y` → `y`
- [x] E148. Boş blok temizliği
- [x] E149. Özdeş atama
- [x] E150. `delete` katlama

## E-E. Kontrol akışı (E151–E175)

- [x] E151. String-order dispatcher
- [ ] E152. Sayı-order dispatcher
- [x] E153. İç içe dispatcher — dış makine açılınca iç makineler sonraki turda açılıyor
- [~] E154. Trace ile sıra kurtarma — gözleniyor, kod değiştirilmiyor
- [x] E155. Dallanan dispatcher → if/else (somut durum yürütme, iki yol ayrı ayrı)
- [ ] E156. Çoklu yol keşfi
- [ ] E157. Koşul fonksiyonu kurtarma
- [ ] E158. `do/while` dispatcher
- [ ] E159. `for(;;)` dispatcher
- [ ] E160. Etiketli blok dispatcher
- [ ] E161. `try/catch` akış gizleme
- [ ] E162. Koşullu `return` düzleştirme
- [ ] E163. `switch` → if zinciri
- [ ] E164. `switch` → tablo
- [x] E165. Dispatcher döngüsünü while/do-while.a çevirme
- [ ] E166. `break/continue` normalizasyonu
- [x] E167. Sabit koşulda ölü dal budama
- [x] E168. İç içe aynı koşullu if birleştirme
- [x] E169. `else` sonrası erken çıkış
- [ ] E170. Guard cümlesi üretimi
- [x] E171. Tek iterasyonlu döngüyü açma
- [x] E172. `while(true){…break}` → blok
- [ ] E173. Yineleme tanıma
- [ ] E174. Çözülemeyen bölge için DOT/Mermaid
- [ ] E175. Akış raporu

## E-F. VM ve durum makineleri (E176–E200)

- [x] E176. Register VM tespiti
- [~] E177. Stack VM tespiti — genel tespit
- [~] E178. String opcode VM — tespit
- [x] E179. Sayaç toplamı discriminant → `__peelS`
- [ ] E180. XOR/çarpım discriminant
- [ ] E181. Opcode şablon kütüphanesi
- [ ] E182. Ham gövde koruması
- [x] E183. İşaretleyici ile trace
- [ ] E184. Proxy ile state gözleme
- [x] E185. `with` içindeki switch'e ulaşma
- [ ] E186. Terminatör modelleme
- [ ] E187. `default` dalı
- [x] E188. Geçiş tablosu
- [ ] E189. Opcode isimlendirme
- [~] E190. Opcode kaldırma — döngüsüz durum makineleri tamamen kaldırılıyor
- [ ] E191. Dallanma şablonları
- [ ] E192. Sembolik yorumlayıcı
- [ ] E193. Bytecode'u ayrı dosyaya çıkarma
- [ ] E194. Assembler/disassembler
- [ ] E195. Çoklu çalıştırma sentezi
- [x] E196. Tekrar eden durumları döngüye çevirme
- [ ] E197. `__peelS` sonrası ölü aritmetik temizliği
- [ ] E198. jsvmp özel modu
- [ ] E199. VM raporu
- [~] E200. VM çıktısı doğrulama — genel davranış karşılaştırması

## E-G. Ölü kod ve bütünlük (E201–E220)

- [x] E201. Self-defending IIFE ve callController geri çağrıları
- [x] E202. Debug protection
- [ ] E203. Zamanlama tabanlı anti-debug
- [ ] E204. `console` tespiti
- [ ] E205. Bütünlük hash kontrolü tespiti
- [ ] E206. Bütünlük bloğunu silme
- [ ] E207. Bütünlük raporu
- [x] E208. Kullanılmayan fonksiyon
- [x] E209. Kullanılmayan değişken
- [ ] E210. Kullanılmayan parametre
- [~] E211. Kullanılmayan import
- [ ] E212. Kullanılmayan sınıf üyesi
- [x] E213. Boş fonksiyon
- [ ] E214. `return/throw` sonrası erişilemeyen kod
- [ ] E215. Yinelenen tanım
- [x] E216. Sabit `if` budama
- [ ] E217. Boş `catch`
- [x] E218. No-op ifade
- [ ] E219. Fazla argüman
- [~] E220. Ölü kod raporu — sayı var, tür yok

## E-H. Kapsam, isimlendirme, okunabilirlik (E221–E240)

- [x] E221. Scope-güvenli rename
- [ ] E222. Callback parametresinden anlam çıkarımı
- [ ] E223. Tip tabanlı isim
- [ ] E224. Fiil isimleri
- [ ] E225. DOM elemanı ismi
- [ ] E226. Olay ismi
- [ ] E227. `with` varken güvenli rename alt kümesi
- [ ] E228. `window.x` erişimi olan global'leri koruma
- [x] E229. Export koruması
- [~] E230. `eval` varken güvenli mod — rename tamamen atlanıyor
- [ ] E231. Kullanıcı isim sözlüğü
- [ ] E232. Orijinal adı yorumda saklama
- [ ] E233. `let/const`'a çevirme
- [ ] E234. Fonksiyon çıkarma
- [ ] E235. Değişken birleştirme
- [ ] E236. Tanımı kullanıma yaklaştırma
- [ ] E237. Yorum geri yükleme
- [ ] E238. Bölüm başlıkları
- [ ] E239. Biçim profilleri
- [~] E240. Okunabilirlik skoru — önce/sonra metrikleri

## E-J. Arayüz ve etkileşim (E251–E285)

- [ ] E251. AST düğüm seçimi ve çift yönlü vurgu
- [ ] E252. Katlanabilir bloklar
- [ ] E253. Seçili bölgede pass çalıştırma
- [ ] E254. Düğüm bağlam menüsü
- [ ] E255. Pass önizlemesi
- [ ] E256. Kuru çalıştırma
- [ ] E257. Adım adım onaylı ilerleme
- [x] E258. Zaman çizelgesi kaydırıcısı
- [ ] E259. Sınırsız geri al / yinele
- [ ] E260. Oturum kaydı (JSON)
- [ ] E261. Komut paleti
- [ ] E262. Atanabilir kısayollar
- [ ] E263. Çoklu sekme
- [ ] E264. Sekme grupları
- [ ] E265. 3–4 panelli görünüm
- [ ] E266. Mini harita
- [ ] E267. Yakınlaştırma
- [ ] E268. Kelime kaydırma
- [ ] E269. Görünmez karakter gösterimi
- [ ] E270. Kontrol karakteri vurgusu
- [ ] E271. Eşleşen parantez
- [ ] E272. Girinti rehberleri
- [ ] E273. Aktif satır vurgusu
- [ ] E274. Odak modu
- [ ] E275. Tam ekran
- [ ] E276. Okuma modu
- [ ] E277. Tema seçimi
- [ ] E278. Renk körlüğü paletleri
- [~] E279. Ligatür seçimi — kodda ligatür kapalı
- [ ] E280. Onaltılık satır numarası
- [~] E281. Durum çubuğu — sonuç özeti var, imleç konumu yok
- [ ] E282. Pass listesini sürükle-bırak sıralama
- [~] E283. Arayüz dili — TR/EN; DE/ES ve RTL yok
- [~] E284. Ekran okuyucu — ARIA rolleri, canlı bölgeler
- [ ] E285. Dokunmatik jestler

## E-K. Görselleştirme (E286–E310)

- [ ] E286. AST ağacı
- [ ] E287. Kontrol akış grafiği
- [ ] E288. Veri akış grafiği
- [ ] E289. Çağrı grafiği
- [ ] E290. Bağımlılık grafiği
- [ ] E291. String tablosu görünümü
- [ ] E292. Proxy eşleme tablosu
- [~] E293. VM geçiş grafiği — metin tablosu olarak
- [ ] E294. Opcode frekans grafiği
- [ ] E295. Dönüşüm ısı haritası
- [ ] E296. Karmaşıklık haritası
- [ ] E297. Renk kodlu kapsam
- [ ] E298. Gölge ilişkisi görünümü
- [ ] E299. Ölü kod katmanı
- [ ] E300. Güven ısı haritası
- [ ] E301. Katman görünümü
- [x] E302. Pass süreleri çubuk grafiği
- [ ] E303. Bellek grafiği
- [ ] E304. Düğüm sayısı grafiği
- [ ] E305. Karşılaştırmalı grafik
- [ ] E306. Grafik dışa aktarma
- [ ] E307. Grafik filtreleme
- [ ] E308. Grafik düzeni seçimi
- [ ] E309. Büyük grafik sanallaştırma
- [ ] E310. Grafikte arama

## E-L. Arama ve gezinme (E311–E330)

- [ ] E311. Regex metin arama
- [ ] E312. Yapısal AST sorgusu
- [ ] E313. Düğüm yolu seçici
- [ ] E314. String tablosunda arama
- [~] E315. Çözülmemiş kalıntılar — raporda kalan decoder çağrısı / `_0x` sayısı
- [ ] E316. Yüksek entropi arama
- [ ] E317. Tekrar eden kod
- [ ] E318. Benzer fonksiyon
- [ ] E319. Tanımsız referanslar
- [ ] E320. Kullanılmayan tanımlar
- [ ] E321. Uzun satırlar
- [ ] E322. Derin iç içelik
- [ ] E323. Sihirli sayılar
- [ ] E324. Sonraki/önceki eşleşme
- [ ] E325. Sonuç listesi paneli
- [ ] E326. Arama geçmişi
- [ ] E327. Kayıtlı aramalar
- [ ] E328. Arama sonucu dışa aktarma
- [ ] E329. Sembol listesi
- [ ] E330. Tanıma git / referansları bul

## E-U. Semantik modelleme (E501–E540)

- [ ] E501. ToPrimitive/ToNumber/ToString modeli
- [ ] E502. Sıkı/gevşek mod ayrımı
- [ ] E503. TDZ modelleme
- [ ] E504. Getter/setter yan etkisi
- [ ] E505. Proxy tuzağı semantiği
- [ ] E506. Symbol anahtarlı özellikler
- [ ] E507. Özel alanlar
- [ ] E508. `with` kapsam modeli
- [ ] E509. `eval` kapsam modeli
- [ ] E510. Realm ayrımı
- [ ] E511. Modül ad alanı nesnesi
- [ ] E512. Top-level await
- [ ] E513. Iterator protokolü
- [ ] E514. Async iterator
- [ ] E515. Thenable çözümü
- [ ] E516. Mikrogörev sırası
- [ ] E517. Yakalanmamış ret
- [ ] E518. Yığın izi yakalama
- [ ] E519. `Error.captureStackTrace`
- [ ] E520. `arguments.callee`
- [ ] E521. `function.length/caller`
- [ ] E522. `new.target`
- [ ] E523. Sınıf alan başlatma sırası
- [ ] E524. Statik bloklar
- [ ] E525. Dekoratörler
- [ ] E526. RegExp motoru farkları
- [ ] E527. Unicode özellik kaçışları
- [ ] E528. `lastIndex` durumu
- [~] E529. Saat dilimi — sandbox'ta saat sabit, dilim değil
- [ ] E530. `toLocaleString`
- [ ] E531. `Intl.NumberFormat`
- [x] E532. Tohumlu `crypto.getRandomValues`
- [x] E533. Tohumlu `Math.random`
- [~] E534. `performance.now` — sandbox'ta sabit
- [x] E535. `-0` ve `NaN` ayrımı
- [ ] E536. BigInt semantiği
- [ ] E537. TypedArray takma adı
- [ ] E538. Ayrılmış ArrayBuffer
- [ ] E539. SharedArrayBuffer / Atomics
- [ ] E540. WeakRef / FinalizationRegistry

## E-V. Analiz altyapısı (E541–E580)

- [ ] E541. Pass bağımlılık DAG'ı
- [ ] E542. Pass çakışma tespiti
- [ ] E543. Pass etkileşim matrisi
- [ ] E544. Maliyet modeliyle sıralama
- [x] E545. Hash ile fixpoint/döngü kırıcı
- [~] E546. İşlem geri alma — pass başına
- [ ] E547. Kontrol noktası
- [ ] E548. Yapısal paylaşım
- [ ] E549. Artımlı yeniden analiz
- [ ] E550. Kirli küme takibi
- [ ] E551. Alt ağaç hash önbelleği
- [ ] E552. Talep odaklı analiz
- [ ] E553. Analiz geçersizleştirme
- [ ] E554. Worklist algoritmaları
- [~] E555. Deterministik sıra
- [ ] E556. Kararlı düğüm kimlikleri
- [ ] E557. Düğüm kökeni meta verisi
- [~] E558. Dönüşüm gerekçesi — log satırları
- [ ] E559. Geri alınabilir dönüşüm günlüğü
- [x] E560. Diff'lenebilir anlık görüntüler (zaman çizelgesi)
- [ ] E561. Sürümlü AST serileştirme
- [ ] E562. AST diff/patch biçimi
- [ ] E563. Çalıştırmalar arası düğüm eşleme
- [ ] E564. Yorumdan ayrı not kanalı
- [ ] E565. Yorum koruma stratejisi
- [x] E566. Direktif koruma
- [x] E567. ASI'ye duyarlı üretim
- [x] E568. Parantez minimizasyonu
- [x] E569. Öncelik farkındalıklı yazdırma
- [ ] E570. Minifier güvenli çıktı
- [~] E571. Gölgeleme analizi — katlama ve proxy'de
- [x] E572. Kapsam sınırı haritası
- [x] E573. Binding grafiği
- [x] E574. Referans sayımı
- [ ] E575. Def-use zincirleri
- [ ] E576. Ulaşan tanımlar
- [ ] E577. Canlılık analizi
- [ ] E578. Ölü atama tespiti
- [ ] E579. Kopya yayılımı
- [~] E580. Sabit yayılımı — test pozisyonlarıyla sınırlı

## E-W. Sembolik ve concolic yürütme (E581–E610)

- [ ] E581. Sembolik değerler
- [ ] E582. Kısıt deposu
- [ ] E583. Yol çatallama
- [ ] E584. Yol birleştirme
- [ ] E585. Durum patlaması kontrolü
- [ ] E586. Concolic mod
- [ ] E587. Kapsam geri beslemesi
- [ ] E588. Girdi sentezi
- [ ] E589. Bit-vektör/dizi/string yol koşulu çözücüsü
- [ ] E590. String kısıt çözücü
- [ ] E591. Regex sentezi
- [ ] E592. Opaque predicate SMT çözümü
- [ ] E593. Dallanma korelasyonu
- [ ] E594. Kanıt üretimi
- [ ] E595. Tanık küçültme
- [ ] E596. Sembolik dizi modeli
- [ ] E597. Sembolik nesne modeli
- [ ] E598. Sembolik string modeli
- [ ] E599. Sembolik tip modeli
- [ ] E600. Yol budama
- [ ] E601. Sabit yayılımıyla budama
- [~] E602. Kısmi değerlendirme — durum makinesi somut başlangıç durumuyla özelleştiriliyor
- [~] E603. Fonksiyon özelleştirme — js-confuser main fonksiyonu başlangıç durumu başına kopyalanıyor
- [ ] E604. Döngü kısmi açma
- [ ] E605. Durum birleştirme
- [ ] E606. Özet yorumlama
- [ ] E607. Özet tablosu
- [ ] E608. Özet yeniden kullanımı
- [ ] E609. Sembolik yürütme bütçesi
- [ ] E610. Sembolik iz

## E-Kripto. Kripto ve istatistik (E611–E630)

- [ ] E611. Şifre tanıma (S-box, round sabiti)
- [ ] E612. Hash tanıma (MD5/SHA sabitleri)
- [ ] E613. Anahtar çıkarma
- [ ] E614. IV/salt tespiti
- [ ] E615. Mod tespiti
- [ ] E616. Dolgu tespiti
- [ ] E617. Entropi analizi
- [ ] E618. Shannon entropisi eşiği
- [ ] E619. Sıkıştırma oranı analizi
- [~] E620. Base64 tespiti — raporda gömülü anahtar adayları
- [ ] E621. Çoklu kodlama katmanı tespiti
- [ ] E622. Doğal dil tespiti
- [ ] E623. Karakter dağılımı
- [ ] E624. Tekrar eden blok (ECB)
- [ ] E625. Rastgelelik testleri
- [ ] E626. Korelasyonla XOR anahtarı
- [ ] E627. Kasiski
- [ ] E628. Index of coincidence
- [ ] E629. Bilinen düz metin saldırısı
- [ ] E630. Küçük anahtar uzayında kaba kuvvet

## E-VM. VM ve decompilation (E631–E660)

- [x] E631. Decoder şekli tanıma
- [~] E632. Rotasyon cebiri — sandbox ile, statik değil
- [ ] E633. Decoder tersini sentezleme
- [ ] E634. String tablosu tekilleştirme
- [ ] E635. Kullanımlardan tablo yeniden kurma
- [ ] E636. Kısmi tablo kurtarma
- [ ] E637. Proxy tablosunu deneyerek tamamlama
- [ ] E638. Opcode alfabesi çıkarımı
- [ ] E639. Komut kümesi çıkarımı
- [ ] E640. Handler kümeleme
- [ ] E641. VM bellek düzeni
- [ ] E642. Register sayısı
- [ ] E643. Yığın derinliği
- [ ] E644. Dispatch stili sınıflandırma
- [ ] E645. Döngü yapısı kurtarma
- [ ] E646. Çıkış koşulu
- [ ] E647. Bytecode bölütleme
- [ ] E648. Sabit havuzu
- [ ] E649. Bytecode → IR
- [ ] E650. IR → yapısal kod
- [ ] E651. Handler semantiği sentezi
- [ ] E652. Okunur yorumlayıcı üretimi
- [ ] E653. Hibrit VM + host kod
- [ ] E654. İç içe VM tespiti
- [ ] E655. VM içinde VM açma
- [ ] E656. VM sürüm ayrımı
- [ ] E657. jsvmp şablon seti
- [ ] E658. Bytecode assembler
- [~] E659. Decompiler çıktı doğrulama — genel davranış karşılaştırması
- [ ] E660. Decompilation raporu

## E-X. Derleyici optimizasyonları (E661–E700)

- [ ] E661. Koşula sabit yayılımı
- [ ] E662. Kopya yayılımı
- [ ] E663. Ölü atama eleme
- [ ] E664. Fazla yükleme eleme
- [ ] E665. Global değer numaralandırma
- [ ] E666. Ortak alt ifade eleme
- [ ] E667. Kısmi fazlalık eleme
- [ ] E668. Döngü değişmezi taşıma
- [ ] E669. Güç indirgeme
- [ ] E670. İndüksiyon değişkeni sadeleştirme
- [ ] E671. Döngü açma
- [ ] E672. Döngü soyma
- [ ] E673. Döngü bölme/birleştirme
- [x] E674. Dal katlama (sabit koşul)
- [ ] E675. Switch normalizasyonu
- [ ] E676. Kuyruk çoğaltma
- [ ] E677. Atlama ipekleme
- [ ] E678. If-dönüşümü
- [ ] E679. Yüklemleme
- [ ] E680. Seyrek koşullu sabit yayılımı
- [ ] E681. SSA kurulumu
- [ ] E682. Phi yerleştirme
- [ ] E683. SSA bozma
- [ ] E684. Fazla phi eleme
- [ ] E685. Andersen alias analizi
- [ ] E686. Nokta-analizi
- [ ] E687. Kaçış analizi
- [~] E688. Saflık/etki çıkarımı — deterministik fonksiyon analizi
- [ ] E689. Taint takibi
- [ ] E690. Aralık analizi
- [ ] E691. Yapısal tip çıkarımı
- [ ] E692. Nesne şekli çıkarımı
- [ ] E693. String uzunluk analizi
- [ ] E694. Nullability analizi
- [ ] E695. Erişilemezlik kanıtı
- [ ] E696. İddia sentezi
- [ ] E697. Ön koşul çıkarımı
- [ ] E698. Son koşul çıkarımı
- [ ] E699. Spesifikasyon madenciliği
- [ ] E700. Değişmez tespiti

## E-Y. Doğrulama (E701–E725)

- [ ] E701. SMT ile semantik denklik kanıtı
- [ ] E702. Sınırlı model kontrolü
- [ ] E703. Ayrışan girdi için yol koşulu çözümü
- [ ] E704. Tanık üretimi
- [ ] E705. Karşı örnek küçültme
- [~] E706. Her dönüşüm sonrası çeviri doğrulaması — parse + davranış
- [~] E707. Bisimülasyon — console çıktısı karşılaştırması
- [ ] E708. İz denkliği
- [~] E709. Determinizm kontrolü — sabit tohumlu sandbox
- [ ] E710. Idempotans kanıtı
- [ ] E711. Davranış parmak izi (etki vektörü)
- [ ] E712. Semantik hash
- [ ] E713. Denklik sınıfı kümeleme
- [ ] E714. Hash tabanlı regresyon seçimi
- [ ] E715. Etki farkı
- [ ] E716. Semantik yama sentezi
- [ ] E717. Kanıt taşıyan çıktı
- [~] E718. Dönüşüm gerekçesi kaydı — log
- [ ] E719. Doğrulama bütçesi
- [~] E720. Doğrulama seviyeleri — parse ve davranış; doğrulanamayan çalıştırmalar uyarıyla işaretleniyor
- [ ] E721. Başarısız kanıt raporu
- [x] E722. Geri alma politikası — doğrulanamayan değişiklik kabul edilmez
- [ ] E723. Kademeli sıkılaştırma
- [ ] E724. Z3 wasm entegrasyonu
- [ ] E725. Çözücü zaman aşımı yönetimi

## E-Z. Yürütme motoru (E726–E750)

- [ ] E726. Heap anlık görüntüsü / geri yükleme
- [ ] E727. Deterministik yeniden oynatma
- [ ] E728. Zaman yolculuğu hata ayıklama
- [~] E729. Etki günlüğü — ağ çağrıları ve tarayıcı özelliği okumaları
- [ ] E730. `onRead/onWrite/onCall` kanca API'si
- [~] E731. Builtin'lerde proxy tuzağı — navigator/screen/document/location
- [ ] E732. Gölge bellek
- [ ] E733. Sembolik değer enjeksiyonu
- [ ] E734. Kısıt deposu entegrasyonu
- [ ] E735. Yol çatallama motoru
- [ ] E736. Yol birleştirme motoru
- [ ] E737. Durum patlaması sınırlayıcı
- [ ] E738. Kapsam geri besleme döngüsü
- [ ] E739. Girdi sentezleyici
- [ ] E740. Gramer tabanlı fuzz
- [ ] E741. AST mutasyon motoru
- [ ] E742. Çökme triyajı
- [ ] E743. Etki farkı motoru
- [ ] E744. Yeniden oynatma kayıt biçimi
- [ ] E745. Motor durumu serileştirme
- [x] E746. Çalıştırma başına izolasyon (her probe taze QuickJS runtime)
- [x] E747. Kaynak muhasebesi (bellek, süre, yığın)
- [x] E748. Kesme ve Durdur
- [ ] E749. Motor telemetrisi
- [ ] E750. Motor eklenti kancası
