<p align="center">
  <img src="icons/icon128.png" width="96" alt="Ramnesia" />
</p>

<h1 align="center">Ramnesia</h1>

<p align="center">
  Sekmelerini unutur, RAM'ini hatırlar.<br/>
  <em>Forgets your idle Chrome tabs so your RAM doesn't have to.</em>
</p>

---

Chrome'un kendi **Bellek Tasarrufu** özelliği sekmeleri ne zaman uyutacağına kendisi karar verir. Ramnesia ise kuralı sana bırakır: belirlediğin süre (varsayılan 5 dk) boyunca girmediğin her sekme, Chrome'un yerel `tabs.discard` mekanizmasıyla uyutulur. Sekme sekme çubuğunda kalır, tıkladığında yeniden yüklenir.

## Özellikler

- ⏱️ **Süreye göre otomatik uyutma.** 1–240 dk arası ayarlanabilir.
- 📊 **Bellek paneli.** Sistem RAM kullanımı, aktif sekmelerin kullandığı ve uyuyan sekmelerin boşalttığı bellek gösterilir.
- 🏷️ **Rozet.** Eklenti simgesinin üstünde o an boşaltılan bellek yazar (ör. `270M`).
- 🔒 **Sekme kilidi.** Kilitli sekme ne Ramnesia ne de Chrome tarafından uyutulur.
- 🌙 **Tek tıkla uyut.** Tek bir sekmeyi ya da tümünü hemen uyutabilirsin.
- ✅ **Beyaz liste.** Asla uyutulmayacak alan adlarını eklersin.
- 🎧 **Akıllı istisnalar.** Açık sekme, ses çalan, sabitlenmiş ya da yarım form içeren sekmelere dokunulmaz.
- 🔔 **İsteğe bağlı masaüstü bildirimi.**
- 🌗 **Açık / koyu tema.**

## Kurulum

1. Bu depoyu indir veya klonla.
2. Chrome'da `chrome://extensions` adresini aç.
3. Sağ üstten **Geliştirici modu**nu aç.
4. **Paketlenmemiş öğe yükle**'ye tıkla ve proje klasörünü seç.

## Bellek ölçümü hakkında

Chrome, Web Mağazası eklentilerine bir sekmenin toplam süreç belleğini vermez. Ramnesia her sayfanın **JavaScript belleğini** (`performance.memory`) ölçer. Bu değer sekmenin gerçek RAM kullanımının bir alt sınırıdır, yani gösterilen kazanç genelde gerçek kazançtan azdır. Ölçülemeyen sekmeler için 50 MB tahmin edilir ve değerin önüne `≈` konur. Sistem RAM'i `chrome.system.memory` ile okunur.

## İzinler

| İzin | Neden |
| --- | --- |
| `tabs` | Sekmeleri listelemek ve uyutmak |
| `alarms` | 30 saniyede bir kontrol |
| `storage` | Ayarlar ve istatistikler |
| `scripting` + `<all_urls>` | Sayfanın JS bellek değerini okumak (içerik okunmaz) |
| `system.memory` | Toplam / boş RAM bilgisini göstermek |
| `notifications` | İsteğe bağlı uyutma bildirimi |

Hiçbir veri cihazından dışarı gönderilmez.

## Lisans

[MIT](LICENSE)
