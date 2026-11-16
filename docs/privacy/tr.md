<!-- Generated from shared/privacy.json by web/scripts/export-privacy.ts: edit that file, not this one. -->

# Gizlilik

*Peryda Mac, Windows ve web · Son güncelleme: 16 Kasım 2026*

[English](../../PRIVACY.md) · [Deutsch](../../docs/privacy/de.md) · [Español](../../docs/privacy/es.md)

## Kısaca

- Hesap yok, Peryda sunucusu yok; ölçüm, reklam ve izleme yok. Okuduğun, yazdığın ya da sorduğun hiçbir şey geliştiriciye ulaşmaz.
- Mac ve Windows uygulamaları yeni sürüm olup olmadığına ancak sen izin verirsen bakar.
- Kitapların, ilmeklerin, notların ve ayarların senin cihazında kalır.
- Pery'ye bir şey sorduğunda istek, kendi anahtarınla, doğrudan cihazından seçtiğin yapay zekâ sağlayıcısına gider. Sağlayıcı onu kendi koşullarına göre işler.

Bu metin Peryda'nın Mac, Windows ve web sürümlerini kapsar. Peryda'nın iPhone ve Android uygulamaları ile Peryda Cloud'un ayrı bir gizlilik politikası var: peryda.com/privacy

## Cihazında kalanlar

- Eklediğin PDF ve EPUB dosyaları, okuma yerlerin, ilmekler ve kartları, çeviriler, notlar, Kitap Günlüğü ve ayarların. Mac'te Peryda'nın kendine ayrılmış korumalı klasöründe, Windows'ta Windows hesabına ait Peryda uygulama verisi klasöründe, web'de bu tarayıcının bu site için ayırdığı alanda durur. Web'de sitenin verilerini temizlemek hepsini siler. Uygulamayı kaldırmak tek başına silmez: her şeyi silmek için önce Peryda'nın Ayarlar'ından anahtarlarını sil, sonra uygulamayı kaldır; Mac'te ayrıca ana klasöründeki Library/Containers/com.isnalcan.peryda.mac klasörünü sil, Windows'ta kaldırırken uygulama verilerini silen kutuyu işaretle.
- Dışa aktardığın yedek, senin sakladığın bir dosyadır. Kitaplarını ve Peryda'da yazdığın ya da aldığın her şeyi (ilmekler, çeviriler, çıkarılan sayfalar, günlük) içerir, ama anahtarlarını asla içermez ve şifreli değildir.
- Mac'te taranmış bir sayfanın metni, Apple'ın yerleşik metin tanımasıyla Mac'in kendisinde okunur; “Pery ile çıkar”ı seçersen sayfanın resmi sağlayıcına gider.
- Bir kitap internete erişemez: Peryda kitabın içinden internetteki resim, yazı tipi, stil ya da betik yüklemez.

## Anahtarların nasıl korunur

Anahtarların yalnızca bu cihazda saklanır ve yalnızca kendi sağlayıcısına gönderilir. Ayrıntısı:

- Mac'te macOS Anahtar Zinciri'nde dururlar. Anahtar Zinciri onları şifreler ve Mac'ine giriş yaptığında açar; başka bir uygulama onlara ancak sen izin verirsen ulaşabilir.
- Windows'ta ve web'de uygulamanın bu cihazdaki kendi alanında, AES-256 ile şifrelenmiş olarak dururlar. Şifreyi açan anahtarı tarayıcı motoru (Windows'ta Microsoft Edge WebView2) üretir ve dışarı vermez; bu yüzden anahtarların hiçbir dosyada düz yazı olarak görünmez.
- Sınırını da bilmeni isteriz: bu şifreleme, bilgisayarındaki kullanıcı hesabını kullanabilen birine ya da orada çalışan zararlı bir yazılıma karşı tam koruma değildir. Ortak bir bilgisayardaysan “Anahtarları bu cihazda hatırla” seçeneğini kapat; o zaman anahtarların hiç kaydedilmez ve uygulamayı kapatınca (web'de sayfayı kapatınca) unutulur. Web'de ayrıca: her sitedeki verileri okuma izni olan bir tarayıcı eklentisi açık bir sayfadaki her şeyi görebilir; Peryda'yı yalnız güvendiğin eklentilerin olduğu bir tarayıcıda kullan.
- Her anahtar şifreli bağlantıyla (HTTPS) yalnızca kendi sağlayıcısına gider; isteğin başlığında taşınır, adres satırına yazılmaz. Windows'ta ve web'de uygulamanın güvenlik kuralı (Content Security Policy), kendi dosyaları ve bu dört sağlayıcı dışında hiçbir adrese bağlanmaya izin vermez. Peryda internetten kod yüklemez; reklam, ölçüm ya da sohbet eklentisi gibi başka şirketlerin betiklerini içermez.
- Anahtarların yedeklere ve dışa aktarılan dosyalara hiç girmez.
- Önerimiz: Peryda için ayrı bir anahtar oluştur ve sağlayıcında bir harcama sınırı koy. Anahtarının ele geçtiğinden şüphelenirsen onu sağlayıcının sitesinden iptal et; iptal edilen anahtar hemen çalışmaz olur.
- Peryda açık kaynaklıdır: anahtarların nasıl saklanıp gönderildiğini herkes kodda denetleyebilir (github.com/isnalcan/peryda-open).

## Yapay zekâ sağlayıcına gidenler

Yalnızca sen bir şey istediğinde (bir ilmekte soru, sayfa çevirisi, sayfanın metni, günlük özeti ya da anahtarının kullanabildiği modellerin listesi) uygulama sağlayıcına o isteğin gerektirdiğini gönderir:

- isteğin ve o ilmekteki önceki mesajlar;
- seçtiğin metin ve çevresinden kısa bir bölüm, ya da sayfada seçtiğin alanın resmi;
- kitabın adı ve sayfa numarası;
- sayfa çevirisi için sayfanın metni, sayfanın kendi metni yoksa sayfanın resmi; “Pery ile çıkar”ı seçtiğinde seçtiğin her sayfanın resmi;
- günlük özeti için o kitabın günlük kayıtları.

Yalnız istediğin sayfalar gönderilir, kendiliğinden hiçbir şey gönderilmez; bir sayfa aralığı (bir seferde en fazla 200 sayfa) aralıktaki her sayfayı gönderir. İstekler şifreli bağlantıyla (HTTPS) doğrudan sağlayıcıya gider; arada Peryda sunucusu yoktur.

Gemini ile ikiden fazla sayfayı birden çevirdiğinde ya da metnini çıkardığında sayfalar yarı fiyatına toplu iş olarak gider. Google bir işi en fazla 48 saat çalıştırır. Peryda sonuçlar gelince (o kitap Peryda'da açıkken), sen durdurduğunda ya da Gemini anahtarını değiştirdiğinde işi Google'dan siler. Google, silinmemiş bitmiş bir işi ne kadar tuttuğunu söylemiyor.

## Sağlayıcının koşulları

Aldığını ne kadar saklayacağına ve neye kullanabileceğine sağlayıcı karar verir. Kişisel ya da gizli bir metin göndermeden önce onun koşullarını oku. Bilmekte yarar var:

- Google Gemini API: Google, ücretsiz katmanda gönderdiklerini ürünlerini geliştirmek için kullandığını ve bunları insan değerlendiricilerin okuyabileceğini; ücretli katmanda böyle kullanmadığını söylüyor. Gemini API'yi kullananların 18 yaşından büyük olmasını istiyor. Koşullar: ai.google.dev/gemini-api/terms
- DeepSeek, verileri Çin Halk Cumhuriyeti'nde sakladığını söylüyor. Gizlilik politikası: deepseek.com
- OpenAI: openai.com/policies · Anthropic (Claude): anthropic.com/legal/privacy

## İndirme, web uygulaması ve güncellemeler

- Peryda'yı GitHub'dan indirdiğinde o indirme için GitHub'ın gizlilik bildirimi geçerlidir.
- Web uygulamasını Google Firebase Hosting sunar; dosyaları ulaştırmak için IP adresin gibi bağlantı bilgilerini işler. Peryda buna herhangi bir ölçüm ya da istek kaydı eklemedi.
- Windows'ta Peryda, Microsoft'un güncel tuttuğu bir Windows parçası olan Microsoft Edge WebView2 içinde çalışır.
- Mac ve Windows uygulamaları sen izin vermeden yeni sürüm aramaz. İkinci açılışta sorarlar; izin verirsen günde bir kez GitHub'dan küçük bir sürüm dosyası isterler. GitHub bu istekte, her web isteğinde olduğu gibi, IP adresini ve isteği yapan uygulamanın adını ve sürümünü görebilir. Kitapların, notların, anahtarların ya da bilgisayarın hakkında hiçbir şey gönderilmez. Bu denetimi Ayarlar'dan istediğin zaman açıp kapatabilirsin.
- Bir güncelleme yalnızca Peryda'nın güncelleme anahtarıyla imzalanmışsa kurulur; imzası tutmayan ya da değiştirilmiş bir dosya reddedilir. Yeni bir sürüm bulunduğunda uygulama kurmadan önce sorar; Mac'te güncellemelerin kendiliğinden kurulmasını da seçebilirsin.
- Web uygulaması ayrıca bir şey denetlemez: sayfayı her açtığında en yeni sürüm gelir.

## Hakların

Geliştirici bu uygulamalar aracılığıyla hiçbir kişisel veri almadığı için onda gösterilecek, düzeltilecek ya da silinecek bir şey yoktur; her şeyi yukarıda anlatıldığı gibi kendin silebilirsin. Bir sağlayıcının elindekiler için o sağlayıcıya başvur. Peryda yaşını sormaz ve hesap tutmaz; yapay zekâ sağlayıcıları kendi yaş sınırlarını koyar.

## Değişiklikler ve iletişim

Bu metindeki değişiklikler projenin GitHub'daki geçmişinde görünür: github.com/isnalcan/peryda-open. Gizlilik soruları için: privacy@peryda.com. Güvenlik sorunları için projedeki SECURITY.md dosyasına bak.
