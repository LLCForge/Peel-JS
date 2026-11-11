# PEEL Yol Haritası / Roadmap

`[x]` yapıldı · done   `[~]` kısmen · partial   `[ ]` planlandı · planned

Katkı yapmak istersen bir maddeyi seç ve aynı numarayla issue aç. / Pick an item and open an issue with its number.

## A. Çözme motoru · Deobfuscation engine

- [x] 1. Obfuscator parmak izi: hangi araçla (obfuscator.io, js-confuser, packer…) üretildiğini tahmin etme
- [ ] 2. obfuscator.io ayarlarını (rotate, encoding, threshold) çıktıdan geri çıkarma
- [~] 3. RC4/base64 string kodlaması — sandbox ile çözülüyor, statik çözüm yok
- [ ] 4. Fonksiyon içine gömülmüş string dizileri (`_0x1234()` getter biçimi)
- [ ] 5. Decoder ofsetini sembolik çıkarma
- [~] 6. Kendini değiştiren decoder'lar — ilk çağrıda yakalanan fonksiyonla çözülüyor
- [ ] 7. Obje tabanlı proxy'leri satır içi yazma
- [ ] 8. Operatör proxy'leri (`o.KJs(a, b)` → `a + b`)
- [ ] 9. js-confuser dispatcher fonksiyonları
- [~] 10. js-confuser global gizleme tabloları — `V("…")` switch proxy'leri çözülüyor
- [ ] 11. Integrity/hash kontrollerini etkisizleştirip raporlama
- [ ] 12. Tekrarlanan literalleri geri birleştirme
- [x] 13. Sayısal artıkları katlama
- [~] 14. Template literal'lara gizlenmiş string'ler — ifadesiz olanlar katlanıyor
- [x] 15. toString tabanlı tamper kontrolünü kaldırma
- [ ] 16. `/abc/.source` regex string'lerini katlama
- [ ] 17. Destructuring ile gizlenmiş atamalar
- [x] 18. `void 0` artıkları ve virgül zincirleri
- [x] 19. `!0` / `!1` → `true` / `false`
- [ ] 20. `a && b()` → if, iç içe ternary → if/else
- [ ] 21. js-confuser `M.length = 2; M[0]` → gerçek parametreler
- [ ] 22. Generator tabanlı durum makinelerini düz fonksiyona çevirme
- [ ] 23. Sabit nesneli `with` bloklarını açık erişime çevirme
- [ ] 24. Webpack/Rollup/esbuild bundle'larını modüllere ayırma
- [ ] 25. Kısmi source map ile isim kurtarma

## B. VM / durum makinesi · VM / state machines

- [ ] 26. Geçiş tablosuna koşulları ekleme
- [ ] 27. Concolic çoklu yol keşfi
- [ ] 28. Tüm yollar biliniyorsa if/while'a geri kurma
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

- [ ] 46. Seçilebilir tarayıcı profilleri
- [ ] 47. Bot ve gerçek kullanıcı profili karşılaştırması
- [x] 48. Ağ çağrılarını engelleyip kaydetme (fetch, XHR, WebSocket, beacon, image, script)
- [ ] 49. Sahte fetch/XHR yanıtları
- [ ] 50. Zaman makinesi
- [ ] 51. Eksik global detektörü
- [x] 52. Fingerprint envanteri (navigator/screen/document/location okumaları)
- [~] 53. Canvas/WebGL/Audio fingerprint — statik API taraması + toDataURL sayımı
- [ ] 54. Taint takibi
- [~] 55. eval/Function ile üretilen kod — sarmalayıcı katmanlarında yakalanıyor
- [ ] 56. Timer ve Promise kuyruğunu sırayla çalıştırma
- [ ] 57. Sentetik olaylarla handler tetikleme
- [ ] 58. Sandbox anlık görüntüsü
- [ ] 59. Deterministik replay
- [ ] 60. Global nesne ağacı
- [ ] 61. Çalışma anı çağrı grafiği
- [ ] 62. Coverage renklendirme
- [ ] 63. Sonsuz döngü / anti-debug tuzağını gösterme
- [ ] 64. WASM import/export
- [ ] 65. Onaylı gerçek DOM modu
- [ ] 66. Worker kodunu ayrı sandbox'ta çalıştırma
- [ ] 67. Cookie ve localStorage'ı önceden doldurma
- [ ] 68. `subtle.encrypt` girdi/çıktısını yakalama
- [x] 69. Pass başına süre profili
- [ ] 70. Bellek/süre sınırlarını arayüzden ayarlama

## D. Anlamlandırma · Making sense of code

- [ ] 71. Yerel LLM ile adlandırma (WebGPU)
- [ ] 72. Kural tabanlı ad önerisi
- [ ] 73. Fonksiyon açıklama yorumları
- [ ] 74. Bilinen kütüphaneleri tanıma (LZString, CryptoJS)
- [ ] 75. Kütüphane sürümü tespiti
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

- [ ] 96. Skimmer/miner/keylogger sınıflandırması
- [ ] 97. Magecart tespiti
- [~] 98. Exfiltration haritası — çalışma anı ağ çağrıları tablosu
- [x] 99. IOC çıkarma (domain, URL, IP, e-posta, cüzdan, JWT, gömülü anahtar) + JSON dışa aktarma
- [ ] 100. Onaylı VirusTotal/URLhaus sorgusu
- [ ] 101. YARA kuralı üretme
- [ ] 102. IDS imzası
- [~] 103. Anti-bot sinyal raporu — fingerprint okumaları + bot tespiti API'leri
- [ ] 104. Gizlilik (GDPR) raporu
- [ ] 105. npm supply-chain karşılaştırması
- [ ] 106. Tarayıcı eklentisi (.crx/.xpi) analizi
- [ ] 107. Phishing kit endpoint'leri
- [ ] 108. Redirect zinciri
- [ ] 109. Risk skoru kartı
- [x] 110. Şüpheli API kullanımı
- [x] 111. Dışarıdan yüklenen ikinci aşama script'ler (script src / image / fetch yakalama)
- [ ] 112. Polimorfik varyant aileleri
- [ ] 113. Script değişim takibi
- [ ] 114. Olay müdahale raporu
- [ ] 115. Paylaşmadan önce anahtar maskeleme

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
- [ ] 183. obfuscator.io kombinasyon benchmark'ı
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
