// H174: service worker kaydı. Yalnızca derlenmiş (üretim) sürümde ve güvenli bağlamda etkin;
// geliştirme sunucusunda önbellek, sıcak yeniden yüklemeyi bozmasın diye kaydedilmez.
export function registerServiceWorker() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator) || !window.isSecureContext) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(new URL('sw.js', document.baseURI), { scope: './' }).catch(() => {
      // kayıt başarısız olursa uygulama çevrimiçi çalışmaya devam eder
    });
  });
}
