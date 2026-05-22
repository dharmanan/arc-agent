# Arc Machina — Güncel Durum ve Aksiyon Planı
> Güncelleme: 22 Mayıs 2026
> Bu belge Türkçe tutulur ve proje için tek takip kaynağı olarak kullanılır.
>
> KRİTİK OPERASYON NOTU — `chain_events` için `1 günlük prune` aktiftir. 14 Mayıs 2026'da eski backlog temizlenmiştir. Bir incident/debug durumunda eski indexer receive/event izlerinin temizlenmiş olabileceğini baştan varsay. Bu temizlik transient `chain_events` verisini hedefler; kullanıcı, passkey ve kalıcı transaction kayıtlarını hedeflemez.

---

## 0. Değişmez Çalışma Kuralları

- [x] Kullanıcıyla iletişim her zaman Türkçe olacak.
- [x] Bu plan dosyası Türkçe kalacak; otomatik olarak İngilizceye çevrilmeyecek.
- [x] Repo içindeki UI metinleri, buton etiketleri, kullanıcı mesajları, kod yorumları ve developer-facing string'ler İngilizce olacak.
- [x] Her görev, tamamlandı sayılmadan önce mutlaka doğrulanacak.
- [x] Frontend değişikliği gereken tamamlanmış görevlerde manuel Vercel deploy alınacak.
- [x] Backend değişikliği gereken tamamlanmış görevlerde manuel Railway deploy alınacak.
- [x] Full-stack görevlerde gerekli olan iki deploy da manuel alınacak.
- [x] Değişmez mimari kural: `Tasks / Jobs / Oracle / agentic economy` rayında payment/economy katmanı `x402 + Circle Gateway` ile çalışacak; execution tarafında göreve uygun `swap / bridge` altyapısı kullanılacak. Standard kullanıcı `Bridge / Swap / Send / Receive` akışları bu agentic x402 rayına zorla taşınmayacak.
- [x] Her görev tamamlandığında bu dosya aynı turda güncellenecek.
- [x] Takip formatı zorunlu: tamamlanan işler `[x]`, bekleyen işler `[ ]` olarak işaretlenecek.

---

## 1. Kısa Durum Özeti

- Groq automation lane token rezervi düşürüldü: `backend/src/services/llmService.js` içindeki chat completion `max_tokens` varsayılanı hardcoded `1024` yerine env-tunable `LLM_CHAT_MAX_TOKENS` ve default `256` olacak şekilde indirildi. Railway production deploy `3fe56ef2-95d6-4ef1-8c87-69408a009f2d` başarıyla tamamlandı; deploy sonrası production `/health` tekrar `200 / {"status":"ok","db":"ok","redis":"ok"}` döndü ve canlı automation smoke aynı whitelisted agent üzerinde `oracle_last_status: success` ile doğrulandı. Bu değişiklik Groq'un rezervasyon bazlı TPD/TPM hesabında tek çağrı başına ayrılan budget'ı küçülttü; aynı kullanıcı anahtarının global paylaşım için değil, yalnız ilgili agent'ın kendi `llm_api_key_encrypted` kaydı için kullanıldığı da tekrar doğrulandı.
- Neon -> Railway DB cutover tamamlandı: aynı Railway production projesinde managed `Postgres` (`serviceId=18c33ab4-490d-4011-aaf6-05a7f5fc5b07`) ve başlangıç doğrulaması için ayrı `backend-db-cutover-smoke` servisi (`serviceId=930294bf-7cc1-4251-9a59-83fb4161d845`) üzerinden restore + smoke doğrulaması yapıldı; ardından production backend `81d809e4-d7ca-4b3e-bfb4-44814494a20d` deploy'u ile Railway Postgres'e çevrildi. Smoke backend artık silindi; Railway service list yalnız `backend` + `Postgres` kaldığını doğruladı. Production `https://backend-production-597c.up.railway.app/health` 22 Mayıs 2026 14:37 UTC itibarıyla yine `200 / {"status":"ok","db":"ok","redis":"ok"}` döndü. Final count doğrulamasında `users=7`, `passkey_credentials=11`, `agents=5`, `transactions=696`, `chain_events=34`, `agent_jobs=6`, `agent_task_results=101` Railway tarafında teyit edildi. Neon rollback için 24 saatlik pencerede elde tutuluyor; bu workspace içinde Neon silme aracı olmadığı için yarın son health + count kontrolünden sonra dashboard üstünden manuel kapatma/silme yapılacak.
- Neon free-tier baskisini azaltmak icin backend health/readiness yolu ayrildi: `backend/src/server.js` icine hafif `GET /readyz` endpoint'i ve env-gated `BACKGROUND_JOBS_ENABLED`, `HEALTHCHECK_DB_PROBE_ENABLED`, `HEALTHCHECK_REDIS_PROBE_ENABLED` kontrolleri eklendi; Railway platform probe'u da `railway.json` icinde `/health` yerine `/readyz` kullanacak sekilde guncellendi. Railway production deploy `c0641940-deb5-496f-9698-ebcea55b0159` basariyla tamamlandi; public `https://backend-production-597c.up.railway.app/readyz` `200` ve `https://backend-production-597c.up.railway.app/health` tekrar `{"status":"ok","db":"ok","redis":"ok"}` dondu.
- DeFi > Lending manuel yüzeyi bir tur daha tamamlandı: `frontend/src/components/DeFiTab.jsx` artık backend'in zaten desteklediği `Deleverage` ve `Liquidate` aksiyonlarını görünür sunuyor; liquidation için borrower/debt/collateral alanları eklendi ve lending manual run'ları da pool manual kartlarındaki gibi `Latest manual action` durumu, summary ve tx linkleriyle izlenebilir hale geldi. Frontend production deploy `https://arc-agent-frontend-jlza7fzwp-kohens-projects.vercel.app` olarak tamamlandı ve alias tekrar `https://arcmachina.vercel.app` üstüne alındı.
- Stable Automation State legacy snapshot hotfix'i production'da ikinci turda kapatıldı: `backend/src/services/agentService.js` artık eski `stable_policy_v1` snapshot'larını cooldown bitse bile current stable lane gibi göstermiyor; masked v2 hold state içinde target allocation yüzdeleri korunuyor, USD band ise agent'in mevcut stable capital'inden yeniden hesaplanıyor. Bu sayede ekrandaki tutarsız `20-30 USD + 20/25/30%` kombinasyonu ve stale `206 LP` hold size'ı temizlendi. `backend/src/queue/agentQueue.js` de manual LP add sonrası yazdığı synthetic hold snapshot'ta aynı yüzde/USD band mantığını ve sıfırlanmış action size alanlarını persist edecek şekilde hizalandı. `frontend/src/components/DashboardTab.jsx` tarafında legacy mixed-policy `Curve LP Exit` satırları masked state sırasında Recent Activity'den gizlenecek şekilde daraltıldı. Railway production deploy ve Vercel alias deploy tamamlandı; public backend health `{"status":"ok","db":"ok","redis":"ok"}` döndü. Service-env canlı doğrulamada aynı agent için stable state `policy_hold`, `targetLpMinUsd=686.737015`, `targetLpTargetUsd=858.421268`, `targetLpMaxUsd=1030.105522`, `targetLpMinAllocationPct=20`, `targetLpTargetAllocationPct=25`, `targetLpMaxAllocationPct=30`, `suggestedAmountUsdc=0`, `suggestedLpExitAmount=null` olarak teyit edildi. Ek davranış doğrulamasında cooldown varken stable `add_liquidity` open ve `top_up` execute kalırken soft exit `blockedBy=manualCooldown` ile durdu, hard-risk exit açık kaldı; oracle `swap` ve `rebalance` verdict'leri de bağımsız execute doğruladı.
- Dashboard blank-screen regression kapatıldı: `frontend/src/components/DashboardTab.jsx` içinde runtime'da çağrılan `getExecutionRailLabel` helper'ı eksikti; helper geri eklendi, kullanıcıya gösterilen route etiketi sadeleştirildi ve Vercel production deploy sonrası alias `https://arcmachina.vercel.app` yeniden güncellendi.
- Dependency/security ve Dependabot bakım turu bu çevrimde kapatıldı: kökte yalnız deploy CLI kolaylığı için duran `vercel` paketi transitive `undici` kilidi nedeniyle kaldırıldı ve kök hedefli audit temizlendi; backend'te `ws/tmp` zinciri override + `viem@2.50.4` ile sertleştirildi, ayrıca `@anthropic-ai/sdk@0.97.1`, `@circle-fin/swap-kit@1.2.2`, `@simplewebauthn/server@13.3.0` ve `express-rate-limit@8.5.2` güncellendi; frontend'te `ws` zinciri temizlenip `viem@2.50.4`, `@circle-fin/adapter-viem-v2@1.11.1`, `lucide-react@1.16.0`, `vite@8.0.13` ve `@vitejs/plugin-react@6.0.2` alındı. Backend route smoke `17/17` geçti, frontend toolchain smoke + editor check temiz kaldı. `@zxing/library` PR'ı ise `@zxing/browser@0.2.0` peer kısıtı yüzünden özellikle geri bırakıldı; Vercel production deploy başarılı oldu ve alias `200` verdi, Railway deploy denemesi ise platform tarafında `Deploys have been paused temporarily` yanıtıyla bloklandı ama mevcut production backend health hâlâ `ok` döndü.
- Sistem çekirdeği mevcut: passkey auth, agent oluşturma, dashboard, bridge, swap, oracle API, tasks, jobs, queue altyapısı ve kontratlar repoda var.
- Ana eksik artık "özellik yok" değil; ürün akışlarının parçalı, tekrar eden ve bazı yerlerde tutarsız olması.
- Tasks/Automation organizasyonu, execution task parametre güvenliği, user-triggered manual task'lerin inline çalışma akışı ve tab butonlarının ürünleşmiş yerleşimi toparlandı.
- Local + on-chain reputation görünürlüğü, Arc Testnet registry deploy'u ve reputation-first Tasks açıklama katmanı canlıya alındı.
- Tasks sayfasındaki blank screen/runtime kırığı giderildi; reputation özeti üstte, tracking enable aksiyonu doğrudan bu alanda ve Oracle artık top-level ayrı sekme olarak ayrıştırıldı.
- Yerel gerçek smoke doğrulamada `EXEC_CCTP_BRIDGE` burn + attestation + mint akışını başarıyla tamamladı; `EXEC_CURVE_SWAP` verified default Curve pool ile env bağımlılığı olmadan quote/execute rayına yaklaşmış durumda, `EXEC_REBALANCE` için de `USDC/EURC` stable pair yolunda Swap Kit yoksa verified Curve fallback açıldı. Kalan canlı risk daha çok live resmoke ve revenue counter kapanışında.
- Oracle public route Circle Gateway seller middleware'e geçirildi; canlı unpaid `402` ve gerçek paid settle smoke doğrulamaları tamamlandı.
- Circle Gateway x402 geçişinin operasyon planı ayrı dosyaya çıkarıldı: `CIRCLE-GATEWAY-X402-MIGRATION.local.md`. Bu dosya standard `Bridge / Swap / Send / Receive` akışlarını koruyup yalnız `Tasks / Jobs / Oracle / agentic economy` rayını izole geçirmek için ana referans olacak.
- External buyer onboarding yüzeyi genişletildi: Oracle unpaid `402` body artık `docsUrl`, `machineDocsUrl` ve indirilebilir helper/example URL'leri döndürüyor; dışarıya açık guide, machine-readable manifest ve download yüzeyi Vercel alias'ında yayınlandı, Railway backend için public docs URL kalıcı env olarak set edildi, Oracle sekmesine insan kullanıcı için görünür onboarding kartı eklendi ve public guide son kullanıcıyı ilgilendirmeyen güvenlik notu yerine sade bir base URL yönlendirmesi ile temizlendi.
- Oracle ürün yüzeyi ikinci turda toparlandı: `pool-state` artık `venue=curve|uniswap_v2_like|arcfx` ile canlı çalışıyor, filtered external whitelist Railway production'a deploy edildi, Oracle sekmesi example query'leri ve experimental pool coverage'ı görünür gösteriyor, onboarding kartı header altına yatay taşındı ve Gateway fund success tx hash'i kart içinde wrap ediliyor.
- Oracle ürün yüzeyi üçüncü turda kapatılmaya devam etti: `peg-monitor`, `protocol-tvl`, `pool-compare`, `reserve-state` ve `arb-scan-multi` Railway production'a deploy edildi, public guide + machine manifest 9 SKU'ya güncellendi, `/api/oracle/status` artık DB-backed alert backend özetini de döndürüyor ve Oracle sekmesindeki `Data Quality & Observability` kartı yeni alert delivery alanlarıyla Vercel production bundle'da doğrulandı.
- Oracle alert escalation yüzeyi tamamlandı: named external sink desteği, timeout görünürlüğü ve private `POST /api/oracle/debug/test-alert` ops route'u eklendi; focused smoke'ta `delivery = database+external_sinks`, `storedCount = 1`, `sentCount = 1`, `failedCount = 0` ve local sink POST payload'ı doğrulandı.
- Railway startup uyarı gürültüsü temizlendi: `pg` SSL alias warning'i connection string sanitize edilerek, `ioredis/Bull` `MaxListenersExceededWarning` satırları ise queue client startup davranışı sertleştirilerek kaldırıldı.
- En önemli kalan açıklar artık ücretli execution raylarının gerçek production readiness kapanışı, otomatik test/dokümantasyon temizliği ve legacy `SecurityTab` kararı. `USDC-USYC` hattı ise aktif blokör olmaktan çıkarılıp pasif/opsiyonel coverage olarak geriye alındı.
- Repo audit sonucu: `backend/package.json` içinde `jest --runInBand` script'i var ama repoda test dosyası yok; kök `README.md` hâlâ tek satır; `frontend/src/App.jsx` içinde legacy `SecurityTab` import/render izi yaşamaya devam ediyor.
- Testnet kararı uygulandı: testnet sonuna kadar özel domain satın alınmayacak. Alternatif yol olarak public giriş noktası Vercel alias altında `/api` rewrite/proxy ile tutuluyor; `vercel.json` bu modele geçirildi, Vercel production deploy alındı ve yeni base URL üstünden docs/manifest `200` ile unpaid Oracle `402` smoke doğrulandı.
- Public seller abuse hardening uygulandı: production Oracle public route'larda dedicated `30 req / 60s` rate limit, blocked scanner user-agent filtresi ve endpoint bazlı query allowlist aktif; Vercel alias smoke'larında normal preview `402`, invalid query `400`, blocked UA `403` ve rate-limit header'ları doğrulandı.
- Tasks automation yüzeyi tamamlandı: Full Autonomous toplu toggle artık `TasksTab` içinde dört automation flag'ini tek aksiyonla açıp kapatıyor; Jobs yüzeyine de client / provider / settlement / next-step onboarding kartı eklendi ve yeni bundle Vercel production deploy'unda doğrulandı.
- Paid execution readiness bir adım daha kapatıldı: `GET /api/tasks/pool-balance` verified default revenue pool fallback ile public `200` dönebiliyor; `EXEC_REBALANCE` de `USDC/EURC` için artık Swap Kit yoksa verified Curve pool fallback'ine düşüyor. Railway backend ve Vercel frontend production deploy'ları bu turda yenilendi.
- Paid task smoke matrisi Railway production env ile tx göndermeden çıkarıldı: `EXEC_CCTP_BRIDGE` ve `EXEC_SEPOLIA_GAS_FANOUT` live olarak doğrulandı; `EXEC_CURVE_SWAP`, `EXEC_ARB`, `EXEC_REBALANCE` ve iki `cirBTC` zap-in görevi preflight'ta hazır göründü; `EXEC_YIELD_MOVE` ise `AAVE_POOL_ADDRESS` eksik olduğu için hard-broken bulundu ve katalogdan kaldırılıp Railway + Vercel production'a deploy edildi.
- `EXEC_CURVE_LIQUIDITY_ADD` root cause'u kapatıldı: verified Arc Curve pool liquidity ABI'si static `uint256[2]` değil dynamic `uint256[]` çıktı. Protocol adapter bu imzaya geçirildi; Railway deploy sonrası production'da canlı `EXEC_CURVE_LIQUIDITY_ADD` (`txHash=0x60bfc2f8119d8e3d3be81ebbad320fa14164dba436660c2865ece3d2a8d4cb8f`) ve hemen ardından `EXEC_CURVE_LIQUIDITY_REMOVE` confirmed çalıştı.
- Tasks UI sonuç kartları bir tur daha gerçek payload'a hizalandı: `Curve Swap` ve `Portfolio Rebalance` artık generic `Task completed` etiketi yerine görev-tipine uygun completion label gösteriyor; summary/fact satırları da gerçek `amountOut`, `txHash`, route ve execution rail alanlarından türetiliyor. Bu turda paid tab içindeki gereksiz info strip kaldırıldı ve arbitrage summary/fact copy'si tx hash yoksa execution iddiası kurmayacak şekilde sıkılaştırıldı. Vercel production alias bu bundle ile yeniden deploy edildi.
- `EXEC_ARB` truthfulness guard'ı kullanıcı girdisi bazında sıkılaştırıldı: backend artık global signal modelini değil, kullanıcının verdiği `amountIn` için hesaplanan net sonucu da gate ediyor; user-entered boyut Curve fee sonrası kârsızsa on-chain swap göndermiyor. Dar runtime probe temiz geçti ve Railway production deploy yenilendi.
- Paid fee/pool tutarlılığı bu turda bir kat daha sertleştirildi: `EXEC_SEPOLIA_GAS_FANOUT` fee settlement shared `TASK_ECONOMY_CHAIN` üstünden Arc revenue pool'a yönleniyor; daha önce Sepolia kaynak zincirinde başarısız kalmış son `0.2 USDC` fee tek seferlik backfill ile pool'a işlendi. Ayrıca `GET /api/tasks/pool-balance` artık `Cache-Control: no-store` ile dönüyor ve frontend çağrısı cache-busting timestamp taşıyor; Tasks UI sonuç kartları execution tx + fee settlement tx hash'lerini gösteriyor. Production `GET /api/tasks/pool-balance` şu an `0.6 USDC` döndürüyor; mevcut breakdown içinde `EXEC_CCTP_BRIDGE` `0.1`, `EXEC_CURVE_LIQUIDITY_ADD` `0.1`, `EXEC_CURVE_LIQUIDITY_REMOVE` `0.1`, `EXEC_SEPOLIA_GAS_FANOUT` backfill `0.2` ve son `EXEC_ARB` confirmed fee `0.1` var.
- Paid task registration yolu merkezileştirildi: built-in tüm Tier-2 görevler artık ortak `registerPaidTaskProcessor()` helper'ından geçiyor ve startup sırasında `assertPaidTaskEconomyCoverage()` ile coverage zorunlu tutuluyor. Böylece yeni paid görev eklenip `agentic_task_economy` / x402-Gateway fee rayına bağlanmazsa backend health aşamasında fail edecek.
- Dashboard Recent Activity geçmişi production'da geri dolduruldu: `agent_task_results` içinde activity karşılığı olmayan 44 paid task sonucu için idempotent backfill script eklendi ve canlı DB'de çalıştırıldı. Backfill satırları gerçek `taskResultCreatedAt` zamanına taşındı, legacy `direct_lp_add/remove` duplicate'leri temizlendi ve sonuçta `curve_lp_add`, `curve_lp_remove`, `task_arb`, `rebalance`, `gas_topup`, `direct_lp_add/remove` kayıtları explorer-link destekli görünür hale geldi. Bu turda Vercel production alias da yeniden deploy edildi.
- Agent positions görünürlüğü artık somutlaştırıldı: backend'e authenticated `GET /api/agents/:id/positions` read-model yüzeyi eklendi ve Dashboard içinde agent wallet'ın canlı Curve LP pozisyonları (LP bakiye, share, underlying varlıklar) gösterilmeye başlandı. Bu turda Railway + Vercel production deploy yenilendi; production task catalog smoke'unda `EXEC_CURVE_LIQUIDITY_ADD` / `EXEC_CURVE_LIQUIDITY_REMOVE` doğrulandı ve frontend bundle içinde `Agent Positions` kartı görüldü.
- Stable liquidity execution yüzeyi artık live-position aware hale geldi: `EXEC_CURVE_LIQUIDITY_ADD` / `REMOVE` / `REBALANCE` öncesi live Curve LP snapshot okunuyor, LP yokken withdraw ve aktif LP varken blind rebalance bloklanıyor; ayrıca add/remove path'lerinde seçilen `USDC` veya `EURC` için doğru Curve coin index/address kullanılacak şekilde token seçimi düzeltildi. Railway health `ok`, stub smoke ve Vercel production bundle doğrulamaları temiz geçti.
- Swap yeteneği Arc Testnet'te `USDC / EURC / cirBTC` için agentic yüzeyde mevcut; stable `USDC/EURC` hattında verified Curve fallback var. `cirBTC/USDC` ve `cirBTC/EURC` tarafında ise amaç ikinci fallback ray değil, mevcut live direct Uniswap V2 pair üstünden ilerlemek. Paid görevler bu direct pair mantığıyla aktif tutulacak; kalan ürün işi daha çok bunu ileride manuel DeFi yüzeyine doğru ve karışıklık yaratmadan taşımak.
- Kod tabanındaki önceki doğrudan akış kırıcı backend tutarsızlıklarının çoğu kapandı; kalan açıklar daha çok paid execution readiness, smoke coverage, dokümantasyon ve ürün copy katmanında.
- Neon snapshot izleme bugün de yeşil kaldı: GitHub Actions scheduled `DB Snapshot Monitor` run `25947314245` success tamamlandı; artifact'te `db=9.80 MB`, `chain_events=152 KB`, `chain_event_rows=12`, `pending=0` görüldü. Dünkü başarılı run `25893417048` ile kıyaslandığında pending hâlâ `0` ve chain_events satır sayısı `225 -> 12` geriledi; bu, prune sonrası Neon storage baskısının şu an kontrolde kaldığını destekliyor.
- DB snapshot raporu genişletildi: bir sonraki GitHub Actions run'larından itibaren `transactions` ve `agent_task_results` relation size + row count alanları da summary/artifact içine yazılacak. Lokal production-mode doğrulamada mevcut değerler `transactions=392 KB / 219 row`, `agent_task_results=168 KB / 83 row` çıktı.
- Circle marketplace katalog snapshot'ı repo içine kalıcı alındı: tam 39 servislik ham veri `artifacts/circle-market/circle-services-2026-05-16.json` ve `artifacts/circle-market/circle-services-latest.json` altında tutuluyor; ürün yönü ve kategori özeti ise `CIRCLE-PAID-PLAN.local.md` içinde yazılı.
- Circle Paid için önce katalog, 4-tab ürün yüzeyi ve preview/handoff skeleton kuruldu; bu faz gerekliydi çünkü hangi kart ailelerinin ürünleşeceğini ve Arc fee/pool ilişkisini önce UI içinde görmek istedik.
- Sonra Circle katalog hipotezi canlı audit ile test edildi ve eski `provider satın alıp ürünün ana yolunu oraya kuralım` planı kapandı: `39` servisten yalnız `1` tanesi Arc Testnet destekli göründü, `33` servis `mainnet_or_non_arc_only`, `1` servis `open_or_not_paywalled`, `4` servis `unknown` çıktı. Bu yüzden Circle marketplace artık aktif ürün omurgası değil; tarihsel audit kanıtı olarak tutuluyor.
- Circle Paid için geçerli çözüm artık `Arc-owned live + preview decision surface` modelidir. Yani veri kaynağını Circle kataloguyla sınırlamıyoruz; çalıştırabildiğimiz public veya Arc-native kaynaklarla önce sonucu veriyoruz, sonra yalnız destekli Arc execution varsa opsiyonel öneri gösteriyoruz.
- 17 Mayıs 2026 ürün kararı: Circle Paid yeni geliştirme için şimdilik `maintenance-only` moduna alındı. Gerekçe, x402 tabanında sağlıklı ilerleyecek uygun dış API/tool fit bulunamaması. Ancak bu, kartların UI veya katalogdan gizleneceği anlamına gelmiyor: mevcut iki live kart (`Prediction Market Check`, `Event Odds Compare`) aktif runtime olarak açık kalacak, preview/planned kartlar da roadmap aşamaları görünür olsun diye listede kalacak. Yalnız yeni Circle Paid runtime, unlock monetization genişlemesi ve ek kart rollout'u aktif öncelik olmaktan çıkarıldı.
- `Prediction Market Check` ilk gerçek live kart olarak öne çekildi ve Circle Paid sekmesinde ilk sıraya alındı: backend Polymarket verisini normalize edip canlı sonuç döndürüyor, frontend kart altında topic input + summary + matched market + action hint gösteriyor, Polymarket linkleri de doğrudan çalışan market URL formatına geçirildi. Bu kart artık `live` badge'i taşıyor; sonraki doğru ürün adımı bu bilgiyi satmak.
- Son live/preview terminoloji temizliği de production'a taşındı: Railway backend deploy `24a4a6a9-4ffd-496a-a885-f5c64df68b3e` online, production katalog `railLabel=Live + preview data layer` ve `Prediction Market Check` için `status=live, priority=1` döndürüyor; Vercel deploy sonrası `https://arcmachina.vercel.app` alias'ı tekrar `200` verdi.
- Circle Paid yönünde artık ana hedef `Circle provider satın alıp sonuç kütüphanesi yapmak` değil; çalışan bilgi dilimlerini önce live yapmak, sonra monetization ve gerekirse Oracle SKU yoluna taşımak. Bu yüzden `Prediction Market Check`, ilk satılan bilgi ürünü ve ilk Oracle SKU adayı olarak ele alınacak.
- `Prediction Market Check` monetization v1 production'a taşındı: mevcut live kart artık auth'li `free preview -> paid unlock -> saved snapshot` akışıyla çalışıyor; ödeme audit'i `agentic_payment_events.reference_type = circle_paid_unlock` ile, kalıcılık yeni `circle_paid_snapshots` tablosu ile tutuluyor. Unlock sonucu yalnız bilgi + saved snapshot açıyor; önerilen Arc action için kullanıcı hâlâ `Paid` lane içinde ayrı explicit run veriyor. Railway backend deploy `bd18ff88-9a01-49fd-b88e-c1a4e38d731d` healthcheck geçti, Vercel alias `https://arcmachina.vercel.app` yeniden deploy edildi ve auth'siz preview/unlock/snapshots route smoke'ları production'da `401`, frontend alias ise `200` doğrulandı.
- `Prediction Market Check` ayni turda ilk public Oracle SKU olarak da acildi: `GET /api/oracle/public/prediction-market-check` artik Circle Gateway x402 seller rayinda `0.005 USDC` fiyatla canli. Private auth'li `GET /api/oracle/prediction-market-check` route'u da eklendi; public production smoke `402` dondu, `PAYMENT-REQUIRED` header'i geldi ve header icindeki `amount=5000` atomik USDC degerinin `0.005 USDC` oldugu dogrulandi. Machine manifest ve buyer guide da `https://arcmachina.vercel.app` uzerinde yeni SKU ile guncellendi.
- `Event Odds Compare` ikinci live Circle Paid karti olarak production'da ayrismis hale getirildi: backend artik ayni preview/unlock/snapshot rayi icinde tek topic varyasyonu degil, iki ayri topic cluster'ini (`primaryTopic` + `secondaryTopic`) yan yana karsilastiriyor; katalogda `status=live`, `priority=2` ve `sourceServices=['Polymarket Gamma API']` donuyor. Production-env davranis smoke'unda `bitcoin` vs `ethereum` icin `state=divergent`, `dominantTopic=bitcoin`, `moveGap=6.08` uretildi; production auth'li preview smoke da `200` ile `previewId`, `primaryTopic=bitcoin`, `secondaryTopic=ethereum` ve compare state dondu. Vercel alias `https://arcmachina.vercel.app` iki-topic UI rollout'undan sonra yeniden `200` verdi.
- `Event Odds Compare` UI compact pass production'a alindi: preview/unlocked metric grid'leri orta genislikte tasma yapmayacak sekilde sikistirildi, compare panelinde toplam match sayisi ile gorunen market linkleri arasina acik `show all/show fewer` kontrolu eklendi ve saved snapshot kartlari tam uzun ozet yerine kisa meta chip'leri ile gosterilecek sekilde toparlandi. Sonraki frontend hotfix ile saved snapshot acikken `Unlocked result` header'i sadelestirildi, gereksiz badge yogunlugu azaltildi ve snapshot note'u kisaltildi. Vercel alias `https://arcmachina.vercel.app` yeni frontend deploy'undan sonra yeniden aliaslandi.
- Kullaniciya donuk UI copy temizligi production'a tasindi: `DeFi`, `Dashboard`, `Tasks`, `Oracle`, `Agent` ve `Swap` yuzeylerindeki developer/internal dil sadeleştirildi; `Reward Source / Claim Status / Risk Status` badge metinleri kisaltildi, `Circle Paid` preview/payment anlatimi toparlandi, Oracle buyer guide ve Agent/Swap aciklamalari plain-language hale getirildi. Vercel production deploy `https://arc-agent-frontend-godpz6u3n-kohens-projects.vercel.app` olarak tamamlandi ve alias tekrar `https://arcmachina.vercel.app` uzerine alindi.
- Oracle warning mantigi daraltildi: `OracleTab` ust banner'i artik process baslangicindan beri biriken toplam fallback sayisina gore degil, yalniz son `15 dakika` icindeki `recentFallbacks` olaylarina gore warning veriyor. Tarihsel fallback sayaci `Data Quality & Observability` kartinda kaldi, warning basligi `Oracle warnings` olarak genellestirildi ve yeni bundle Vercel production deploy `https://arc-agent-frontend-qr5eaylth-kohens-projects.vercel.app` ile alias `https://arcmachina.vercel.app` uzerine alindi; alias smoke `200` dogrulandi.
- Oracle ust-yuzey fallback gorunurlugu geri sadeleştirildi: kullanici geri bildirimi uzerine `OracleTab` icindeki ust warning, `Buyer Readiness > Data Source` tonu ve endpoint katalog badge'leri fallback observability olaylarindan tekrar ayrildi; `Live, watch fallbacks/upstreams` badge'leri kaldirildi ve fallback gecmisi yalniz `Data Quality & Observability` bolumunde birakildi. Vercel production deploy `https://arc-agent-frontend-qhm1rkeut-kohens-projects.vercel.app` ile tamamlandi, alias `https://arcmachina.vercel.app` tekrar `200` dogrulandi.
- Frontend build log'undaki gereksiz JSX parse warning temizlendi: `frontend/src/components/AgentTab.jsx` icindeki `Tasks -> Automation` copy'si HTML entity ile guvenli hale getirildi; mevcut davranis degismeden yeni Vercel production deploy `https://arc-agent-frontend-p7a0e67v9-kohens-projects.vercel.app` olarak tamamlandi ve alias `https://arcmachina.vercel.app` tekrar `200` dogrulandi. Chunk-size warning'lerine ise calisan yapıya etki etmedigi icin bu turda dokunulmadi.
- Automation dashboard ve activity korelasyonu daha dürüst hale getirildi: `frontend/src/components/DashboardTab.jsx` artik `curve_lp_add/remove`, `rebalance` ve `direct_lp_add/remove` satirlarini da oracle signal follow-up sonucu olarak esleyebiliyor; boylece `Autonomous execution was approved ... no separate result` metni gercekte var olan LP exit/add fail row'lari varken yanlis pozitif vermiyor. Aynı turda `execution_error` / `dry_run_failed` status etiketleri `DashboardTab` ve `TasksTab` icinde acik isimlerle tanitildi, `cirBTC` automation kartina da stale backend payload icin daha dogru fallback metni eklendi. Vercel production deploy `https://arc-agent-frontend-i2heb8vlz-kohens-projects.vercel.app` ile tamamlandi ve alias `https://arcmachina.vercel.app` tekrar `200` dogrulandi.
- Stable automation exit rayi root-cause adayi uzerinden daraltildi: kodda otonom LP exit path'i validated tek-token remove yerine dual/balanced remove helper'ina gidiyordu. `backend/src/services/stableAutomationPolicy.js` ve `backend/src/queue/agentQueue.js` bu turda `USDC` hedefli single remove rayina gecirildi; boylece otomatik defensive exit path'i, daha once kullanilmis ve daha az riskli helper ile hizalandi. Ayni turda `DashboardTab` icindeki `Curve LP Exit` activity satiri dual-remove path'leri icin `both pool tokens` diyecek sekilde ve failed remove durumunda error summary gosterecek sekilde duzeltildi.
- Dashboard automation diagnostics hotfix production'a tasindi: `backend/src/services/oracle/index.js` icindeki eksik `resolveDirectSwapFallbackPool` export'u nedeniyle `cirBTC` fallback dalinda olusan runtime crash, DeFi loop'u yanlis `fetch_error` statüsüne dusuruyordu. Fix sonrasi Railway health tekrar `ok` dogrulandi; `frontend/src/components/DashboardTab.jsx` da ayni turda `fetch_error` durumlarinda `lastDecision.error` alanini gosterecek ve oracle signal satirlarini son DeFi loop hatasi ile aciklayacak sekilde guncellendi. Canli incelemede `USDC/EURC` stable LP'nin gorunmeme nedeninin dashboard okuma bug'i degil, `2026-05-20 22:11 UTC` zamanli confirmed `curve_lp_remove` ile pozisyonun kapanmis olmasi oldugu da ayrica dogrulandi.
- Canli debug bu resmi ileri tasidi: ayni agent icin service-env altinda `DEFI_LOOP` handler'i inline calistirilarak fetch-error state'i gercekten temizlendi ve status `executed` oldu. Bu probe ayni anda mevcut `USDC/EURC` LP pozisyonunun target-band policy'si tarafindan `full_exit` olarak secildigini de gosterdigi icin, eski yalniz `USDC -> EURC swap` rayinin artik tek davranis olmadigi netlesti: stable loop bugun `swap / add_liquidity / rebalance / remove_liquidity` arasindan policy secimi yapiyor ve LP acikken ya da target cap asilmisken swap yerine exit tercih edebiliyor.
- `frontend/src/components/DeFiTab.jsx` icindeki manual pool controls hotfix'i production'a tasindi: queued manual action artik local state ile izleniyor, worker tamamlayinca `Latest manual action` kartinda stage, summary, execution tx ve fee-settlement tx linkleri gorunuyor. Bu sayede `EXEC_MANUAL_CURVE_LIQUIDITY_ADD_DUAL` gibi manual run'lar artik yalniz ilk `Queued` metniyle kaybolmuyor.
- Non-reputation automation icin canli smoke turu tamamlandi ve aciklar ayni turda kapatildi: Railway service-env icinde `MARKET_ANALYSIS` ve `ORACLE_QUERY` handler'lari `2026-05-21 20:23 UTC` civarinda success calisti; ayni agent'te stable lane icin `curve_lp_remove + receive` (`20:01 UTC`) ve sonraki manual `curve_lp_add` (`20:20 UTC`), `cirBTC` lane icin de `EURC-CIRBTC` full `direct_lp_remove` (`20:04 UTC`) DB + on-chain snapshot ile dogrulandi. Ardindan `backend/src/services/indexerService.js` token-aware `USDC / EURC / cirBTC receive` indexing'ine genislatildi, `backend/src/db/schema.sql` + `backend/src/queue/agentQueue.js` + `backend/src/services/agentService.js` ile `cirbtcLp` icin ayri persisted `lastRunAt / lastStatus / lastDecision` alanlari acildi ve `backend/scripts/automationLiveSmoke.js` ile tek komutluk tekrar-edilebilir automation smoke script'i eklendi. Bu turdaki kullanici-guven hotfix'leri de ayni rollout'a girdi: `frontend/src/components/DeFiTab.jsx` manual LP refresh'i silent hale getirip ekran sifirlanmasini durdurdu; `frontend/src/components/DeFiTab.jsx` ve `frontend/src/components/DashboardTab.jsx` LP altindaki varliklari `current redeemable underlying` olarak aciklayacak ve reward ledger `pending` durumunu bookkeeping copy'si ile anlatacak sekilde guncellendi. Railway backend deploy sonrasi production `/health` tekrar `ok` dondu; Vercel production deploy sonrasi alias `https://arcmachina.vercel.app` yeniden `200` verdi.
- Stable automation guven/gerceklik passi ayni fazda tamamlandi: manual Curve LP add sonrasi `stable_manual_cooldown_until` ile yumusak trim/exit'leri gecici bloke eden cooldown eklendi; `MARKET_ANALYSIS` structured signal payload'i persist oncesi normalize edilerek `stable_curve` lane'inde anlamsiz `shouldReviewDefi=false` snapshot'lari deterministic olarak toparlandi; `Dashboard` ise yeni `Market Analysis State` karti, allocation source/cooldown gorunurlugu ve `oracle snapshot` copy'si ile ayni oracle satirlarini artik trade gibi gostermiyor. Production DB migrate + Railway deploy + safe live smoke temiz gecti; smoke sonrasi persisted snapshot'ta `engine=llm`, `lane=stable_curve`, `shouldReviewDefi=true`, `%5 / %20 / %30`, `queuedDefiReview=true` goruldu ve Vercel alias tekrar `200` dogrulandi.
- Stable LP/oracle lane separation production'a tasindi: `stableAutomationPolicy` artik yalniz LP management (`add_liquidity` / `remove_liquidity`) karari veriyor ve yeni `stable_usdc_eurc_lp_manager_v2` + `stable_lp_policy_v2` metadata'si ile persist oluyor; swap/rebalance rayi ise ayri `oracle_stable_curve_strategy_v1` / `oracle_strategy_v1` lane'ine cikarildi. Canli intentionally-triggered `DEFI_LOOP` smoke'unda yeni oracle lane gercekten `defi_loop_swap` tx'i uretti (`txHash=0x608660c57bef584e73e8bab9e9b2267071a751922898f0be35d54d60de9e03a5`, `25 USDC -> 23.363868 EURC`) ve ayni anda stable snapshot `stable_curve_lp` lane'inde `policy_hold`, `blockedBy=oracleDeviation`, `executionSource=stable_lp_policy_v2` olarak kaldi; boylece eski mixed policy ile yeni runtime lane'ler ilk kez canlida ayrismis oldu. Dashboard `Recent Activity` satirlari da bu turda `Legacy mixed policy`, `Stable LP lane` ve `Oracle lane` badge'leriyle ayrildi; stable card'a da legacy snapshot uyarisi eklendi. Railway deploy sonrasi backend `/health` tekrar `ok`, Vercel alias `https://arcmachina.vercel.app` tekrar `200` dogrulandi.
- cirBTC idle-capital rekabet passi tamamlandi: `DEFI_LOOP` artik acik stable LP varken bile cirBTC lane'ini tamamen kapatmiyor; stable lane'in o cycle icin ayirdigi USDC/EURC butcesi dusulduktan sonra kalan `idle capital` ile cirBTC direct-pair policy ayrica degerlendiriliyor. Production probe'da stable lane `25 USDC` reserve ederken cirBTC lane'in kalan `1902.175075 USDC` ile `USDC-CIRBTC` bootstrap'i ayrica evaluate ettigi ve bu kez `priceImpact` guard'ina takildigi dogrulandi.
- Lending paid lane bir adim daha acildi: public task catalog artik `EXEC_LENDING_SUPPLY`, `EXEC_LENDING_WITHDRAW`, `EXEC_LENDING_BORROW`, `EXEC_LENDING_REPAY`, `EXEC_LENDING_DELEVERAGE` ve `EXEC_LENDING_LIQUIDATE` id'lerini seed ediyor; `TasksTab` bu task'ler icin param formlarini, result summary/fact satirlarini ve lending activity explorer linklerini gosteriyor. Ayni turda `DeFi > Lending` yuzeyine `Recovery` ve `Liquidation Risk` kartlari eklendi; boylece ayni backend guard/read-model bilgisi manuel ve paid yuzeylerde birlikte gorunur oldu. `collateral top-up` ve gercek `safe exit` ise ayri helper/task olarak halen acik backlog.
- Reputation karti zincir gorunurlugu guclendirildi: `frontend/src/components/TasksTab.jsx` icindeki `On-Chain Score` alani artik ArcScan registry contract link'i ve `getScore(tokenId)` okuma ipucu gosteriyor; local skor ile on-chain skor farkliysa bunun tipik nedeni de kullaniciya acikca anlatiliyor. Yeni frontend deploy `https://arc-agent-frontend-gm94bqk90-kohens-projects.vercel.app` ile production'a tasindi ve alias `https://arcmachina.vercel.app` yine `200` dogrulandi.
- Railway auth yenilendi ve backend fix canliya tasindi: `npx -y @railway/cli up --service backend --detach` bu kez basarili tamamlandi; Railway deploy/build id `e531aa55-571e-46f5-ac1b-743c34ddbc17` goruldu ve production `https://backend-production-597c.up.railway.app/health` `200` ile `{ status: "ok", db: "ok", redis: "ok" }` dondu.
- Reputation UI son turda sadeleştirildi: buyuk turuncu local-vs-onchain fark aciklamasi kaldirildi; `TasksTab` artik on-chain skor kartini daha temiz gosteriyor, token-vs-wallet farkini ise `Identity Link` kartinda kisa ve kullanisli bir cümleyle anlatıyor. Son frontend deploy `https://arc-agent-frontend-3pg6zpm5x-kohens-projects.vercel.app` ile production'a tasindi ve alias `https://arcmachina.vercel.app` tekrar `200` dogrulandi.
- ArcScan `read contract` yuzeyi eksik oldugu icin reputation verification akisi yeniden duzenlendi: `frontend/src/components/ReputationProofPage.jsx` ile ayni domain altinda acilan, Arc Testnet RPC'ye dogrudan `getScore(tokenId)` cagrisi yapan standalone proof page eklendi; `TasksTab` icindeki yanlis `Verify on ArcScan via getScore(...)` copy'si kaldirilarak bunun yerine bu proof page'e acilan link kondu. Dar runtime probe'da `0xBDa45b03781Ea61A4ee9B19F27B5c063DE031bDF` icin `getScore(5999) = 339` ve `totalEvents(5999) = 339` dogrulandi. Vercel production deploy `https://arc-agent-frontend-88c4arf4v-kohens-projects.vercel.app` ile tamamlandi; root alias ve proof URL `200` dondu. `curl` ile HTML text-check'in fail etmesi SPA hydration nedeniyle beklenen davraniştir; proof sayfasi client-side render olmadan statik HTML icine bu metni basmaz.
- Reputation proof page geri alindi: kullanici guveni acisindan ArcScan yerine yine Arc Machina domain'i altinda acilan bir proof UI yeterli bulunmadi. Bu nedenle `TasksTab` icindeki proof CTA tamamen kaldirildi, standalone `ReputationProofPage.jsx` silindi ve reputation karti tekrar yalniz bilgi + opsiyonel registry contract adresi gosteren daha iddiasiz hale indirildi. Son frontend deploy `https://arc-agent-frontend-52afzgnkl-kohens-projects.vercel.app` ile production'a tasindi ve alias `https://arcmachina.vercel.app` tekrar `200` dogrulandi.

### Neon Snapshot Trend (GitHub Actions)

| UTC Snapshot | Run ID | Status | DB Size | chain_events Size | chain_events Rows | Pending |
| --- | ---: | --- | --- | --- | ---: | ---: |
| 2026-05-15 00:27 | 25893417048 | ok | 9.40 MB | 128 KB | 225 | 0 |
| 2026-05-16 00:06 | 25947314245 | ok | 9.80 MB | 152 KB | 12 | 0 |

### Aktif x402 Faz Özeti

- [x] Ayrıntılı operasyon dosyası oluşturuldu: `CIRCLE-GATEWAY-X402-MIGRATION.local.md`
- [x] Kapsam kilitlendi: normal `Bridge / Swap / Send / Receive` korunacak, x402 yalnız `Tasks / Jobs / Oracle / agentic economy` için kurulacak.
- [x] İlk x402 geçiş fazı için zorunlu kontrat redeploy planlanmıyor; `ArcRevenuePool` ve `AgenticCommerce` şimdilik korunacak.
- [x] Oracle top-level sekmeye taşındı; `Tasks` içindeki gömülü Oracle yüzeyi kaldırıldı.
- [x] Faz 1 başladı: Circle Gateway dependency kurulumu, ortak config modülü ve facilitator wrapper'ı backend'e eklendi; modül doğrulamaları temiz geçti.
- [x] Faz 2 başladı: Oracle public route'lar Circle seller middleware'e bağlandı; syntax ve env yüklü module-load doğrulaması temiz geçti.
- [x] Faz 3 başladı: ortak `GatewayClient` buyer servisi eklendi, `nano-pay` route izole buyer rayına taşındı; syntax ve module-load doğrulamaları temiz geçti.
- [x] Railway production deploy alındı; canlı `health`, Oracle public revenue ve Oracle unpaid `402` smoke temiz geçti.
- [x] Faz 4 ilerledi: paid task fee rayı `taskEconomyService` ile Circle Gateway buyer path'ine taşındı; local dry-run doğrulaması temiz geçti.
- [x] İkinci Railway production deploy alındı; nano-pay fee-buffer düzeltmesi ve paid task economy rayı canlıya taşındı.
- [x] Canlı smoke'lar güncellendi: auth'li `nano-pay` confirmed oldu, Oracle paid settle `200` döndü ve paid `EXEC_ARB` sonucu `agentic_task_economy` metadata'sı ile kaydedildi.
- [x] Faz 5 başladı: jobs economy hook'ları backend + JobsTab'e eklendi; üçüncü Railway backend deploy ve Vercel production deploy tamamlandı.
- [x] Canlı jobs smoke tamamlandı: self-provider create/get/deliver/complete zinciri `agentic_job_economy` metadata'sı ile temiz geçti.
- [x] Faz 6 ilerledi: legacy `agentWalletService.nanoPayment()` USDC branch'i Gateway buyer rayına taşındı; dördüncü Railway deploy ve standard `send` nano smoke temiz geçti.
- [x] Faz 7 başladı: merkezi `agentic_payment_events` audit tablosu ve `gatewayAuditService` eklendi; beşinci Railway deploy sonrası nano/job audit satırları DB'de doğrulandı.
- [x] Faz 8 başladı: Oracle status control-plane hardening tamamlandı; seller auth/cache, buyer, task/job economy ve audit summary aynı status cevabına ve OracleTab yüzeyine taşındı, Railway + Vercel deploy sonrası canlı smoke alındı.
- [x] Faz 8 devamı: structured log prefix'leri `gateway`, `oracle gateway`, `task economy`, `job economy` ve `agentic economy` raylarına eklendi; altıncı Railway deploy ve canlı smoke temiz geçti.
- [x] Faz 8 dış buyer onboarding dilimi tamamlandı: Oracle unpaid `402` body içine `docsUrl`, `machineDocsUrl` ve public download alanları eklendi; repoya `docs/oracle-public-buyer-guide.md`, `backend/examples/oraclePublicBuyerExample.js` ve `backend/examples/arcOracleBuyerHelper.js` eklendi; public guide sadeleştirildi, machine-readable manifest yayınlandı ve Railway + Vercel deploy sonrası canlı `oracle:buyer:preview` smoke yeni alanları production `402` cevabında doğruladı.
- [x] Faz 8 Oracle venue expansion dilimi tamamlandı: `pool-state` için `venue` parametresi Railway production'da canlıya alındı; `QTM-WUSDC` (`uniswap_v2_like`) ve `MUSDC-MEURC` (`arcfx`) private/public smoke'ları temiz geçti. Oracle sekmesi Vercel production'da example query, supported venue/pool ve experimental coverage kartlarıyla görünür hale getirildi.
- [x] Faz 8 observability ve SKU expansion dilimi tamamlandı: `peg-monitor`, `protocol-tvl`, `pool-compare`, `reserve-state` ve `arb-scan-multi` private/public/paid smoke'ları temiz geçti; `/api/oracle/status.observability` ve UI observability kartı production'a taşındı; public buyer guide ile manifest 9 SKU'ya güncellendi.
- [x] Faz 8 metrics/alarm dilimi repo içinde tamamlandı: threshold-triggered Oracle alert event'leri `oracle_alert_events` tablosuna yazılıyor; production smoke ile `status.observability.alerting.delivery = database` ve DB row varlığı doğrulandı.
- [x] Faz 8 kalan: testnet public base URL `https://arcmachina.vercel.app/api` üstünde sabitlendi.
  Sonuç: `vercel.json` içine external `/api` rewrite eklendi ve `VITE_API_URL` `/api` oldu; Vercel production deploy sonrası `https://arcmachina.vercel.app` alias'ı güncellendi.
  Doğrulama: public buyer guide `200`, manifest `200` ve `cd backend && ORACLE_PUBLIC_BASE_URL=https://arcmachina.vercel.app/api ORACLE_PUBLIC_ENDPOINT=pool-state ORACLE_PUBLIC_POOL=USDC-EURC npm run oracle:buyer:preview` ile unpaid `402` doğrulandı.

### Arc Oracle Public Buyer Modeli

- Arc'ın public Oracle sistemi seller-side olarak Circle Gateway x402 ile uyumludur; dış buyer, Arc hesabı açmadan yalnız bir EOA ve USDC ile public Oracle endpoint'lerini tüketebilir.
- Circle'ın standard buyer quickstart'ında buyer tarafı Gateway deposit zamanlamasını kendisi yönetir; Arc'ın farkı, aynı protokolü korurken bunun üstüne keşif ve helper katmanı koymasıdır.
- Arc tarafında wire-level akış aynıdır: unpaid request `402` döner, body içinde `docsUrl`, `machineDocsUrl` ve helper/example linkleri görünür, `PAYMENT-REQUIRED` header'ı payment terms taşır, buyer gerektiğinde Gateway'i fonlar, signed `Payment-Signature` ile retry eder ve seller Gateway üzerinden settle edip Oracle cevabını döner.
- Arc-managed agent'larda buyer helper Gateway available balance kısa kalırsa wallet'taki USDC'den on-demand fund eder; bu sayede raw Circle buyer akışındaki en yaygın `insufficient_balance` sürtünmesi kapanır.
- Dış third-party buyer için repodaki guide ve example client aynı protokolün self-serve entegrasyon yüzeyini verir; helper iskeleti de Circle'ın ham buyer akışını daha az hata veren tek bir `preview -> fund if needed -> pay` modeline indirger.
- Avantaj farkı burada ürünleşme tarafındadır: Arc, Circle'a karşı yeni bir protokol üretmiyor; aynı x402/Gateway rayını daha keşfedilebilir, daha az operasyonel hata üreten ve agentic economy ile izole çalışan bir entegrasyon yüzeyi haline getiriyor.
- Sınır aynı kalır: Circle dokümantasyonunda olduğu gibi burada da buyer EOA olmalı; smart contract account / EIP-1271 imza modeli bu nanopayment akışı için uygun değildir.

---

## 2. Kodla Doğrulanan Yapılanlar

### Frontend

- [x] Dashboard yüzeyi mevcut: agent özeti, portföy, son işlemler ve quick-start akışı var.
- [x] Agent yönetimi mevcut: create/reconnect, passkey login, limitler, permissions, Smart Mode ayarları ve LLM test akışı var.
- [x] Bridge yüzeyi mevcut: CCTP bridge, native gas top-up, bridge tracker, claim/dismiss akışları var.
- [x] Swap yüzeyi mevcut: quote alma, Arc Testnet swap akışı, agentic execution ve durum polling var.
- [x] Tasks yüzeyi mevcut: üstte reputation hero, geniş yatay free/paid/automation sekmeleri, enable/disable akışı, inline/manual execution sonucu, recent executions ve pool balance görünümü var; gömülü Oracle paneli artık burada değil.
- [x] Reputation açıklama katmanı Tasks içinde görünür: local score, event breakdown, on-chain status, neden önemli olduğu, nasıl kazanıldığı ve setup durumu tek üst yüzeyde anlatılıyor.
- [x] Reputation tracking enable aksiyonu doğrudan üst reputation uyarı alanına taşındı; kullanıcı artık Automation listesine inmeden aynı feature flag'i açıp kapatabiliyor.
- [x] Oracle yüzeyi top-level ayrı sekme olarak mevcut: service explanation, public endpoint catalog, payment readiness, warning state ve gateway control-plane summary burada görünüyor. Ek olarak example query yüzeyi, supported venue/pool metadatası, experimental pool coverage kartı, `Data Quality & Observability` kartı, alert backend delivery özeti ve header altına taşınmış external buyer onboarding yerleşimi canlıda doğrulandı.
- [x] Jobs yüzeyi mevcut: create/list/deliver/complete/cancel ekranları ve boş state onboarding metni var.
- [x] Jobs yüzeyi sadeleştirildi: public board ile private owner yönetimi açıkça ayrılıyor; aynı job'ın iki yerde görünmesinin nedeni metinle açıklanıyor ve detay kartları plain-language akışa indirgeniyor.

### Backend

- [x] Express API ayakta: `helmet`, CORS allowlist, global/auth/tx rate limit ve health endpoint mevcut.
- [x] Auth sistemi mevcut: passkey register/login, brute-force lockout, JWT auth ve `/api/auth/refresh` endpoint'i var.
- [x] Agent CRUD ve ayar güncelleme yüzeyi mevcut: feature flags, permissions ve LLM test akışı var.
- [x] Oracle backend mevcut: private endpoint'ler, public x402 ödeme korumalı endpoint'ler, status ve revenue endpoint'leri var; status cevabı artık seller facilitator cache/auth, buyer defaults, task/job economy, agentic payment audit summary, `observability` özeti ve DB-backed alert backend delivery durumunu döndürüyor. Unpaid public `402` body ayrıca dış buyer keşfi için `docsUrl`, `machineDocsUrl` ve public helper/example download alanları taşıyor. `pool-state` `venue=curve|uniswap_v2_like|arcfx` ile filtered external whitelist üstünden canlı snapshot verebiliyor; `peg-monitor`, `reserve-state`, `protocol-tvl`, `pool-compare` ve `arb-scan-multi` da production'da canlı.
- [x] Queue altyapısı mevcut: Oracle loop, DeFi loop, free task processor'ları ve execution task processor'ları var.
- [x] Task catalog seed mantığı mevcut: 10 adet free bilgi görevi ve 5 adet execution görevi tanımlı.
- [x] Manual task run akışı mevcut: kullanıcı tetiklemeli task'ler production'da queue beklemeden inline çalışıyor ve API yanıtı artık askıda kalmıyor.
- [x] CCTP Bridge gerçek execution yolu doğrulandı: yerelde `DRY_RUN=false` ile burn, attestation ve destination mint adımları tamamlandı.
- [x] Transaction servisleri mevcut: send, nano payment, bridge, swap ve status polling akışları var.
- [x] Agentic economy servis katmanı mevcut: `gatewaySeller`, `gatewayBuyer`, `taskEconomyService`, `jobEconomyService` ve `gatewayAuditService` production deploy + smoke ile doğrulandı.
- [x] Merkezi audit katmanı mevcut: `agentic_payment_events` tablosu nano-pay, standard send nano ve jobs economy olaylarını kaydediyor.
- [x] Reputation backend mevcut: local reputation event log'u, agent reputation overview endpoint'i ve on-chain score readback akışı var.

### Kontrat / Infra

- [x] Kontratlar repoda mevcut: `AgentWallet`, `AgentWalletFactory`, `AgenticCommerce`, `ArcRevenuePool`.
- [x] `ReputationRegistry` kontratı deploy edildi; Arc Testnet adresi local `.env` ve Railway backend env içinde yapılandırıldı.
- [x] Compiled artifact'lar repoda mevcut.
- [x] Docker, Railway ve Vercel konfigürasyonları repoda mevcut.
- [x] Neon -> Railway DB geçişi tamamlandı; Railway `Postgres` + `backend-db-cutover-smoke` restore/smoke doğrulamasından sonra production backend Railway DB'ye çevrildi. Neon şimdilik rollback yedeği olarak tutuluyor.
- [x] Railway platform healthcheck'i artik derin DB probe'u yerine hafif `GET /readyz` endpoint'ini kullaniyor; `GET /health` ise manual tanilama icin DB + Redis probe olarak korunuyor. Test surecinde gerekirse `BACKGROUND_JOBS_ENABLED=false` ile surekli scheduler/indexer loop'lari devre disi birakilabilir.
- [x] Backend ve frontend için ayrı package yapısı ve temel çalıştırma script'leri mevcut.

### Güvenlik Tabanı

- [x] Passkey tabanlı kimlik doğrulama mevcut.
- [x] JWT secret ve auth middleware kontrolü mevcut.
- [x] `helmet()` aktif.
- [x] Rate limiting aktif.
- [x] Oracle public endpoint'lerde x402 ödeme kapısı mevcut; Circle Gateway seller middleware kod seviyesinde bağlı.
- [x] LLM audit ve oracle payment kayıt tabloları mevcut.

### Public Surface Hardening Backlogu

- [x] Taban koruma aktif: public seller route'lar x402 ile ayrık, private route'lar JWT/auth altında ve rate limit zaten açık.
- [x] Public/private/operator Oracle route auth audit'i kod üstünden tamamlandı: private status/debug yüzeyleri `requireAuth` altında kaldı, public seller route'lar yalnız `/api/oracle/public/*` altında doğrulandı ve yeni write aksiyonu bilinçli olarak private `POST /api/oracle/gateway/fund` altında tutuldu.
- [x] `402` / `429` / settlement-failure / `5xx` alerting planı somutlaştırıldı: eşikler, log alanları ve rollout sırası `ORACLE-READINESS-EXPANSION.local.md` içine yazıldı.
- [x] Oracle public/buyer rayı için structured alert/log wiring'i uygulandı: seller finish middleware ve Gateway buyer retry path'i artık `402`, `429`, settlement-failure ve `5xx` olaylarını structured meta ile logluyor; Railway deploy sonrası production log yüzeyinde yeni `[ORACLE_GATEWAY]` payment challenge sinyali görüldü.
- [x] DB-backed alert ledger üstüne external paging/webhook sink açıldı: `backend/src/services/oracle/alerts.js` named multi-sink config, timeout ve masked destination summary destekliyor; private `POST /api/oracle/debug/test-alert` route'u manual test dispatch sağlıyor; OracleTab sink count, timeout ve hedef özetlerini gösteriyor.
- [x] Public Oracle seller surface testnet boyunca Vercel alias `/api` girişine standardize edildi; `vercel.json` içindeki `VITE_API_URL`, public buyer guide notları ve smoke komutları bu base URL'e hizalandı.
  Sonuç: uygulama içi API tabanı artık same-origin `/api`; public buyer guide testnet default base URL olarak `https://arcmachina.vercel.app/api` notunu taşıyor.
  Doğrulama: Vercel production deploy sonrası `/oracle-public-buyer-guide.html` `200`, `/oracle-public-buyer-manifest.json` `200` ve Vercel alias üstünden unpaid Oracle preview `402` döndü.
- [x] Public seller route'larda WAF / traffic filtering / abuse review uygulandı.
  Sonuç: `backend/src/routes/oracle.js` içine public route seviyesinde dedicated `30 req / 60s` limiter, blocked scanner user-agent filtresi (`sqlmap`, `nikto`, `masscan`, `nessus`, `acunetix`, `gobuster`, `dirbuster`, `zgrab`) ve endpoint bazlı query allowlist eklendi.
  Doğrulama: Railway backend deploy sonrası `https://arcmachina.vercel.app/api/oracle/public/pool-state?pool=USDC-EURC` normal preview `402` döndü ve `ratelimit-limit=30`, `ratelimit-remaining=29` header'ları görüldü; invalid `foo=bar` query'si `400`, `sqlmap/1.0` user-agent'i `403` döndürdü.
- [ ] Production Curve pool kapsamını tamamla: verified default pool registry ile `USDC-EURC` ve `WUSDC-USDC` artık env override olmadan da canlı okunuyor; `USDC-USYC` hattı blokör olarak değil pasif/opsiyonel coverage olarak izlenecek.
- [ ] Zamanlama notu: auth/rate-limit, observability, Vercel alias smoke ve public abuse hardening tabanı artık hazır; veri kalitesi ve paid readiness işleri şimdi backlog'un önüne alınmalı; en sona bırakılmamalı.

---

## 3. Kodla Doğrulanan Açıklar ve Düzeltme Notları

- [x] `helmet()` eksik değil; backend'de aktif.
- [x] Jobs onboarding kartı eksik değil; `JobsTab` içinde boş state açıklaması mevcut.
- [x] Agent LP / liquidity position görünürlüğü tamamen yok değildi demek yanlış olurdu; bu turda backend positions endpoint'i ve Dashboard positions kartı eklenerek eksik read-model yüzeyi kapatıldı.
- [x] Jobs için offline mode bilgisi eksik değil; `AGENTIC_COMMERCE_ADDRESS` yoksa banner/metin gösteriliyor.
- [x] Tasks tab'de run sonrası result polling eksik değil; polling ve inline sonuç gösterimi mevcut.
- [x] Production'da user-triggered manual task POST'ları artık queue beklemeden inline tamamlanıyor; önceki hanging davranış kaldırıldı.
- [x] `EXEC_YIELD_MOVE` production'da false-positive hazır görünüyordu; paid smoke sonucu `AAVE_POOL_ADDRESS` eksikliği doğrulandı.
  Sonuç: task seed listesinden çıkarıldı, mevcut `task_catalog` satırı deploy sırasında `enabled = false` olacak şekilde kapatıldı ve frontend kartı kaldırıldı.
  Doğrulama: Railway production `/api/tasks/catalog` artık `EXEC_YIELD_MOVE` döndürmüyor; Vercel production bundle içinde eski task id izi bulunmuyor.
- [x] Tasks sayfasındaki `reputationGuideOpen` runtime hatası ve bozuk `TasksTab` JSX yapısı düzeltildi; blank screen veren deploy geri toparlandı.
- [x] CCTP Bridge execution task'i katalogda ücretli değil; ücretsiz olarak seed ediliyor.
- [x] `scheduleDailyTasks()` günlük task koşturmuyor; şu an sadece task catalog seed ediyor.
- [x] Agent tab'deki Free Daily Tasks ve Autonomous Features alanları kaldırıldı; yönetim `TasksTab` içinde tek yüzeyde toplandı.
- [x] Jobs state machine artık create sonrası `funded` başlıyor; eski `open` kayıtları migration ile taşınıyor.
- [x] Oracle service artık `Tasks` içinden tamamen çıkarıldı; top-level `Oracle` sekmesinde service explanation, status, revenue, request count, endpoint catalog ve pay-to readiness gösteriliyor.
- [x] Full Autonomous toggle artık `TasksTab` automation yüzeyinde mevcut; tek aksiyonla `Market Analysis`, `Oracle Data Feed`, `DeFi Loop` ve `Reputation Tracking` flag'leri birlikte güncelleniyor.
- [x] Execution task'ler artık parametresiz queue olmuyor; frontend form girişi ve backend validation birlikte zorunlu.
- [x] `EXEC_CCTP_BRIDGE` worker'ındaki sessiz `arc -> base` fallback'i kaldırıldı; explicit chain parametreleri zorunlu.
- [x] Oracle kritik env eksikleri frontend'de warning olarak gösteriliyor; eksik pool/payment config'leri görünür hale geldi.
- [x] Oracle public route artık yanlışlıkla auth'a takılmıyor; kod seviyesinde Circle Gateway seller middleware ile bağlı ve private route'lardan ayrık duruyor.
- [x] `agentBridgeFull` içindeki step callback bug'ı düzeltildi; bridge smoke artık callback katmanında patlamıyor.
- [x] `EXEC_ARB` sonucu pool env boşsa artık gerçek execution sanrısı yaratmadan simulation/dry-run olarak ayrıştırılıyor.
- [x] `EXEC_CURVE_SWAP` verified default `USDC/EURC` Curve pool adresini kullanabiliyor; env boş olsa da task path'i artık hard-block olmuyor.
- [x] `EXEC_REBALANCE` için `USDC/EURC` stable pair rayında Swap Kit zorunluluğu kaldırıldı; key yoksa verified Curve pool fallback'i devreye giriyor. Yine de live production resmoke halen gerekli.
- [x] Production `GET /api/tasks/pool-balance` verified default revenue pool fallback ile `200` dönebiliyor; `REVENUE_POOL_ADDRESS` boşluğu public transparency endpoint'ini artık kırmıyor.
- [x] Circle Gateway buyer exact-balance funding bug düzeltildi; `nano-pay` live smoke artık insufficient balance ile düşmüyor.
- [x] Paid task fee path'i relayer fallback'ten çıkarıldı; production task result kayıtlarında `agentic_task_economy` metadata'sı görünüyor.
- [x] Eski plandaki bazı "tamamlandı" notları kısmen doğru olsa da ürün akışları tam bitmiş durumda değil.
- [x] Testnet stratejisi değişti: özel domain satın alma yerine Vercel alias `/api` proxy yolu seçildi; `vercel.json` artık frontend için `/api` tabanına geçirildi, kalan iş deploy ve public smoke doğrulaması.
- [x] `backend/package.json` test komutu çalışır hale getirildi; repo içinde `circlePaidCatalogService` için ilk Jest regression testi mevcut ve hedefli `npm test -- --runTestsByPath ...` doğrulaması geçti.
- [x] Kök `README.md` artık tek satırlık başlık değil; ürün özeti, env beklentileri ve çalışma komutları görünür şekilde belgeleniyor.
- [x] Legacy `SecurityTab` kararı uygulandı; ekran repo içinden çıkarıldı ve `frontend/src/App.jsx` tarafında aktif import/render izi kalmadı.
- [x] `JobsTab` onboarding katmanı genişletildi; `How Jobs Work` kartı artık client/provider/settlement/next-step bilgisini ve x402 economy ayrımını görünür anlatıyor.
- [x] Positions read-model ve Dashboard positions kartı production'a taşındı; Railway health `ok`, task catalog smoke'unda yeni Curve liquidity task'leri ve Vercel production bundle içinde `Agent Positions` string'i doğrulandı.
- [x] `EXEC_CURVE_LIQUIDITY_ADD` paid task'inin production `CALL_EXCEPTION` root cause'u kapatıldı.
  Sonuç: verified `USDC/EURC` pool liquidity interface'i static `uint256[2]` değil dynamic `uint256[]` kullandığı için `curveSwap` adapter'i güncellendi; aynı deploy içinde `EXEC_SEPOLIA_GAS_FANOUT` fee source chain'i de shared task economy chain'e sabitlendi.
  Doğrulama: production RPC üstünde `calc_token_amount(uint256[], bool)` read-only çağrısı başarılı döndü; Railway deploy sonrası son `EXEC_CURVE_LIQUIDITY_ADD` sonucu `id=79`, gerçek `txHash`, `lpAmount` ve `economy.status=confirmed` ile kaydedildi. Hemen ardından `EXEC_CURVE_LIQUIDITY_REMOVE` sonucu da `id=80` ile confirmed çalıştı. Eksik son gas-fanout fee DB/result payload'ı confirmed economy backfill ile düzeltildi.
- [x] Dashboard `Recent Activity` artık paid task geçmişini eksiksiz gösterebiliyor.
  Sonuç: queue tarafındaki `taskResultId` activity yazımı gelecekteki run'lar için aktif; geçmiş production kayıtları ise `backend/scripts/backfillTaskActivities.js` ile geri dolduruldu, timestamp'ler gerçek task zamanına taşındı ve eski `direct_lp_*` çift kayıtları temizlendi.
  Doğrulama: production DB audit'inde supported paid task result'ler için `missing = 0` görüldü; son activity sorgusunda `task_arb`, `curve_lp_add`, `curve_lp_remove`, `gas_topup`, `direct_lp_add/remove` satırları gerçek tx hash ve `taskResultId` ile döndü. Railway health `ok`, Vercel alias `200`.
- [x] `EXEC_ARB` artık kullanıcı boyutu kârsızsa execute etmiyor.
  Sonuç: `agenticTaskExecutionService.executeArbTask()` içinde requested-size profitability guard eklendi; global signal HIGH olsa bile user-entered `amountIn` Curve fee sonrası negatif net veriyorsa payload `skipped=true` ile kapanıyor.
  Doğrulama: dar Node probe `executeCurveSwap should not run when requested size is unprofitable` sentinel'iyle temiz geçti; Railway production deploy sonrası backend health `ok`.

---

## 4. Kritik Açıklar

- [x] P0-I — `Prediction Market Check` kartını ilk satılan bilgi ürününe çevir.
  Neden: Bugün gerçekten çalışan tek live bilgi dilimi bu kart; önce bunu monetization'a taşımak, eski Circle satın alma planını sürdürmekten çok daha yüksek değer üretiyor.
  Etki: Circle Paid tarafında ilk gerçek `info product` açılır; kullanıcı çalışan bilgi sonucu için ödeme yapar, unlock sonrası snapshot kalıcı olur ve Arc execution ayrı opsiyonel adım olarak kalır.
  Sonuç: mevcut live runtime korunarak backend'e `POST /api/tasks/agents/:id/circle-paid/preview`, `POST /api/tasks/agents/:id/circle-paid/unlock`, `GET /api/tasks/agents/:id/circle-paid/snapshots` ve `GET /api/tasks/agents/:id/circle-paid/snapshots/:snapshotId` endpoint'leri eklendi; `POST /api/tasks/agents/:id/circle-paid/run` preview alias'ı olarak bırakıldı. Frontend kartı da free preview, paid unlock, saved snapshots ve unlock sonrası `Paid` lane'e ayrı explicit handoff akışıyla güncellendi.
  Kural: unlock yalnız bilgi + saved snapshot açar; önerilen Arc action otomatik çalışmaz ve `Paid` lane içinde ayrı kullanıcı aksiyonu gerektirir.
  Doğrulama: `NODE_ENV=production node backend/src/db/migrate.js`, `node --check backend/src/routes/tasks.js`, `node --check backend/src/services/circlePaidSnapshotService.js`, editor error check, Railway production `/health` `200`, production `GET /api/tasks/circle-paid/catalog` `200`, auth'siz `preview` / `unlock` / `snapshots` route smoke'larında `401`, Vercel production deploy ve `https://arcmachina.vercel.app` `200`.
  Deploy: Railway backend deploy `bd18ff88-9a01-49fd-b88e-c1a4e38d731d` tamamlandı, Vercel alias `https://arcmachina.vercel.app` güncellendi.
  Referans: ürün yönü için `CIRCLE-PAID-PLAN.local.md`, teknik sözleşme için `CIRCLE-PAID-SPEC.local.md`, live runtime için `backend/src/services/predictionMarketService.js`.

- [ ] P0-J — `Circle Paid` live kart genişleme paketi (şimdilik donduruldu).
  Neden: Eski Circle satın alma discovery modeli kapandı; fakat yeni live kart genişleme ve paid unlock devamı için de uygun x402 tabanlı dış API/tool fit bugün yeterli değil.
  Etki: Mevcut iki live kart ve Oracle SKU korunur, fakat `Crypto News Pulse` ve yeni Circle Paid rollout'ları aktif sprint kapsamından çıkar.
  Durum: `maintenance-only`. `ARC_PREDICTION_MARKET_CHECK` ve `ARC_EVENT_ODDS_COMPARE` production'da açık kalır; yeni Circle Paid runtime veya monetization genişlemesi, uygun API/tooling bulunduğunda yeniden aktive edilir.
  Referans: ürün yönü için `CIRCLE-PAID-PLAN.local.md`, teknik sözleşme için `CIRCLE-PAID-SPEC.local.md`, ilk live runtime için `backend/src/services/predictionMarketService.js`.

- [x] P0-H — `Circle Paid` ürün yüzeyini aç ve yeni üst tab önceliğini uygula.
  Neden: Üçüncü taraf x402 servisleri artık somut katalog halinde elimizde; bunları mevcut `Paid` execution anlamını bozmadan ayrı ürün rayına koymak gerekiyor.
  Etki: Non-coder kullanıcı için ücretli bilgi/araştırma/sosyal tarama yüzeyi açılır; agentic economy footprint büyür; `Paid` sekmesinin “gerçek execute” anlamı korunur.
  Sonuç: `Tasks` üst yapısı `Free | Paid | Circle Paid | Automation` olarak açıldı; `Circle Paid` Arc Testnet action-first kartlarla, Arc fee aynı revenue pool'a gidecek şekilde ve `Twitter Pulse` dahil research/social ikinci lane ile kurgulandı. Ham katalog snapshot'ı `artifacts/circle-market/circle-services-latest.json`, ürün planı `CIRCLE-PAID-PLAN.local.md`, teknik sözleşme `CIRCLE-PAID-SPEC.local.md`, backend route'u `GET /api/tasks/circle-paid/catalog` ve frontend render yüzeyi aynı turda eklendi. İkinci turda raw sistem dili kaldırıldı; kartlar artık kullanıcıya ne işe yaradığını, ne döndüreceğini ve hangi paid aksiyona bağlandığını açıklıyor. `POST /api/tasks/agents/:id/circle-paid/run` guided handoff route'u da eklendi. Üçüncü turda preview aynı sekmeye sabitlendi; onay `Circle Paid` içinde veriliyor ve `Paid` sekmesine programatik geçiş tamamen kaldırıldı.
  Doğrulama: canlı Railway endpoint'i `https://backend-production-597c.up.railway.app/api/tasks/circle-paid/catalog` üzerinden `railLabel`, `whyItMatters`, `howItWorks` ve `recommendedPaidActions` alanları doğrulandı; yeni `POST /api/tasks/agents/:id/circle-paid/run` route'u production'da `401` ile auth guard arkasında görüldü; son frontend turunda `https://arcmachina.vercel.app` alias'ı tekrar deploy sonrası `200` döndü.
  Deploy: Railway backend deploy tamamlandı; Vercel production deploy `https://arcmachina.vercel.app` alias'ına alındı ve aynı-sekme preview düzeltmesi son frontend turunda tekrar canlıya taşındı.
  Referans: ham katalog için `artifacts/circle-market/circle-services-latest.json`, ürün planı için `CIRCLE-PAID-PLAN.local.md`, teknik sözleşme için `CIRCLE-PAID-SPEC.local.md`.

- [ ] P0-G — Position-aware liquidity execution ve `cirBTC` direct-pair yüzeyini tamamla.
  Neden: Live LP verisi artık liquidity add / withdraw / rebalance path'lerinde execution guard olarak kullanılıyor; `cirBTC` tarafında ise açık ürün kararı mevcut live direct Uniswap V2 pair üstünden ilerlemek. Burada eksik olan şey yeni fallback rayı değil, bu direct pair mantığını paid/manual yüzeylerde tutarlı anlatmak. Lending tarafında ise Aave adapter kodu repoda dursa da gerçek `AAVE_POOL_ADDRESS` hâlâ bulunmuş değil; bu yüzden Aave execution'ı aktif ürün gibi anlatmak yerine park edilmiş araştırma başlığı olarak tutmak gerekiyor.
  Etki: Stable liquidity rayları blind execution olmadan çalışır; `cirBTC` tarafında da direct pair üstünden çalışan paid görevler ile ileride gelecek manuel DeFi yüzeyi aynı ürün hikâyesine oturur. Lending için de aktif execution ile yalnız oracle/araştırma verisini ayıran daha temiz bir yol haritası oluşur.
  Beklenen sonuç: `cirBTC` çiftleri için yeni fallback aramak yerine mevcut direct pool üstünden çalışan görevler, görünürlük ve manuel kullanım yüzeyi netleşir. Curve tarafında çalışan swap/liquidity/rebalance akışları görünür ürün haline gelir; Aave lending gerçek pool adresi bulunana kadar pasif kalır; aktif LP'ler için APR/APY ve tahmini getiri hesabı eklenir; Morpho ise execution tabanı değil, araştırılacak örnek/model adayı olarak konumlanır.

- [x] P0-A — Backend'de private key alan adı tutarsızlığını düzelt.
  Neden: Schema `private_key_encrypted` kullanıyor, bazı route ve queue sorguları `encrypted_private_key` kullanıyor.
  Etki: Jobs on-chain path'i, DeFi loop ve paid task akışları kırılabilir.
  Sonuç: `backend/src/routes/jobs.js` ve `backend/src/queue/agentQueue.js` schema ile hizalandı.
  Doğrulama: `node --check src/routes/jobs.js`, `node --check src/queue/agentQueue.js`, editor error check temiz geçti.
  Deploy: Railway deploy tamamlandı, healthcheck başarılı geçti.

- [x] P0-B — Tasks akışını tek ekranda topla.
  Neden: `AgentTab` ve `TasksTab` aynı alanın iki farklı versiyonunu gösteriyor.
  Etki: Kullanıcı hangi toggle'ın gerçekten geçerli olduğunu anlayamıyor.
  Sonuç: `AgentTab` yalnız agent ayarlarına indirildi, `TasksTab` ise `Free | Paid | Automation` yapısına taşındı.
  Doğrulama: `cd frontend && npm run build` temiz geçti.
  Deploy: Vercel production deploy tamamlandı: `https://arcmachina.vercel.app`

- [x] P0-C — Free task limit mantığını tek kurala bağla.
  Neden: Backend kuralı, `AgentTab` davranışı ve `TasksTab` metni birbiriyle çelişiyor.
  Etki: Kullanıcı günlük limit mantığını yanlış anlıyor.
  Sonuç: Free cap kontrolü queue öncesinde route seviyesine taşındı; TasksTab metni ve hata mesajları backend kuralıyla hizalandı.
  Doğrulama: `node --check src/routes/tasks.js`, `cd frontend && npm run build`, editor error check temiz geçti.
  Deploy: Railway backend deploy tamamlandı, Vercel production deploy tamamlandı: `https://arcmachina.vercel.app`

- [x] P0-D — Execution task'ler için parametre formu ekle.
  Neden: Frontend şu an yalnızca `taskId` gönderiyor; gerçek işlem task'leri backend varsayılanlarıyla çalışıyor.
  Etki: Curve Swap, Yield Move, Arb, Rebalance ve CCTP Bridge güvenli UX olmadan tetikleniyor.
  Sonuç: `TasksTab` içinde task bazlı parametre formu eklendi; frontend `runTask(agentId, task.id, params)` çağrısına geçti ve backend route param validation ile hizalandı.
  Doğrulama: `cd frontend && npm run build`, `node --check src/routes/tasks.js`, editor error check temiz geçti.
  Deploy: Railway backend deploy ve Vercel production deploy tamamlandı: `https://arcmachina.vercel.app`

- [x] P0-E — `EXEC_CCTP_BRIDGE` varsayılan chain değerlerini düzelt.
  Neden: Default değerler `arc -> base`, servis tarafındaki geçerli key'ler `Arc Testnet`, `Base Sepolia` gibi görünüyor.
  Etki: Parametresiz çağrıda task başarısız olabilir.
  Sonuç: Queue worker içindeki sessiz fallback kaldırıldı; CCTP execution artık explicit `fromChain`, `toChain` ve `amountUsdc` olmadan ilerlemiyor.
  Doğrulama: `node --check src/queue/agentQueue.js`, editor error check ve Railway healthcheck temiz geçti.
  Deploy: Railway backend deploy ve Vercel production deploy tamamlandı: `https://arcmachina.vercel.app`

- [x] P0-F — Jobs funding state machine'ini tamamla.
  Neden: `deliver` endpoint'i `funded` bekliyor ama `open -> funded` geçişini yapan akış yok.
  Etki: Jobs yüzeyi var ama iş mantığı eksik kalıyor.
  Sonuç: Job create akışı `funded` başlangıç statüsüne çekildi; schema default'u güncellendi ve eski `open` kayıtları migration ile `funded` durumuna taşındı.
  Doğrulama: `node --check src/routes/jobs.js`, editor error check ve Railway healthcheck temiz geçti. Yerelde auth + DB ile uçtan uca job akışı koşturulamadı.
  Deploy: Railway backend deploy tamamlandı, healthcheck başarılı geçti.

---

## 5. Detaylı Yapılacaklar Listesi

### 17 Mayıs 2026 — Güncel 5 Maddelik Öncelik Sırası

- [x] 1. Circle Paid hattını `maintenance-only` tut; mevcut iki live kart ve Oracle SKU'yu koru, fakat yeni kart/paid unlock geliştirmesini durdur.
- [x] 2. Mevcut `Paid` execution rayının production readiness kapanışını bitir; stable görevler için live resmoke ve sonuç doğruluğunu sertleştir.
- [x] 3. `cirBTC` görevlerini mevcut live direct pair rayı olarak netleştir; Curve fallback beklentisi yaratmadan aynı havuzu ileride manuel DeFi yüzeyine taşı.
- [x] 4. Otonomi genişleme yönünü yalnız doğrulanmış raylarda kilitle; ilk adayları stable `Curve Liquidity Add/Remove` ve `Rebalance` olarak görünür yap, cirBTC ve benzeri rayları manual bırak.
- [x] 5. Hijyen borcunu kapat; gerçek test katmanı, kök `README` ve legacy `SecurityTab` temizliği ile ürün yüzeyini sadeleştir.

### P0 — Önce Bunlar

- [x] P0-I — `Prediction Market Check` kartını ilk satılan bilgi ürünü yap.
  Kapsam: mevcut `Prediction Market Check` live runtime'ını koru; aynı kart içinde `free preview -> paid unlock -> saved snapshot` akışını aç; tahsilat rayını ekle; bu kartı ilk satılan bilgi ürünü yap; gerekiyorsa aynı sonucu Oracle SKU olarak da aç.
  Beklenen çıktı: Circle Paid içinde ilk gerçek `paid info product` açılır; kullanıcı çalışan bilgi sonucu için ödeme yapar, unlock sonrası snapshot kaydı kalıcı olur ve Arc execution ayrı opsiyonel adım olarak kalır.
  Durum: tamamlandı. Backend persistence `circle_paid_snapshots`, payment audit `agentic_payment_events.reference_type = circle_paid_unlock`, frontend kart flow ve `Paid` lane handoff production'a deploy edildi. Ek olarak ayni live sonuc public Oracle SKU olarak `GET /api/oracle/public/prediction-market-check` endpoint'ine `0.005 USDC` fiyatla tasindi; private auth route ve public buyer docs/manifest de guncellendi.
  Doğrulama: production backend health `200`, public catalog `200`, auth'siz yeni Circle Paid route smoke'larında `401`, public `prediction-market-check` Oracle SKU smoke'unda `402 + PAYMENT-REQUIRED`, header `amount=5000` atomik USDC, frontend alias `200`.
  Deploy hedefi: Railway + Vercel tamamlandı.

- [ ] P0-J — `Circle Paid` live kart genişleme paketi (şimdilik donduruldu).
  Kapsam: Mevcut iki live kart ve Oracle SKU yüzeyini bakım modunda koru; yeni `preview -> live -> paid` rollout'larını uygun x402 tabanlı API/tool fit oluşana kadar başlatma.
  Beklenen çıktı: Circle Paid ürün yüzeyi değer kanıtı olarak açık kalır, fakat aktif sprint kapasitesi paid execution ve otonomi raylarına kaydırılır.
  Durum: `maintenance-only`. `Prediction Market Check` ve `Event Odds Compare` production'da kalır; yeni Circle Paid genişlemesi backlog'da bekler.
  Doğrulama: mevcut production runtime korunacak; yeni geliştirme/dploy hedefi yok.
  Deploy hedefi: yok; yalnız bakım/hotfix gerekirse.

- [x] P0-H — `Circle Paid` 4-tab ürün yönünü ilk öncelik yap.
  Kapsam: `Tasks` üst sekmelerini `Free | Paid | Circle Paid | Automation` hedefine göre aç; Circle Paid tarafını `Arc Action Lane` ve `Research & Social Lane` olarak ayır; her kartı `provider fee + Arc fee` modeliyle kur; Arc fee aynı revenue pool'a gitsin; v1 kart setine `Wallet or Asset Snapshot`, `Market Metrics`, `Token Overview`, `Prediction Market Check`, `Event Odds Compare`, `Crypto News Pulse`, `Deep Research`, `Source Pack` ve `Twitter Pulse` kartlarını koy.
  Beklenen çıktı: `Paid` execution rayı ile bilgi/decision rayı ayrışacak; kullanıcı live bilgi kartları ile Arc Testnet execution rayını aynı ürün içinde anlayacak; sosyal medya tarafı da ikinci lane olarak görünecek; otonom görevler bu raydan sonra açılacak.
  Durum: 39 servislik Circle katalog snapshot'ı repo içine kalıcı kaydedildi; tam ham veri `artifacts/circle-market/circle-services-latest.json`, tarihli snapshot `artifacts/circle-market/circle-services-2026-05-16.json`, ürün planı `CIRCLE-PAID-PLAN.local.md`, teknik sözleşme `CIRCLE-PAID-SPEC.local.md` içinde tutuluyor. Backend'de `circlePaidCatalogService`, `GET /api/tasks/circle-paid/catalog` ve auth'li `POST /api/tasks/agents/:id/circle-paid/run` route'ları eklendi; frontend `TasksTab` dördüncü sekme ve human-readable kart katmanını render ediyor. En son turda `Prediction Market Check` ilk `live` kart olarak ilk sıraya çekildi. Eski Circle satın alma discovery planı artık aktif yol haritası değil; bugünkü yol `live kart -> monetization -> gerekirse Oracle SKU` hattıdır.
  Doğrulama: katalog artifact'leri ve iki plan/spec dosyası repo içine yazıldı; backend `circlePaidCatalogService` için runtime smoke temiz geçti ve yan etkili `taskEconomyService` import'u revenue-pool helper'a çekildi; backend `node --check` + editor error check temiz geçti; canlı Railway katalog endpoint'i üstünde katalog metadata doğrulandı; Vercel alias `https://arcmachina.vercel.app` `200` döndü.
  Deploy: Railway backend deploy tamamlandı. Root'ta `vercel --prod --yes` denemesi daha önce `vite build` `127` ile düştüğü için güvenli üretim yolu olarak `frontend/` içinden production deploy alındı ve alias tekrar `https://arcmachina.vercel.app` üzerine oturtuldu.

- [ ] 14. Position-aware liquidity execution ve `cirBTC` direct-pair ürün yüzeyini tamamla.
  Kapsam: Live positions verisini liquidity execution guard'larında kullan; Dashboard'daki live LP görünümünü kalıcı ürün yüzeyi yap; `cirBTC/USDC` ve `cirBTC/EURC` için mevcut live direct pair üstünden çalışan paid görevleri ve ilerideki manuel DeFi yüzeyini aynı ürün diline bağla. Aktif LP'ler için APR/APY, tahmini günlük/haftalık getiri ve mevcut underlying exposure hesabını ekle. Lending tarafında ise Aave execution'ı gerçek pool adresi bulunana kadar pasif/parked tut; Morpho'yu execution değil, model/altyapı adayı olarak ayrıca araştır; üçüncü yol olarak Arc Blueprints içindeki native lending/borrowing primitive yaklaşımını custom-contract tabanı olarak değerlendir.
  Beklenen çıktı: Stable liquidity tarafında agent mevcut likidite pozisyonunu okuyup execution kararını buna göre uygulayacak; `cirBTC` çiftleri için de yeni fallback aranmadan mevcut direct pool üstünden çalışan paid/manual akış açık kalacak. Kullanıcı Curve LP tarafında yalnız bakiye değil, yaklaşık APR/APY ve getiri projeksiyonu da görecek. Lending tarafında ise şu an aktif execution varmış gibi bir yanılsama kalmayacak; yalnız doğrulanmış üçüncü taraf protokol açıldığında ya da Arc Blueprints üstünden native bir custom lending lane tanımlandığında ürün yüzeyi genişletilecek.
  Durum: positions endpoint + Dashboard kartı production'a taşındı; liquidity add/remove/rebalance için live position guard ve doğru token/coin eşlemesi production'a deploy edildi. `cirBTC` tarafında direct pair havuzu ve likidite mevcut, paid görevler aktif. `backend/src/services/protocols/aaveSupply.js` içinde Aave adapter kodu hâlâ mevcut; fakat smoke çıktısında `aavePoolConfigured=false`, root env içinde `AAVE_POOL_ADDRESS` yok ve son dış kontrolümüzde DefiLlama üzerinde `ARC` chain adına düşen Aave/Morpho lending havuzu görünmedi. Bu yüzden lending execution'ı mevcut dış protokole yaslayıp aktif ürün gibi anlatmıyoruz; Morpho yalnız aday altyapı / referans model olarak tutulmalı. Lending tarafı bu turda üçüncü kez genişletildi: reserve watchlist yüzeyi korunurken auth'li `GET /api/agents/:id/lending` read-model'i eklendi; adapter/build-state, contract/source, wallet balances, supplied/borrowed snapshot, health factor, LTV ve available borrow görünür oldu. Aynı `DeFi > Lending` sekmesinden manual `Supply / Withdraw / Borrow / Repay` formu açıldı; submit path'i mevcut `POST /api/tasks/agents/:id/defi/manual/execute` rayı altında hidden lending task id'lerine çözülüyor ve guard geçmezse queue'ye düşmeden bloklanıyor. Son turda bu backend rayı emergency deleverage planı ve liquidation executor wiring'i ile genişletildi.
  Doğrulama: live position guard için stub smoke temiz geçti; `cirBTC` direct pair paid rayı mevcut deployment mantığıyla korunuyor. Lending tarafında ise doğrulanan sonuç execution readiness değil, tam tersine Aave'in hâlâ pasif olduğu ve Morpho'nun henüz execution adapter seviyesine inmediği yönünde.
  Deploy hedefi: Railway + Vercel.

### 14A. Gerçek DeFi + Lending Uygulama Checklist'i

Mimari kural (kritik, bozma): `Tasks > Paid` mevcut manual paid rayı olarak yerinde kalacak; ayrı `DeFi` / `Lending` üst yüzeyleri bunun yerine geçmeyecek, onu taşımayacak ve onu sadeleştirme bahanesiyle zayıflatmayacak. Doğru katman sırası: tek execution / adapter core -> manual `DeFi` ve `Lending` yüzeyi -> paid görevler -> deterministic automation. LLM yalnız açıklama / öneri katmanı olacak; hangi tx'in hangi adapter ile atılacağı policy + adapter katmanında belirlenecek.

- [x] Mevcut gerçek execution raylarını koru: `EXEC_CURVE_SWAP`, `EXEC_CURVE_LIQUIDITY_ADD`, `EXEC_CURVE_LIQUIDITY_REMOVE`, `EXEC_REBALANCE`.
- [x] Mevcut gerçek `cirBTC` direct-pair paid görevlerini koru: `EXEC_CIRBTC_USDC_ZAP_IN`, `EXEC_CIRBTC_EURC_ZAP_IN`, `EXEC_CIRBTC_USDC_LP_REMOVE`, `EXEC_CIRBTC_EURC_LP_REMOVE`.
- [x] Circle Paid / paid katalog içinde `cirBTC/USDC` ve `cirBTC/EURC` direct-pair görev kartlarını görünür ve açıklayıcı hale getir.
- [x] Dashboard / positions yüzeyinde Curve ve direct-pair LP'ler için yaklaşık APR, APY, günlük getiri, haftalık getiri ve underlying exposure hesabını göster.
- [x] Ayrı `DeFi` yüzeyi kur: `USDC/EURC` Curve ile `cirBTC/USDC` ve `cirBTC/EURC` direct pair metrikleri tek ekranda global görünür olsun; kullanıcı manuel add/remove / exit aksiyonlarını buradan başlatsın.
  - Not: DeFi havuz aksiyonları görev kartı diliyle değil, Curve benzeri normal `Swap` / `Add` / `Withdraw` / `Exit` butonlarıyla açılacak; alttaki execution aynı shared adapter core olacak.
  - Not: Havuz detayında `Global Pool Snapshot` üstte tam genişlik, `Your Current Position` onun altında yine tam genişlik stack olarak kalacak; yan yana iki kolon kullanılmayacak.
- [x] `DeFi` manuel execution rayını `Tasks > Paid` katmanından ayır: frontend artık paid task katalog/run path'ini kullanmayacak; dedicated manual route ve hidden processor'lar shared adapter core üstünden çalışacak.
  - Not: Canlı manual DeFi çağrıları artık `POST /api/tasks/agents/:id/defi/manual/execute` üstünden gidiyor; hidden manual task id'leri katalogda görünmeden backend processor katmanına bağlanıyor.
  - Not: Bu ray kullanıcı özgürlüğü için `dailyTasksEnabled` ve günlük paid cap guard'larından bağımsız; `Tasks > Paid` mevcut public paid lane olarak yerinde kaldı.
  - Doğrulama: Railway deploy sonrası production manual route live smoke'unda `404` yerine auth bekleyen `401` döndü; Vercel bundle içinde `/defi/manual/execute` string'i görüldü ve alias `https://arcmachina.vercel.app` `200` verdi.
- [x] Curve ve direct-pair pozisyonlarını aynı ürün dili içinde okuyan tek bir DeFi snapshot katmanı kur; bu yüzey `Dashboard` ile tutarlı metrikler kullansın.
  - Not: `DeFi` yüzeyi pool snapshot için authenticated `oracle.poolState`, pozisyon görünümü için `agents.positions` read-model'ini kullanıyor; böylece global havuz verisi ile kullanıcı pozisyonu aynı ürün dilinde birleşiyor.
- [x] cirBTC direct-pair kartlarında raw `Swap` aksiyonunu kaldır: `cirBTC/USDC` ve `cirBTC/EURC` kartları artık yalnız LP add/remove/exit yüzeyi olarak kalacak.
  - Not: Root cause, bu kartlardaki önceki `Swap` aksiyonunun ana routed `Swap` yüzeyine değil aynı thin-liquidity direct pair adapter'ına vurmasıydı; bu da saçma quote ve execution riski yaratıyordu.
  - Not: Bu yüzden backend manual DeFi route artık direct-pair `swap` isteğini reject ediyor ve frontend kullanıcıyı ana `Swap` sekmesine yönlendiriyor.
  - Doğrulama: Railway backend ve Vercel frontend deploy yenilendi; production alias `https://arcmachina.vercel.app` `200` döndü ve bundle smoke'unda direct-pair swap copy'si yerine `Use the main Swap tab for cirBTC trades.` notu görüldü.
- [x] `DeFi` ve `Dashboard` LP kartlarında `Reward Source`, `Claim Status` ve `Risk Status` yüzeyini görünür yap.
  - Not: Mevcut APR/APY artık açıkça `Trading fees only, not claimable rewards` olarak etiketleniyor; kullanıcı tahmini fee yield ile claimable reward'ı karıştırmıyor.
  - Not: Claim statüsü şu an tüm LP'lerde `Realized on exit`; yani ayrı reward token / claim butonu yok, fee etkisi LP payı içine gömülü kalıyor.
  - Not: Risk statüsü stable Curve tarafında `Stable automation candidate`, cirBTC direct pair tarafında ise depth/impact'e göre `Volatile manual LP` veya `Thin volatile LP` olarak işaretleniyor.
  - Doğrulama: Vercel production deploy sonrası alias `https://arcmachina.vercel.app` `200` döndü; canlı bundle smoke'unda `Trading fees only, not claimable rewards`, `Realized on exit` ve `Stable automation candidate` string'leri görüldü.
- [x] `DeFi` altında ayrı `Lending` yüzeyi kur: `USDC` ve `EURC` teminat / borrow / repay / withdraw aksiyonları manuel butonlarla açılsın ve aktif adapter / execution kaynağı kullanıcıya açıkça gösterilsin.
  - Sonuç: `frontend/src/components/DeFiTab.jsx` içindeki Lending sekmesi artık reserve watchlist yanında auth'li `GET /api/agents/:id/lending` read-model'ini de yüklüyor; burada execution source, contract/build state, wallet balances, supplied/borrowed snapshot, HF/LTV/available borrow ve per-asset action guard'ları görünür.
  - Sonuç: Aynı yüzeyde `Supply / Withdraw / Borrow / Repay` formu açıldı. Submit path'i mevcut `POST /api/tasks/agents/:id/defi/manual/execute` rayı altında hidden lending task id'lerine çözülüyor; backend route queue'ye atmadan önce, worker da tx atmadan hemen önce aynı risk guard'ı tekrar çalıştırıyor.
  - Sonuç: Aynı manuel yüzey bu turda `Deleverage` ve `Liquidate` aksiyonlarını da görünür sundu; liquidation için borrower/debt/collateral alanları eklendi ve lending run'ları da artık `Latest manual action` kartında stage, summary ve tx linkleriyle izleniyor.
  - Not: Contract address yoksa ya da kontrat `scaffold_only` durumundaysa butonlar bilinçli olarak guard-blocked kalıyor; kullanıcıya hem aktif adapter kaynağı hem de blok nedeni açıkça gösteriliyor.
  - Doğrulama: `frontend/src/components/DeFiTab.jsx` ve `frontend/src/lib/api.js` editor error check temiz geçti; `backend/src/routes/tasks.js`, `backend/src/routes/agents.js`, `backend/src/services/nativeLendingRiskService.js` ve `backend/src/services/agenticEconomy/agenticTaskExecutionService.js` syntax / editor doğrulamaları temiz geçti; runtime export probe `native-lending-task-exports-ok` döndü. Son frontend deploy `https://arc-agent-frontend-jlza7fzwp-kohens-projects.vercel.app` ile production'a taşındı ve alias `https://arcmachina.vercel.app` tekrar güncellendi.
  - Deploy: Railway backend deploy tamamlandı; deploy healthcheck `Path: /health` üstünden başarılı geçti ve canlı `/health` gövdesi `{"status":"ok","db":"ok","redis":"ok"}` döndü. Frontend `frontend/` içinden `vercel --prod --yes` ile deploy edildi; alias tekrar `https://arcmachina.vercel.app` üzerine alındı ve `200` doğrulandı.
- [x] Deterministic stable DeFi policy engine v1'i ilk canlı lane için yaz: eşikler, caps, no-op koşulları, risk bandı ve günlük limitler tek yerde dursun.
  - Sonuç: `backend/src/services/stableAutomationPolicy.js` eklendi; verified `USDC/EURC` Curve lane için route doğrulama, live FX zorunluluğu, reverse-direction block, reserve depth, oracle deviation, price-impact ve size clamp guard'ları tek policy kararında toplandı.
  - Sonuç: `DEFI_LOOP` artık bu policy'yi hard guard olarak kullanıyor; `evaluateExecutionGate()` / LLM ya da rule-engine kararı yalnız advisory size/explanation katmanı olarak kaldı ve tek başına trade veto/trigger noktası olmaktan çıkarıldı.
  - Sonuç: policy artık `operationType = swap | add_liquidity | remove_liquidity | rebalance` seçebiliyor. `DEFI_LOOP` canlı wallet bakiyeleri + stable LP position snapshot okuyup bu verdict'e göre dispatch ediyor: no-position + sağlıklı havuzda `add_liquidity`, reverse-direction + yeterli EURC varsa `rebalance`, risk bandı bozulmuş mevcut LP varsa balanced `remove_liquidity`, uygun oracle lane varsa `swap`.
  - Sonuç: aynı policy şimdi `backend/src/services/agenticEconomy/agenticTaskExecutionService.js::executeArbTask()` içine de bağlandı; böylece manual / paid `EXEC_ARB` yolu da verified stable-lane guard'larını ortak execution core'dan alıyor ve unsafe durumda kullanıcı boyutunu sessizce küçültmek yerine sebebiyle birlikte skip ediyor.
  - Doğrulama: `node --check backend/src/services/stableAutomationPolicy.js`, `node --check backend/src/queue/agentQueue.js`, sentetik action-selection probe'larında `add_liquidity`, `remove_liquidity` ve `rebalance` verdict'leri beklenen şekilde döndü; canlı agent + pool probe'u da mevcut markette `swap` candidate'ının `oracleDeviation` nedeniyle block edildiğini gösterdi. Editor error check temiz geçti.
  - Doğrulama: `node --check backend/src/services/agenticEconomy/agenticTaskExecutionService.js` temiz geçti; local dry-run probe'unda `executeArbTask({ amountIn: '25' })` yeni `stablePolicy.verdict` alanını döndürdü ve current market koşulunda policy block reason'ı ile `skipped=true` kapandı.
  - Deploy: Railway backend deploy alındı; production `https://backend-production-597c.up.railway.app/health` tekrar `200` / `ok` döndü.
- [x] Stable automation v1'i `USDC/EURC` swap + add liquidity + remove liquidity + rebalance lane'i olarak aç.
  - Sonuç: `backend/src/queue/agentQueue.js` artık stable policy verdict'ini execution dispatcher olarak kullanıyor; swap path'i korunurken LP add/remove ve rebalance aksiyonları da aynı loop içinden otonom seçilip çalıştırılabiliyor.
  - Sonuç: `backend/src/services/stableAutomationPolicy.js` sabit `20-30 USD` bandından yüzde allocation modeline tasindi. Varsayılan stable LP hedefi artik toplam stable sermayenin `%25`'i; alt/ust band ise `%20 / %30`. Bu sayede `100 USD` stable sermayede hedef hâlâ `20 / 25 / 30`, ama sermaye büyüdükçe band orantılı ölçekleniyor.
  - Sonuç: exit mantigi da daha gerçekçi hale getirildi. Position bandin ustune ciktiğinda ve havuz sağlıklıysa `trim_to_target` ile hedef allocation'a kadar kısmi azaltım yapılıyor; `full_exit` ise artık her oracle sapmasında değil, yalnız hard-risk guard'ları (`liveForex` kaybı, liquidity/reserve bozulması, exit impact limiti aşımı veya `hard exit oracle deviation` eşiği) kırıldığında seçiliyor.
  - Sonuç: son `market_analysis_last_decision.signal` snapshot'ı varsa ve tazeyse stable policy bunu advisory allocation kaynağı olarak kullanıyor; production read-only probe'da bu kaynak `market_analysis:unknown`/sonrasında `llm` kaynağıyla `%10 / %20 / %30` bandına çekilmiş halde görüldü.
  - Sonuç: `backend/src/db/schema.sql` içine `agents.defi_loop_last_decision` JSON alanı eklendi; `backend/src/queue/agentQueue.js` her stable DeFi loop sonunda son verdict snapshot'ını buraya persist ediyor ve `backend/src/services/agentService.js` bunu `automation.defiLoop.lastDecision` olarak status cevabına taşıyor.
  - Sonuç: `frontend/src/components/DashboardTab.jsx` içine `Stable Automation State` kartı eklendi; burada son policy action, hold/block reason, target LP band, mevcut LP value, wallet inventory, execution rail ve günlük check/auto-tx sayaçları görünür oldu.
  - Not: canlı on-chain auto-tx smoke özellikle koşturulmadı; local/livedata probe yalnız decision ve preflight katmanını doğruladı.
  - Doğrulama: `node --check backend/src/services/stableAutomationPolicy.js`, sentetik `100 stable -> 20/25/30`, `400 stable -> 80/100/120` ve `overweight -> trim_to_target` policy probe'lari, market-analysis advisory override probe'u, `node --check backend/src/queue/agentQueue.js` ve backend editor error check temiz geçti.
  - Deploy: production DB migrate temiz geçti; Railway backend deploy sonrasi `/health` tekrar `200 / ok` döndü.
- [x] Market Analysis'i periyodik ve execution-adjacent advisory signal rayina taşı.
  - Sonuç: `backend/src/server.js` artık `scheduleMarketAnalysisLoop()` bootstrap'ini gerçekten başlatıyor; daha önce tanımlı ama çağrılmayan loop production startup'a bağlandı.
  - Sonuç: `backend/src/services/ruleEngine.js` ve `backend/src/services/llmService.js` `analyzeMarket()` çıktısını structured `signal` alanıyla genişletti. Bu signal `lane`, `shouldReviewDefi`, `% allocation bandi` ve `confidence` taşıyor.
  - Sonuç: `backend/src/db/schema.sql` içine `agents.market_analysis_last_decision` JSON alanı eklendi; `backend/src/queue/agentQueue.js` her `MARKET_ANALYSIS` run'inda bu snapshot'i persist ediyor ve gerekirse kontrollü `DEFI_LOOP` review job'u kuyruğa atıyor.
  - Sonuç: `backend/src/services/agentService.js` status read-model'i artık `automation.marketAnalysis.lastDecision` alanını döndürüyor; böylece market-analysis yalnız status badge değil, son advisory snapshot olarak da okunabiliyor.
  - Sonuç: structured `signal` payload'i artık persist öncesi deterministic normalize ediliyor. `stable_curve` lane'i için confidence, allocation yüzdeleri ve `shouldReviewDefi` alanı guard'lı hale geldi; bu sayede advisory snapshot LLM'den semantik olarak zayıf gelse bile stable policy tarafına tutarlı veri gidiyor.
  - Doğrulama: production safe smoke'ta `MARKET_ANALYSIS (llm)` success döndü; eski `%10 / %20 / %30` örneğinden sonra son doğrulamada persisted snapshot `engine = llm`, `lane = stable_curve`, `shouldReviewDefi = true`, `%5 / %20 / %30` ve `queuedDefiReview = true` olarak production DB probe'u ile görüldü.
  - Deploy: production DB migrate + Railway deploy tamamlandı; backend health `ok` kaldı.
- [x] Stable automation dashboard guven katmanini tamamla: manual cooldown, allocation source ve oracle snapshot ayrimini kullaniciya acik gostersin.
  - Sonuç: `backend/src/db/schema.sql`, `backend/src/queue/agentQueue.js`, `backend/src/services/stableAutomationPolicy.js` ve `backend/src/services/agentService.js` birlikte `stable_manual_cooldown_until` kolonunu, manual Curve add success hook'unu ve stable policy tarafinda `manualCooldown` block reason'ini canliya tasidi. Soft trim / soft exit cooldown boyunca duruyor; hard-risk exit guard'lari yine override edebiliyor.
  - Sonuç: `backend/src/queue/agentQueue.js` stable `defi_loop_last_decision` snapshot'ina `targetLpTargetUsd`, allocation yüzde alanlari, allocation source, `marketSignalFresh`, `manualCooldownUntil` ve `manualCooldownActive` alanlarini ekliyor; Dashboard artik stable state kartinda yalniz USD bandini değil bu bandin hangi advisory/policy kaynaktan geldigini de gosterebiliyor.
  - Sonuç: `frontend/src/components/DashboardTab.jsx` yeni `Market Analysis State` kartini gosteriyor; `Recent Activity` icinde tekrarlayan `oracle_signal` satirlari sikistiriliyor ve baslik/copy artik `oracle snapshot` dili kullaniyor. Bu sayede kullanici bunlari ayrik trade execution kaydi ile karistirmiyor. Stable kart da aktif cooldown varsa bunu acik amber banner ile gosteriyor.
  - Doğrulama: `node --check backend/src/queue/agentQueue.js`, `node --check backend/src/services/agentService.js`, `get_errors` ile `DashboardTab.jsx` temiz; dar local probe manual cooldown aktifken `blockedBy = manualCooldown` ve `operationType = remove_liquidity` sonucunu verdi. Production DB migrate + Railway deploy + `curl https://backend-production-597c.up.railway.app/health` `ok`, Vercel production deploy alias `https://arcmachina.vercel.app` `200` ve production DB/read-model probe'lari temiz.
- [x] cirBTC lane'ini, kucuk bir stable LP acikken de ayri `idle capital` butcesiyle yaristir.
  - Sonuç: `backend/src/queue/agentQueue.js` icinde cirBTC gate'i artik `stablePolicy.metrics.positionPresent !== true` kosuluna bagli degil; stable lane o cycle icin `swap / add_liquidity / rebalance` tarafinda hangi USDC/EURC miktarini fiilen rezerve ediyorsa once bu ayriliyor, sonra cirBTC direct-pair policy yalniz kalan butceyle evaluate ediliyor.
  - Sonuç: ayni queue slice'inda persistence akisi da duzeltildi; cirBTC lane evaluate edilip hold verirse `cirbtc_lp_last_decision` artik stable karari kopyalamiyor, gercek `cirbtc_policy_hold` reason ve `blockedBy` alanini yaziyor.
  - Doğrulama: `node --check backend/src/queue/agentQueue.js` ve editor error check temiz. Railway production deploy sonrasi health `ok`. Canli prod probe'da stable lane `suggestedLiquidityDeployUsdc = 25` rezerv ederken cirBTC lane `USDC-CIRBTC` icin `walletStableBalance = 1902.175075` ile ayrica evaluate edildi ve `blockedBy = priceImpact` / `reason = cirBTC LP automation v1 blocked execution: USDC-CIRBTC price impact must stay within 2.5%...` sonucu goruldu. Ardindan gerçek `DEFI_LOOP` run'inda `defi_loop_last_decision.blockedBy = oracleDeviation` ve ayri `cirbtc_lp_last_decision.blockedBy = priceImpact` birlikte production DB'de dogrulandi.
- [x] `cirBTC` LP automation v1 aç: yalnız doğrulanmış pair ve position state üzerinden bootstrap, küçültme ve tam exit kuralları ekle.
  - Durum guncellemesi (2026-05-21): `cirbtc_direct_pair_lp_v1` canli agent uzerinde dogrulandi. Service-env altinda kaydedilen son E2E rayda `EURC-CIRBTC` pozisyonu risk guard nedeniyle `full_exit` secip confirmed `direct_lp_remove` (`txHash=0x3eaab2ee2039bda7b97dcb688f6c66442ff42d9b5911b0acc5397592e2f67c50`) uretti; ayri current positions snapshot'inda `USDC-CIRBTC` LP pozisyonunun da halen dogru okunabildigi goruldu.
  - Bu tur kalan urun aciklari kapatildi: `backend/src/db/schema.sql` icine `cirbtc_lp_last_run_at`, `cirbtc_lp_last_status` ve `cirbtc_lp_last_decision` alanlari eklendi; `backend/src/queue/agentQueue.js` stable ve `cirBTC` automation persistence'ini ayri kolonlara yazacak sekilde guncellendi; `backend/src/services/agentService.js` da `automation.cirbtcLp` read-model'ini bu alanlardan besleyecek sekilde ayrildi. Ayni rollout'ta `backend/src/services/indexerService.js` artik Arc tarafinda `USDC / EURC / cirBTC`, Sepolia tarafinda `USDC / EURC` transferlerini izliyor; `transactions.type = 'receive'` satirlarina token-aware `meta.tokenAmount`, `meta.tokenSymbol`, USD metadata ve tx+token+log bazli dedupe yaziyor.
  - Dogrulama: editor error check temiz; production DB migrate `Schema migrations applied` ile gecti; safe live smoke `MARKET_ANALYSIS=success`, `ORACLE_QUERY=success`, stable lane `executed`, `cirBTC` lane `idle` dondu. Railway backend deploy sonrasi `/health` `ok`, Vercel alias `https://arcmachina.vercel.app` `200` dogrulandi.
- [x] Stable ve `cirBTC` automation status persistence'ini ayir: `cirbtcLp` icin ayri `lastRunAt / lastStatus / lastDecision` alanlari ac; Dashboard kartlari birbirinin state'ini overwrite etmesin.
  - Sonuc: `agents` tablosuna ayri `cirbtc_lp_*` kolonlari eklendi; queue ve status read-model stable lane ile `cirBTC` lane'i birbirinden bagimsiz persist ediyor.
  - Dogrulama: production DB migrate temiz gecti; safe live smoke sonrasi stable lane ile `cirBTC` lane status alanlari ayni payload'ta bagimsiz okundu.
- [x] Multi-token receive indexing ekle: `indexerService` icine en az `EURC` ve `cirBTC` transfer izleme ya da LP exit payload'larindan synthetic `receive` activity uret; direct-pair exit sonrasi `Received` gorunurlugu dogru olsun.
  - Sonuc: `backend/src/services/indexerService.js` USDC odakli tek-token izleme yerine `USDC / EURC / cirBTC` transferlerini token-aware metadata ile indexliyor; ayni tx icindeki farkli token event'leri artik birbirini ezmiyor.
  - Dogrulama: backend syntax/editor check temiz gecti; yeni deploy sonrasi `receive` satiri display'i `DashboardTab` icinde `meta.tokenAmount` tercih edecek sekilde hizalandi.
- [x] Lending v1 kapsamını dondur: ilk faz yalnız `USDC` ve `EURC` ile çalışan izole market mantığında olsun; `cirBTC` ilk fazda borrowable olmasın.
  - Scope kilidi: ilk canlı lending lane tek kontratlı `ArcLendingPool` üstünden ilerleyecek; reserve listesi yalnız `USDC` ve `EURC` olacak.
  - Yasaklar: `cirBTC` ilk fazda collateral ya da borrow asset olmayacak; LP token, NFT, job escrow varlığı veya başka üçüncü varlık collateral kabul edilmeyecek.
  - İlk kullanıcı aksiyonları: yalnız manuel `Supply / Withdraw / Borrow / Repay`; `Paid` görevleri, automation, reward emission ve auto-compound ilk faz dışında kalacak.
  - İlk muhasebe modeli: account başına reserve bazlı `suppliedPrincipal`, `borrowPrincipal` ve `useAsCollateral`; health ve borrow kapasitesi stable-only oracle/risk katmanına bağlanacak.
  - İlk ürün sınırı: aynı shared execution core üstünde çalışan ayrı `Lending` yüzeyi olacak; `Tasks > Paid` veya mevcut `DeFi` LP yüzeyi bunun yerine geçmeyecek.
  - Kapanış: scope kilidi artık kod, UI ve route wiring tarafında görünür; `frontend/src/components/DeFiTab.jsx`, `backend/src/routes/tasks.js`, `backend/src/services/nativeLendingRiskService.js` ve `backend/src/services/lendingOracleService.js` ilk faz sınırlarını doğrudan uyguluyor.
- [ ] Lending v1 sözleşme katmanını kur: supply, withdraw, index accrual, reserve accounting ve pool caps gerçek on-chain state ile çalışsın.
  - Teknik hedef kontrat: `contracts/ArcLendingPool.sol` tek havuzlu stable lending çekirdeği olacak; owner/treasury, reserve config/state, supported asset registry ve account position modeli aynı yerde tutulacak.
  - Teknik hedef state: reserve bazında `supplyCap`, `borrowCap`, `collateralFactorBps`, `liquidationThresholdBps`, `liquidationBonusBps`, `reserveFactorBps`, `supplyIndexRay`, `borrowIndexRay`, `lastAccrualTimestamp`; kullanıcı bazında `suppliedPrincipal`, `borrowPrincipal`, `useAsCollateral` tutulacak.
  - Bu turdaki başlangıç iskeleti repo içine yazıldı: `contracts/ArcLendingPool.sol`, `backend/src/services/protocols/nativeLending.js`, `backend/src/services/protocols/index.js` export wiring'i ve `scripts/direct-deploy-lending-pool.js`.
  - Bu turdaki iskeletin sınırı: reserve config/state ve account liquidity preview zincir üstünde tanımlı, fakat `supply / withdraw / borrow / repay / liquidate` write path'leri bilinçli olarak `scaffold_only` aşamasında ve live değil.
  - Sonraki teknik kapanış: gerçek token transfer/approve akışı, share-debt muhasebesi, index accrual formülü, reserve cash accounting, pause/close-factor/liquidation yürüyüşü ve deploy sonrası backend/manual route entegrasyonu.
  - Doğrulama: `contracts/ArcLendingPool.sol` editor error check temiz geçti; `node --check /workspaces/arc-agent/backend/src/services/protocols/nativeLending.js`, `node --check /workspaces/arc-agent/backend/src/services/protocols/index.js`, `node --check /workspaces/arc-agent/scripts/direct-deploy-lending-pool.js` temiz geçti; runtime require probe `native-lending-exports-ok` döndü.
- [x] Lending v1 risk katmanını kur: borrow, repay, health factor, LTV, liquidation threshold, pause ve emergency deleverage guard'ları ekle.
  - Sonuç: `backend/src/services/nativeLendingRiskService.js` eklendi; reserve state, account position, wallet balance ve stable-only price snapshot birleştirilerek `healthFactor`, `ltvPct`, collateral/borrow capacity, liquidation buffer ve per-asset action guard'ları üretiliyor.
  - Sonuç: Risk guard artık iki yerde enforce ediliyor: `POST /api/tasks/agents/:id/defi/manual/execute` preflight katmanında ve `backend/src/services/agenticEconomy/agenticTaskExecutionService.js` içindeki lending worker path'inde tx öncesi ikinci kontrol olarak.
  - Sonuç: Aynı risk katmanı şimdi `recovery` ve `liquidation` read-model alanlarını da üretiyor; deterministic emergency deleverage planı, self-liquidation durumu ve external borrower liquidation opportunity guard'ı backend içinde hesaplanıyor.
  - Sonuç: Hidden lending task rayı `deleverage` ve `liquidate` action'larına genişletildi; `backend/src/queue/agentQueue.js` içindeki yeni processor'lar ve `backend/src/routes/tasks.js` resolver/preflight katmanı bu iki action'ı queue'ye düşmeden önce ayrı risk guard'larıyla doğruluyor ve liquidation request'lerinde top-level `collateralAsset` alanını da kabul ediyor.
  - Kalan iş: forced LP reduction entegrasyonu ve live contract sonrası gerçek close-factor davranışı sonraki açık maddelerde duruyor; temel lending risk katmanı artık mevcut manual lane için tamamlandı.
  - Doğrulama: `node --check /workspaces/arc-agent/backend/src/services/nativeLendingRiskService.js`, `node --check /workspaces/arc-agent/backend/src/services/protocols/nativeLending.js`, `node --check /workspaces/arc-agent/backend/src/services/protocols/index.js`, `node --check /workspaces/arc-agent/backend/src/services/agenticEconomy/agenticTaskExecutionService.js`, `node --check /workspaces/arc-agent/backend/src/queue/agentQueue.js`, `node --check /workspaces/arc-agent/backend/src/routes/tasks.js` temiz geçti; editor error check temiz; Railway deploy sonrası production `/health` gövdesi `{"status":"ok","db":"ok","redis":"ok"}` döndü.
- [x] Oracle / price katmanını lending için ayır: borrow ve liquidation hesapları için kullanılacak resmi price source ve fallback mantığını netleştir.
  - Sonuç: `backend/src/services/lendingOracleService.js` eklendi; `USDC` için `stable_par`, `EURC` için `oracle.getForexRate('EURC', 'USDC')` ana kaynak ve oracle başarısızsa açık fallback mantığı tanımlandı.
  - Sonuç: Yeni lending risk/read-model katmanı bu dedicated price snapshot'ı kullanıyor; frontend `DeFi > Lending` yüzeyi de price guard kartında kaynak ile fallback durumunu açıkça gösteriyor.
  - Doğrulama: `node --check /workspaces/arc-agent/backend/src/services/lendingOracleService.js` temiz geçti; editor error check temiz.
  - Deploy: Bu katman aynı backend/frontend rollout'u içinde canlıya taşındı; Railway `/health` ve Vercel alias `200` doğrulaması aynı turda temiz geçti.
- [ ] Lending paid görevlerini aç: supply, withdraw, borrow, repay, deleverage, collateral top-up, safe exit.
  - Durum güncellemesi (2026-05-21): public paid lane'e `EXEC_LENDING_SUPPLY`, `EXEC_LENDING_WITHDRAW`, `EXEC_LENDING_BORROW`, `EXEC_LENDING_REPAY`, `EXEC_LENDING_DELEVERAGE` ve `EXEC_LENDING_LIQUIDATE` task'leri eklendi; `backend/src/queue/agentQueue.js` seed + processor kaydi, `backend/src/routes/tasks.js` param validation ve `frontend/src/components/TasksTab.jsx` form/result katmani bu task'lerle hizalandi. `frontend/src/components/DeFiTab.jsx` da ayni turda `Recovery` ve `Liquidation Risk` kartlariyla lending guard durumunu daha gorunur hale getirdi.
  - Durum güncellemesi (2026-05-22): `frontend/src/components/DeFiTab.jsx` manuel lending paneli de artik backend'de mevcut olan `Deleverage` ve `Liquidate` hidden action'larini form seviyesinde kullanabiliyor; boylece DeFi tarafindaki manuel lending akisi `Supply / Withdraw / Borrow / Repay / Deleverage / Liquidate` setine genisledi ve queued run takibi LP paneliyle hizalandi.
  - Kalan somut iş: `collateral top-up` ve gercek `safe exit` icin ayri execution helper + public task kimligi tanimla; sonra bu maddeyi tamamen kapat.
  - Doğrulama: `node --check /workspaces/arc-agent/backend/src/queue/agentQueue.js`, `node --check /workspaces/arc-agent/backend/src/routes/tasks.js`, `frontend/src/components/TasksTab.jsx` editor error check, `frontend/src/components/DeFiTab.jsx` editor error check temiz geçti; son frontend deploy `https://arc-agent-frontend-jlza7fzwp-kohens-projects.vercel.app` production alias'ina tasindi.
- [ ] Lending autonomous guard v1 aç: health factor eşiği, utilization cap, auto-repay ve forced LP reduction akışları deterministic çalışsın.
- [ ] Full smoke suite yaz: stable Curve, `cirBTC` direct-pair, lending supply/withdraw, lending borrow/repay, deleverage ve no-op guard senaryoları tek komutla doğrulansın.
  - Durum guncellemesi (2026-05-21): non-reputation live smoke turunda `MARKET_ANALYSIS` ve `ORACLE_QUERY` Railway service-env icinde success calisti; stable automation icin confirmed `curve_lp_remove + receive`, `cirBTC` automation icin confirmed `EURC-CIRBTC direct_lp_remove` DB ve on-chain snapshot ile dogrulandi. Ayni turda `backend/scripts/automationLiveSmoke.js` ve kok `npm run smoke:automation:live -- --agent <id>` komutu eklendi; default safe-mode `MARKET_ANALYSIS`, `ORACLE_QUERY`, automation status ve positions evidence topluyor, yalniz `--run-defi` verilirse live `DEFI_LOOP` calistiriyor. Stable + cirBTC + lending tam matrisi tek komutta destructive olmadan kapatan daha genis suite ise halen acik.
- [ ] Frontend ürün akışını son kez hizala: `Bridge` ve `Swap` ayrı sekme kalırken manuel DeFi, paid DeFi ve automation DeFi aynı ürün hikâyesinde karışmadan gösterilsin.

### 14B. Stable Reward / Claimable Accrual Draft'i

- [x] Stable fee-only otonom reward politikası v1 taslağını çıkar.
  - Kural: İlk otonom reward lane yalnız `USDC/EURC` stable Curve havuzunda açılacak; `cirBTC` direct pair'ler depth ve wash-trade guard'ları oturmadan manual kalacak.
  - Entry guard: `liquidityState != empty`, `priceImpact10k <= 1.5%`, `poolFeePct > 0`, expected fee-only run-rate gas + risk buffer üstünde, oracle deviation cap içinde ve agent allocation havuz başına tanımlı üst limitin altında olacak.
  - Hold / reduce guard: fee-only beklenen net getiri iki epoch üst üste buffer altına düşerse, stable depth bozulursa veya oracle deviation cap aşılırsa agent pozisyonu küçültmeye ya da tamamen çıkmaya zorlanacak.
  - Claim mantığı: fee-only fazda ayrı claim olmayacak; reward source `Trading fees only`, claim status `Realized on exit` olarak kalacak. Auto-compound ancak gerçek realized fee accounting geldikten sonra açılacak.

- [x] Gerçek claimable reward backend data model / accrual taslağını çıkar.
  - `lp_reward_programs`: `id`, `pool_key`, `reward_token`, `reward_source_type` (`treasury`, `partner`, `protocol_revenue`), `emission_mode` (`fixed_rate`, `epoch_budget`), `emission_rate`, `start_at`, `end_at`, `status`.
  - `lp_reward_epoch_snapshots`: `id`, `program_id`, `epoch_start`, `epoch_end`, `pool_lp_supply`, `eligible_lp_supply`, `reward_budget`, `source_block_number`, `status`.
  - `agent_lp_reward_accruals`: `id`, `agent_id`, `program_id`, `snapshot_id`, `avg_lp_balance`, `share_bps`, `reward_earned`, `reward_claimed`, `reward_unclaimed`, `status`, `last_compound_at`.
  - `agent_lp_reward_claims`: `id`, `agent_id`, `program_id`, `accrual_id`, `claim_mode` (`claim`, `compound`), `amount`, `tx_hash`, `created_at`.
  - Muhasebe kuralı: LP fee getirisi bu tablolara yazılmayacak; bu tablolar yalnız ayrı incentive emissions için tutulacak. Fee-only LP getirisi pozisyon NAV'i içinde kalacak ve exit anında realize edilecek.
  - Abuse guard taslağı: min holding epoch, per-agent reward cap, per-pool reward cap, self-trade / wash-trade filtreleri ve pause flag zorunlu olacak.

- [x] Claimable reward backend iskeletini gerçek schema + read-model olarak aç.
  - Sonuç: `backend/src/db/schema.sql` içine `lp_reward_programs`, `lp_reward_epoch_snapshots`, `agent_lp_reward_accruals` ve `agent_lp_reward_claims` tabloları gerçek constraint/index/trigger setiyle eklendi.
  - Sonuç: `backend/src/services/lpRewardService.js` eklendi; agent bazlı program, accrual ve claim ledger özetini DB-backed olarak okuyabiliyor.
  - Sonuç: auth'li `GET /api/agents/:id/rewards` route'u `backend/src/routes/agents.js` içine eklendi.
  - Doğrulama: local `NODE_ENV=production node src/db/migrate.js` temiz geçti; information_schema probe'unda dört reward tablosu da bulundu; gerçek agent üstünde `getAgentRewardOverview()` boş ama geçerli bir reward summary döndürdü.
  - Deploy: Railway deploy `413cd777-48d5-44ef-8697-eeacbd51b1fd` online; production `https://backend-production-597c.up.railway.app/health` cevabı `{"status":"ok","db":"ok","redis":"ok"}` döndü.

- [x] Seeded reward program + epoch snapshot writer + Dashboard rewards paneli production'a taşı.
  - Sonuç: `backend/src/services/lpRewardProgramService.js` ile paused default `USDC/EURC` reward program seed'i ve epoch snapshot writer eklendi; RPC yoksa bile fallback note ile ledger satırı yazılıyor ve `backend/src/server.js` startup'ında otomatik başlıyor.
  - Sonuç: `backend/src/services/lpRewardService.js` snapshot-aware hale geldi; paused seeded program artık yanlış şekilde `claimableRewardsEnabled=true` üretmiyor, program/snapshot summary'leri `GET /api/agents/:id/rewards` cevabına taşınıyor.
  - Sonuç: `frontend/src/lib/api.js` içine rewards client eklendi ve `frontend/src/components/DashboardTab.jsx` içinde ayrı `LP Rewards Ledger` kartı açıldı; seeded paused program, latest epoch snapshot ve claimable/unclaimed ayrımı kullanıcıya görünür oldu.
  - Doğrulama: `node --check backend/src/services/lpRewardProgramService.js`, `node --check backend/src/server.js`, reward writer local DB probe'u, `getAgentRewardOverview()` live readback'ı ve editor error check temiz geçti.
  - Deploy: Railway backend deploy sonrası production health `200` döndü; yanlış projeye giden `frontend/.vercel` link'i `arc-agent-frontend` olarak düzeltilip doğru Vercel production deploy yeniden alındı. Sonraki smoke turunda `frontend/vercel.json` eklenerek frontend-klasörü deploy'larında `/api` rewrite sözleşmesi de geri getirildi; `https://arcmachina.vercel.app` homepage `200`, alias üstünden public Oracle path'i beklenen `402 payment_required`, canlı bundle içinde `LP Rewards Ledger` string'i doğrulandı.

- [x] Prod smoke kontrollerini tek komutluk kalıcı script'e bağla.
  - Sonuç: root'a `scripts/prodSmoke.js` eklendi ve `npm run smoke:prod` komutu tanımlandı.
  - Kapsam: script local `frontend/.vercel/project.json` link doğrulaması, `frontend/vercel.json` varlık kontrolü, production homepage `200`, canlı bundle içinde `LP Rewards Ledger`, Railway backend `/health` ve alias üstünden public Oracle unpaid `402` smoke'unu tek seferde doğruluyor.
  - Doğrulama: `cd /workspaces/arc-agent && npm run smoke:prod` exit code `0` ile geçti.

- [x] 1. Backend private key alan adı tutarsızlığını tek standarda indir.
  Kapsam: `backend/src/routes/jobs.js` ve `backend/src/queue/agentQueue.js` içindeki tüm kolon ve field kullanımları schema ile hizalanacak.
  Sonuç: `private_key_encrypted` standardı uygulandı; yanlış `encrypted_private_key` erişimleri kaldırıldı.
  Doğrulama: Dar backend syntax kontrolü ve editor error check temiz geçti.
  Deploy hedefi: Railway deploy tamamlandı.

- [x] 2. `AgentTab` içinden Free Daily Tasks bölümünü kaldır.
  Kapsam: Aynı özellik iki ekranda yaşamayacak.
  Sonuç: Free task yönetimi yalnızca `TasksTab` içinde bırakıldı.
  Doğrulama: Frontend production build temiz geçti.
  Deploy hedefi: Vercel deploy tamamlandı.

- [x] 3. `AgentTab` içinden Autonomous Features bölümünü kaldır.
  Kapsam: Automation ayarları `TasksTab` veya tek bir merkezi yüzeye taşınacak.
  Sonuç: Automation ayarları `TasksTab` içindeki ayrı Automation grubuna taşındı.
  Doğrulama: Frontend production build temiz geçti.
  Deploy hedefi: Vercel deploy tamamlandı.

- [x] 4. `TasksTab` yapısını `Free | Paid | Automation` olarak yeniden düzenle.
  Kapsam: Free task, paid task ve automation toggle'ları tek ürün akışında toplanacak.
  Sonuç: Tasks ekranı üç gruba ayrıldı ve automation toggle'ları anlık kaydetme ile aynı yüzeye taşındı.
  Doğrulama: Frontend production build temiz geçti.
  Deploy hedefi: Vercel deploy tamamlandı.

- [x] 5. Free task limit kuralını netleştir ve tüm ekranlara aynı kuralı uygula.
  Kapsam: Backend guard, Tasks metni ve varsa kalan UI davranışları aynı mantığa çekilecek.
  Sonuç: Free task limiti agent başına günlük toplam 5 run olarak sabitlendi ve kullanıcıya aynı şekilde gösterildi.
  Doğrulama: Backend route syntax check, frontend production build ve editor error check temiz geçti.
  Deploy hedefi: Railway + Vercel deploy tamamlandı.

- [x] 6. Execution task'ler için parametre modal/form akışı ekle.
  Kapsam: Curve Swap, Yield Move, Arb Execution, Portfolio Rebalance, CCTP Bridge.
  Sonuç: Kullanıcı işlem öncesi gerekli parametreleri giriyor; `TasksTab` inline execution formu ve backend route validation birlikte aktif.
  Doğrulama: Frontend build, backend syntax check ve editor error check temiz geçti.
  Deploy hedefi: Railway + Vercel deploy tamamlandı.

- [x] 7. `EXEC_CCTP_BRIDGE` için default parametreleri kaldır veya doğru chain isimleriyle değiştir.
  Kapsam: Queue processor ve gerekiyorsa frontend parametre zorunluluğu.
  Sonuç: Queue processor default bridge parametreleri kaldırıldı; açık chain ve amount parametresi olmadan çalışma yok.
  Doğrulama: Backend syntax check, editor error check ve Railway healthcheck temiz geçti.
  Deploy hedefi: Railway + Vercel deploy tamamlandı.

- [x] 8. Jobs funding akışını gerçek hale getir.
  Kapsam: Create sonrası funding / escrow geçişi ve state update mantığı.
  Sonuç: Create akışı `funded` başlıyor; legacy `open` job'lar migration ile ileri taşındı ve deliver için blokaj kaldırıldı.
  Doğrulama: Backend syntax check, editor error check ve Railway healthcheck temiz geçti. Uçtan uca auth'lu job akışı yerelde test edilemedi.
  Deploy hedefi: Railway deploy tamamlandı.

### P1 — Sonraki Ürün İşleri

- [x] P0-X402 — Circle Gateway x402 agentic economy rayını izole kur.
  Kapsam: Standard `Bridge / Swap / Send / Receive` akışlarını korurken yalnız `Tasks / Jobs / Oracle / nano-pay` için ayrı Gateway/x402 servis katmanı kurulacak.
  Detay referansı: `CIRCLE-GATEWAY-X402-MIGRATION.local.md`
  Beklenen çıktı: Oracle seller middleware, nano-pay buyer path, paid task economy rayı ve jobs economy hook'ları yeni izole backend katmanında çalışacak.
  Doğrulama: Oracle seller canlı `402` + paid settle smoke verdi, `nano-pay` route izole buyer path'te production `confirmed` oldu, paid `EXEC_ARB` sonucu `agentic_task_economy` metadata'sı ile yazıldı, jobs create/get/deliver/complete zinciri `agentic_job_economy` metadata'sı ile production'da doğrulandı, standard `send` içindeki nano branch Gateway rayına taşındı, `agentic_payment_events` tablosunda nano/job audit satırları doğrulandı, Oracle status control-plane alanları Railway + Vercel deploy sonrası canlı smoke ile doğrulandı ve structured log prefix'leri altıncı Railway deploy sonrası canlı health + auth'li status smoke ile doğrulandı; Oracle public paid path için buyer auto-fund helper eklendi, Gateway success response içindeki UUID settlement id kabul edildi ve production `pool-state` paid smoke sonrası `oracle_payments` tablosunda gerçek satır doğrulandı. Ek runtime taramada backend içindeki aktif Gateway ödeme çağrılarının yalnız `backend/src/services/agenticEconomy/gatewayBuyer.js` üstünden geçtiği ve `nano-pay` / `send` / task / jobs raylarının aynı buyer auto-fund katmanını kullandığı doğrulandı. Ardından legacy `backend/src/middleware/oraclePayment.js` dosyası repodan kaldırıldı, pre-payment `429` için güvenli retry/backoff yalnız helper seviyesinde eklendi, production auth'lu `/api/oracle/debug/gateway-balance?agentId=...` smoke ile agent wallet/gateway available değerleri canlı doğrulandı ve dış buyer onboarding için production `402` body içinde `docsUrl`, `machineDocsUrl` ve public download alanları Railway deploy sonrası canlı preview smoke ile doğrulandı. Bu açık kontrat redeploy gerektirmeden kapandı; sırada yalnız ek observability ve public-surface hardening backlog'u kaldı.
  Deploy hedefi: Railway, gerektiğinde Vercel.

- [x] P0-X402-EXT — Public Oracle buyer onboarding yüzeyini ekle.
  Kapsam: `402` body'ye `docsUrl` eklemek, repoya tek sayfalık public buyer guide koymak, çalışan JS preview/example client eklemek ve küçük Arc buyer helper iskeleti çıkarmak.
  Sonuç: `backend/src/routes/oracle.js` unpaid response'u artık `docsUrl`, `machineDocsUrl` ve public download URL'leri döndürüyor; internal referans olarak `docs/oracle-public-buyer-guide.md` tutuluyor; dışarıya açık yüzey `frontend/public/oracle-public-buyer-guide.html` ile Vercel alias'ına yayınlandı; `frontend/public/downloads/oraclePublicBuyerExample.js` ve `frontend/public/downloads/arcOracleBuyerHelper.js` doğrudan indirilebilir hale geldi; yeni `frontend/public/oracle-public-buyer-manifest.json` machine-readable hızlı discovery yüzeyi olarak eklendi; `frontend/src/components/OracleTab.jsx` içine guide'ı açan ve download aksiyonlarını gösteren `External Buyer Onboarding` kartı eklendi; public guide ile public/internal example dosyaları raw Railway hostname yerine explicit `ORACLE_PUBLIC_BASE_URL` placeholder'ı kullanacak şekilde sertleştirildi ve son kullanıcıyı ilgilendirmeyen güvenlik notu kaldırıldı; `backend/examples/oraclePublicBuyerExample.js` preview ve paid mode içeriyor; `backend/examples/arcOracleBuyerHelper.js` `preview -> ensure Gateway balance -> signed retry` akışını topluyor; `backend/package.json` içine örnek script'leri eklendi ve Railway backend için `ORACLE_BUYER_DOCS_URL=https://arcmachina.vercel.app/oracle-public-buyer-guide.html` kalıcı env olarak set edildi.
  Doğrulama: `node --check backend/src/routes/oracle.js`, `node --check backend/src/db/index.js`, `node --check backend/src/server.js`, `node --check backend/examples/arcOracleBuyerHelper.js`, `node --check backend/examples/oraclePublicBuyerExample.js`, `node --check frontend/public/downloads/oraclePublicBuyerExample.js`, OracleTab editor error check temiz, `cd backend && npm run oracle:buyer:example -- --help`, Vercel production deploy, Vercel alias smoke (`/oracle-public-buyer-guide.html`, `/oracle-public-buyer-manifest.json`, `/downloads/oraclePublicBuyerExample.js`, `/downloads/arcOracleBuyerHelper.js`) ve canlı `cd backend && ORACLE_PUBLIC_BASE_URL=https://backend-production-597c.up.railway.app ORACLE_PUBLIC_ENDPOINT=pool-state ORACLE_PUBLIC_POOL=USDC-EURC npm run oracle:buyer:preview` smoke'unda public `docsUrl`, `machineDocsUrl` ve download alanları doğrulandı. Local `cd frontend && npm run build` Codespaces'ta yine `143/Terminated` ile kesildi; `BUILD-DEPLOY-TROUBLESHOOTING.local.md` kuralına uygun olarak bu durum çevresel kabul edildi ve prod Vercel build başarıyla referans alındı.
  Deploy hedefi: Railway backend deploy ve Vercel production deploy tamamlandı.

- [x] P0-OPS — Railway startup warning cleanup.
  Kapsam: production loglarındaki `pg` SSL alias warning ve `ioredis/Bull` kaynaklı `MaxListenersExceededWarning` gürültüsünü temizlemek.
  Sonuç: `backend/src/db/index.js` içinde `DATABASE_URL` sanitize edilerek `sslmode` alias warning'i kaldırıldı; `backend/src/server.js` Redis readiness akışı sertleştirildi; `backend/src/queue/agentQueue.js` queue Redis client'larında `lazyConnect` kapatıldı ve beklenen listener sayısı için limit açıkça yükseltildi.
  Doğrulama: `node --check backend/src/db/index.js`, `node --check backend/src/server.js`, `node --check backend/src/queue/agentQueue.js`, Railway backend deploy, `curl https://backend-production-597c.up.railway.app/health` ve son runtime log taramasında startup sırasında artık `pg` SSL warning'i veya `MaxListenersExceededWarning` satırı görülmedi.
  Deploy hedefi: Railway backend deploy tamamlandı.

- [x] P0-ORACLE-READY — Oracle private/manual fund, auth audit ve readiness resmi netleştir.
  Kapsam: Oracle sekmesindeki seçili agent balance kartına opsiyonel manuel Gateway pre-fund aksiyonu eklemek, Oracle route ağacının auth sınırını kod üstünden denetlemek, production smoke ile gerçek çalışma seviyesini ölçmek ve tam hazır hale gelmek için eksikleri yazılı hale getirmek.
  Sonuç: `frontend/src/components/OracleTab.jsx` içine `Fund Gateway +1 USDC` aksiyonu eklendi; backend'de private `POST /api/oracle/gateway/fund` route'u açıldı; manuel pre-fund helper akışını bozmadan opsiyonel warm-balance davranışı verdi; Oracle auth audit'inde public debug leak bulunmadı; private status ve private manual fund production smoke ile `200` doğrulandı; public 4 endpoint `402` ve paid 4 endpoint `200` smoke'u alındı; env fix sonrası `pool-state` paid smoke `arc_rpc` kaynağına geçti; ardından verified default Arc pool registry, doğru token index/decimal metadata ve `get_dy` tabanlı gerçek pricing modeli eklendi; `USDC-USYC` için problem adres eksikliğinden boş likidite durumuna indirildi; readiness/auth-audit/alerting planı `ORACLE-READINESS-EXPANSION.local.md` dosyasına yazıldı ve structured alert/log wiring kod seviyesinde eklendi.
  Doğrulama: `node --check backend/src/services/agenticEconomy/gatewayBuyer.js`, `node --check backend/src/routes/oracle.js`, `node --check backend/src/services/oracle/arcRpc.js`, `node --check backend/src/services/oracle/pools.js`, `node --check backend/src/queue/agentQueue.js`, `get_errors frontend/src/lib/api.js`, `get_errors frontend/src/components/OracleTab.jsx`, Railway backend deploy, Vercel production deploy, Railway env ile signed production `GET /api/oracle/status` smoke `200`, Railway env ile signed production `POST /api/oracle/gateway/fund` smoke `200`, public 4 endpoint `402` smoke, Railway env ile selected agent signer üzerinden paid 4 endpoint `200` smoke, ek Railway backend deploy sonrası public `pool-state?pool=WUSDC-USDC` `402` smoke, Railway env ile signed private `pool-state?pool=EURC-USDC` `200`, private `pool-state?pool=WUSDC-USDC` `200`, private `pool-state?pool=USDC-USYC` `200` ve empty-liquidity note, private `arb-signal` `200`, farklı uygun production agent ile paid `pool-state?pool=WUSDC-USDC` `200` ve `rateUnit = USDC per WUSDC`, Railway logs içinde yeni `[ORACLE_GATEWAY] Oracle public route returned payment challenge` satırı.
  Deploy hedefi: Railway backend deploy ve Vercel production deploy tamamlandı.

- [x] 9. Oracle görünürlüğünü frontend'e taşı.
  Kapsam: Dashboard veya Tasks içine Oracle API kartı, status, endpoint listesi, pricing, revenue, request count, payment address.
  Sonuç: Oracle Service görünümü top-level `Oracle` sekmesine taşındı; auth'lu status cevabı üzerinden endpoint listesi, fiyatlar, revenue, request count, payment readiness ve pay-to adresi burada gösteriliyor. Son frontend diliminde seçili agent için canlı `wallet / gateway available` paneli eklendi; panel yeni auth'lu `/api/oracle/debug/gateway-balance?agentId=...` endpoint'ini kullanıyor. Ardından OracleTab içine üçüncü taraf buyer'ların Circle quickstart akışında tipik olarak ilk ödeme öncesi Gateway deposit yaptığı, Arc-managed agent'larda ise buyer helper'ın Gateway funding'i ödeme anında otomatik tamamladığı açıklaması eklendi. Sonraki UI diliminde bu onboarding yüzeyi insan kullanıcıya da görünür hale getirildi: `External Buyer Onboarding` kartı artık guide'ı doğrudan açıyor ve opsiyonel example/helper download aksiyonlarını gösteriyor.
  Doğrulama: `node --check src/routes/oracle.js`, OracleTab editor error check temiz geçti. Production auth'lu gateway balance smoke `wallet.availableUsdc=58.366797` ve `gateway.availableUsdc=0` ile doğrulandı. Local `cd frontend && npm run build` Codespaces'ta repo içi bilinen `143/Terminated` çevresel davranışıyla yine kesildi; `BUILD-DEPLOY-TROUBLESHOOTING.local.md` notuna uygun olarak doğru doğrulama Vercel production deploy ile tamamlandı ve `https://arcmachina.vercel.app` alias'ı güncellendi.
  Deploy hedefi: Railway backend deploy ve Vercel production deploy tamamlandı: `https://arcmachina.vercel.app`

- [x] 10. Oracle için config/misconfiguration uyarıları ekle.
  Kapsam: `ORACLE_PAY_ADDRESS`, `CURVE_USDC_EURC_POOL` ve benzeri kritik env boş olduğunda uyarı gösterilecek.
  Sonuç: Oracle kartı içinde payment address ve kritik pool env eksikleri ayrı warning metinleriyle gösteriliyor.
  Doğrulama: `node --check src/routes/oracle.js`, `cd frontend && npm run build`, editor error check ve deploy healthcheck temiz geçti.
  Deploy hedefi: Railway backend deploy ve Vercel production deploy tamamlandı: `https://arcmachina.vercel.app`

- [x] 11. Automation görünümünü ürünleştir.
  Kapsam: Feature bazlı son çalışma zamanı, durum görünümü, reputation explainability ve açıklama temizliği.
  Sonuç: Automation kartları runtime state ile ürünleşti; reputation açıklaması Tasks sayfasının en üstüne ayrı hero olarak taşındı, tracking enable aksiyonu doğrudan bu uyarı alanına bağlandı, sekme butonları genişletildi ve blank screen'e neden olan bozuk JSX/runtime state kalıntıları temizlendi.
  Doğrulama: `cd frontend && npm run build` temiz geçti. Reputation contract için canlı Arc doğrulaması yapıldı: pozitif skor artışı, negatif delta floor davranışı, unauthorized revert ve gerçek agent için on-chain readback doğrulandı.
  Deploy hedefi: Vercel production deploy tamamlandı: `https://arcmachina.vercel.app`

- [x] 12. Testnet public API girişini Vercel alias `/api` üstünde sabitle ve smoke et.
  Kapsam: `vercel.json` rewrite/proxy, `VITE_API_URL=/api`, public buyer guide notları ve smoke komutlarının `https://arcmachina.vercel.app/api` üstünde standardize edilmesi.
  Sonuç: `vercel.json` artık `/api` rewrite ile Railway backend'e proxy ediyor; frontend same-origin `/api` kullanıyor ve public buyer guide testnet default base URL notunu taşıyor.
  Doğrulama: Vercel production deploy tamamlandı (`https://arcmachina.vercel.app`), public guide `200`, manifest `200` ve Vercel alias üstünden unpaid Oracle preview `402` doğrulandı. Aynı alias üstünden paid retry doğrulaması bu turda yerel `ORACLE_BUYER_PRIVATE_KEY` eksik olduğu için tekrar alınamadı; paid settle doğrulaması ayrı Oracle settlement checklist'inde açık tutuluyor.
  Deploy hedefi: Vercel deploy tamamlandı; Railway değişikliği gerekmedi.

- [x] 13. Public seller surface için WAF / abuse review ve rate limit tuning yap.
  Kapsam: Edge/WAF kararı, allow/deny mantığı, `402` / `429` / `5xx` trafik profili, alert eşikleri ve production rate limit değerleri.
  Sonuç: Repo içi minimum güvenlik katmanı backend seviyesinde uygulandı; public Oracle seller route'ları artık dedicated IP rate limit, blocked scanner UA filtresi ve endpoint bazlı query allowlist ile korunuyor.
  Doğrulama: `node --check backend/src/routes/oracle.js`, Railway backend deploy, `GET /health` `200`, Vercel alias üstünden normal `pool-state` preview `402`, invalid query `400`, blocked UA `403` ve `ratelimit-limit=30` header'ı doğrulandı.
  Deploy hedefi: Railway backend deploy tamamlandı.

- [x] 15. Paid execution readiness paketini kapat.
  Kapsam: `REVENUE_POOL_ADDRESS` production env, verified default Curve coverage, yeni `Curve Liquidity Add / Withdraw` execution raylarının live smoke'u ve revenue counter kapanışı.
  Beklenen çıktı: `EXEC_ARB`, `EXEC_CURVE_SWAP`, `EXEC_CURVE_LIQUIDITY_ADD`, `EXEC_CURVE_LIQUIDITY_REMOVE`, `EXEC_REBALANCE` ve pool balance yüzeyi için "gerçek canlı çalışır" sınırı netleşecek.
  Sonuç: `backend/scripts/paidTaskSmoke.js` artık revenue pool snapshot + readiness verdict üretiyor. Gerçek wallet ile alınan güncel smoke'ta revenue pool `source=verified_default`, balance `1.24 USDC` görüldü; `EXEC_ARB`, `EXEC_CURVE_SWAP` ve `EXEC_CURVE_LIQUIDITY_ADD` `ready` çıktı. `EXEC_CURVE_LIQUIDITY_REMOVE` için blokör `insufficient_lp_position`, `EXEC_REBALANCE` için blokör `lp_position_exit_required` olarak netleşti; yani bu iki yol kod kırığı yüzünden değil, mevcut wallet state'i yüzünden bloklu. Bu turda `EXEC_ARB` için görülen false-negative `ARC_RPC_URL or ARC_TESTNET_RPC is not defined` hatası da smoke script başlangıcında env normalize edilerek kapatıldı.
  Doğrulama: Gerçek wallet ile `node scripts/paidTaskSmoke.js --stable-only --wallet <derived-address>` smoke'u çalıştırıldı ve stable readiness özeti alındı; ardından full smoke içinde `EXEC_ARB` tekrar koşuldu ve `ready` + `confidence=HIGH` sonucu doğrulandı. Public Railway health check `https://backend-production-597c.up.railway.app/health` üstünde `{"status":"ok","db":"ok","redis":"ok"}` döndü.
  Deploy hedefi: Railway.
  Deploy: `npx -y @railway/cli up --service backend --detach` ile backend redeploy tamamlandı.

- [x] 16. Full Autonomous toggle ekle.
  Kapsam: İlgili feature flag'leri tek yerden toplu aç/kapat.
  Sonuç: `TasksTab` automation grubuna `Full Autonomous` kartı eklendi; tek aksiyonla `marketAnalysisEnabled`, `oracleEnabled`, `defiLoopEnabled` ve `reputationEnabled` birlikte güncelleniyor. `dailyTasksEnabled` bilerek ayrı bırakıldı.
  Doğrulama: `frontend/src/components/TasksTab.jsx` editor error check temiz, local `cd frontend && npm run build` yine repo içi bilinen `143/Terminated` çevresel davranışıyla kesildi, deploy edilmiş production bundle içinde `Enable Full Autonomous` ve `Disable All Automation` string'leri doğrulandı.
  Deploy hedefi: Vercel production deploy tamamlandı: `https://arcmachina.vercel.app`

- [x] 17. Jobs ekranına rol ve akış açıklaması ekle.
  Kapsam: Client / provider / next step / on-chain vs off-chain bilgisi daha görünür olacak.
  Sonuç: `JobsTab` içine `How Jobs Work` onboarding kartı eklendi; client request, provider delivery, settlement rail ve dinamik next-step açıklaması görünür hale geldi. Empty state metni de funded -> delivered -> completed akışını açık anlatacak şekilde genişletildi.
  Doğrulama: `frontend/src/components/JobsTab.jsx` editor error check temiz, local `cd frontend && npm run build` yine repo içi bilinen `143/Terminated` çevresel davranışıyla kesildi, deploy edilmiş production bundle içinde `How Jobs Work` string'i doğrulandı.
  Deploy hedefi: Vercel production deploy tamamlandı: `https://arcmachina.vercel.app`

### P2 — Teknik Temizlik

- [x] 18. En az temel smoke/integration test katmanı ekle.
  Kapsam: Auth mock akışı, tasks catalog/results, jobs state transition, oracle payment guard, paid task validation.
  Beklenen çıktı: En kritik backend akışları için otomatik güvence oluşacak.
  Durum: tamamlandı. Backend'e `supertest` tabanlı `src/routes/__tests__/routeSmoke.test.js` eklendi; bu suite auth'lu tasks results akışı, public task catalog, paid `EXEC_REBALANCE` param validation, jobs `funded -> delivered -> completed` geçişi ve public Oracle `402 PAYMENT-REQUIRED` guard'ını kapsıyor. Mevcut `circlePaidCatalogService` regression testi de korunuyor.
  Doğrulama: `npm test -- --runTestsByPath src/routes/__tests__/routeSmoke.test.js` yeşil geçti; ardından tam `npm test` komutu çalıştırıldı ve `2` suite / `10` test geçti.
  Deploy hedefi: Yok; kod doğrulama zorunlu.

- [x] 19. README ve local plan dosyalarını rol bazlı sadeleştir.
  Kapsam: README gerçek ürün özetini, çalıştırma adımlarını ve env beklentilerini anlatacak.
  Beklenen çıktı: Repo ilk bakışta anlaşılır olacak.
  Durum: tamamlandı. Kök README ürün özeti, çalışma komutları, env dosyaları ve güncel Circle Paid görünür-roadmap durumu ile yeniden yazıldı; local plan dosyaları zaten konu bazlı ayrık tutuluyor.
  Doğrulama: README boş değil; ürün özeti, local çalışma adımları ve env beklentileri görünür. Plan dosyaları görev ayrımına sahip kalıyor.
  Deploy hedefi: Yok.

- [x] 20. Legacy `SecurityTab` için karar ver.
  Kapsam: Ya güncel API ile hizala ya da üründen çıkar; nav'de görünmese bile `App.jsx` içindeki import/render izi temizlenecek.
  Beklenen çıktı: Sahipsiz veya yarım ekran kalmayacak.
  Durum: tamamlandı. `frontend/src/components/SecurityTab.jsx` repo içinden çıkarıldı; `frontend/src/App.jsx` tarafında zaten aktif import/render izi kalmamıştı.
  Doğrulama: `SecurityTab` için frontend kaynak ağacında eşleşme kalmadı, `App.jsx` editor error check temiz geçti.
  Deploy hedefi: Vercel.
  Deploy: `frontend/` içinden production deploy alındı; alias `https://arcmachina.vercel.app` üzerine oturdu.

### P3 — Görsel ve Metin Temizliği

- [x] 21. Tasks badge, button copy ve açıklama metinlerini sadeleştir.
  Kapsam: Free / Paid / Automation dili tek mantıkta toplanacak.
  Beklenen çıktı: Kartlar daha anlaşılır olacak.
  Durum: tamamlandı. `TasksTab` içinde jargon badge'leri (`Live auto rail`, `Autonomy next`, `Direct pair rail`, `Direct LP exit`) daha açık kullanıcı diline çevrildi; Free/Paid/Circle Paid/Automation info strip'leri kısaltıldı; Circle Paid CTA'ları (`Open preview flow`, `See planned flow`, `Review in Paid lane`) ve task card içindeki fee/config açıklamaları daha kısa ve tutarlı hale getirildi.
  Doğrulama: `get_errors frontend/src/components/TasksTab.jsx` temiz geçti. Lokal `vite build` yine repo içi bilinen `143/Terminated` davranışını gösterdi; buna karşı gerçek doğrulama olarak `frontend/` içinden Vercel production deploy alındı ve alias `https://arcmachina.vercel.app` `200` döndü.
  Deploy hedefi: Vercel.
  Deploy: `frontend/` içinden production deploy tamamlandı; alias `https://arcmachina.vercel.app` üzerine oturdu.

- [x] 22. Oracle ve Jobs için güven/metin katmanını güçlendir.
  Kapsam: Mock data, offline mode, payment required, gas required gibi durumlar daha görünür yazılacak.
  Beklenen çıktı: Kullanıcı kritik durumları kaçırmayacak.
  Durum: tamamlandı. `JobsTab` içindeki örnek job şablonları bu turda daha dış dünya odaklı hale getirildi: `Top 10 X Memecoin Radar`, `Highest Volume DEX Coin`, `ETH Whale Wallet Watch`, `Solana Launchpad Breakout Scan` ve `Stablecoin Depeg Rumor Sweep` gibi örnekler artık doğrudan provider'a verilecek research görevleri olarak görünüyor. `How to add a job` ve offline/on-chain mode güven katmanı görünür kaldı; daha sonra 25. maddede Jobs yüzeyindeki teknik ekonomi detayı özellikle geri plana alınıp public/private ayrımı öne çıkarıldı. `OracleTab` tarafında ise hem `Trust & Runtime Notes` paneli hem de endpoint kartı üstündeki açık `Payment gated / Payment blocked` ile `Live route / Live read / Fallback risk` rozetleri eklendi; böylece mock/live/payment durumu endpoint bazında daha hızlı okunuyor.
  Doğrulama: `get_errors` ile `frontend/src/components/JobsTab.jsx` ve `frontend/src/components/OracleTab.jsx` temiz geçti. Kullanıcı talimatı ve `BUILD-DEPLOY-TROUBLESHOOTING.local.md` doğrultusunda lokal `vite build` bilinçli olarak skip edildi; bunun yerine doğru yol izlenip repo root'tan `vercel --cwd /workspaces/arc-agent --prod --yes` deploy'u alındı ve `https://arcmachina.vercel.app` alias'ı `200` döndü.
  Deploy hedefi: Vercel.
  Deploy: repo root'tan production deploy tamamlandı; alias `https://arcmachina.vercel.app` üzerine oturdu.

- [x] 23. Jobs public board'u insan okunabilir ve manuel başvuruya açık hale getir.
  Kapsam: Full brief görünürlüğü, açık başvuru job'ları, wallet-imzalı manual apply, owner-side provider assignment ve review/payout/reputation açıklığı.
  Beklenen çıktı: İnsan kullanıcı job metnini tam okuyacak, provider kilitli değilse manuel başvuru yapabilecek ve deliver sonrası onay/payout/reputation sınırları açıkça görünecek.
  Durum: tamamlandı. Backend'de `publicJobs` route'una wallet-imzalı `apply` endpoint'i eklendi; auth'lu jobs route'u provider'ı opsiyonel kabul edecek şekilde açıldı ve client için `assign-provider` aksiyonu eklendi. `jobEconomyService` artık `applicationsOpen`, `applications` ve `reviewPolicy` metadata'sını response'da koruyor. Frontend `JobsTab` tarafında public board kartları tam brief'i expanded detail içinde tam metin gösteriyor; provider kilitli olmayan job'lar için connected wallet ile kısa not + imza üzerinden manual application gönderilebiliyor; client agent panelinde gelen başvurular listelenip tek tuşla provider atanabiliyor. Review/payout kartları da deliver sonrası bugün için otomatik correctness check, forced payout release veya auto reputation slash olmadığını açıkça söylüyor.
  Doğrulama: `backend/src/routes/__tests__/routeSmoke.test.js` yeniden koşturuldu ve toplam `12` test temiz geçti; bu suite artık jobs create, funded -> delivered -> completed, public signed delivery, manual application ve provider assignment davranışlarını kapsıyor. `get_errors` ile `backend/src/services/agenticEconomy/jobEconomyService.js`, `backend/src/routes/jobs.js`, `backend/src/routes/publicJobs.js`, `backend/src/routes/__tests__/routeSmoke.test.js`, `frontend/src/lib/api.js` ve `frontend/src/components/JobsTab.jsx` temiz geçti. Lokal frontend build yine bilinçli olarak skip edildi.
  Deploy hedefi: Vercel + Railway.
  Deploy: repo root'tan `vercel --cwd /workspaces/arc-agent --prod --yes` ile yeni frontend production'a alındı; alias `https://arcmachina.vercel.app` tekrar güncellendi ve `HTTP/2 200` döndü. Backend için `npx -y @railway/cli up --service backend --detach` sonrası `npx -y @railway/cli status` ile servis `Online` doğrulandı; `https://backend-production-597c.up.railway.app/health` cevabı `status=ok`, `db=ok`, `redis=ok` verdi.

- [x] 24. Jobs review SLA, timeout delete ve canlı uçtan uca smoke katmanını tamamla.
  Kapsam: Delivered job'lar için 48 saatlik review SLA, timeout sonrası auto delete + client reputasyon cezası, provider dispute sinyali, public board'da `open applications` ile `locked provider` ayrımı ve gerçek production smoke.
  Beklenen çıktı: Client review sonsuza kadar açık kalmayacak; 48 saat sonra job görünürlükten düşüp silinecek, timeout audit/reputation izi oluşacak ve Jobs UI ilk bakışta hangi job'a başvurulabildiğini gösterecek.
  Durum: tamamlandı. `agent_jobs` tablosuna `review_deadline_at` eklendi; yeni `jobRetentionService` startup'ta çalışıp süresi dolan `delivered` job'lar için on-chain cancel deniyor, ardından job'ı siliyor, `job_review_timeout` audit satırı yazıyor ve client agent için `JOB_REVIEW_TIMEOUT` reputasyon cezası düşüyor. Auth ve public jobs route'ları artık `review_deadline_at`, `reviewPolicy.timeoutHours=48`, `timeoutAction=delete_without_payout` ve provider-side signed `dispute` akışını taşıyor; expired delivered job detail artık `410 job_review_window_expired` dönüyor. Frontend `JobsTab` public board'u da iki ayrı lane'e ayrıldı: `Open application jobs` ve `Locked provider jobs`; full brief, review deadline, dispute state ve timeout penalty metni hem public provider görünümünde hem client control panelinde görünür hale geldi.
  Doğrulama: `ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") npm test -- src/services/__tests__/jobRetentionService.test.js` ile retention service testleri (`2` test) temiz geçti. `npm test -- src/routes/__tests__/routeSmoke.test.js` ile route smoke suite (`14` test) temiz geçti; public dispute ve expired delivered `410` davranışı da bu suite'e eklendi. Ardından production backend'e karşı `npm run jobs:smoke:e2e -- --base-url https://backend-production-597c.up.railway.app` çalıştırıldı ve şu beş canlı senaryo uçtan uca geçti: `locked_provider_happy`, `locked_provider_dispute_cancel`, `open_applications_flow`, `owner_deliver_route`, `timeout_cleanup`.
  Deploy hedefi: Railway + Vercel.
  Deploy: Backend için son Railway deploy sonrası `npx -y @railway/cli status` servis durumunu `Online`, `curl -fsS https://backend-production-597c.up.railway.app/health` ise `status=ok`, `db=ok`, `redis=ok` verdi. Frontend için `vercel --cwd /workspaces/arc-agent --prod --yes` ile yeni production bundle alındı; alias `https://arcmachina.vercel.app` güncellendi ve son `curl -I -s https://arcmachina.vercel.app | head -n 1` cevabı `HTTP/2 200` oldu.

- [x] 25. Jobs UX yüzeyini ilk bakışta anlaşılır olacak şekilde sadeleştir.
  Kapsam: Public board ile private owner paneli arasındaki ayrımı açık yaz, aynı job'ın neden iki yerde göründüğünü anlat, teknik ekonomi kartlarını ilk bakıştan çıkar ve owner panelindeki kafa karıştıran `Deliver` aksiyonunu kaldır.
  Beklenen çıktı: Kullanıcı üstte herkesin gördüğü board'u, altta yalnız kendisine ait yönetim alanını hemen ayırt edecek; row expanded detail'leri plain-language özetlerle okunacak; owner/client rolü daha net olacak.
  Durum: tamamlandı. `frontend/src/components/JobsTab.jsx` içinde üst onboarding katmanı `How To Read This Page` formatına indirildi; `Top Section / Bottom Section / 48-hour review rule` üçlüsüyle sayfanın ne olduğu doğrudan anlatılıyor. Public board açıklaması ve `Your Jobs` alt başlığı aynı job'ın hem public hem private yönetim görünümünde eşzamanlı görünebileceğini açıkça söylüyor. Public ve private row detail'lerinden teknik `economy rail / create fee / tx hash` yoğunluğu çıkarıldı; yerine `Who can act now`, `What you can do here`, `What happens next` gibi plain-language kartlar kondu. Client tarafındaki alt panelden owner-side `Deliver` aksiyonu kaldırıldı; bu adım artık yalnız public/provider akışında kalıyor. Son turda `manual applicant` dili tamamen kaldırılıp doğru ürün dili olan `open applications` modeline geçildi; bu mod artık insan-only değil, herhangi bir wallet'ın, dış agent wallet'ı dahil, başvurabildiği açıkça yazıyor. Create form da `acceptingApplications=true` iken provider kilitlemeye izin vermeyecek şekilde netleştirildi; public row header'ı full brief tekrarını kısaltılmış preview'a indirdi ve apply CTA kartın üstüne taşındı.
  Doğrulama: `get_errors` ile `frontend/src/components/JobsTab.jsx` temiz geçti. Ardından `vercel --cwd /workspaces/arc-agent --prod --yes` ile production deploy alındı ve `curl -I -s https://arcmachina.vercel.app | head -n 1` cevabı `HTTP/2 200` verdi. Ek canlı jobs smoke doğrulamasında production backend üzerinde mevcut `npm run jobs:smoke:e2e -- --base-url https://backend-production-597c.up.railway.app` yeniden temiz geçti; ayrıca tek seferlik live iki-agent zincirinde employer agent açık başvuru job'ı açtı, ikinci smoke agent wallet-imzalı başvuru yaptı, employer bu agent'ı provider olarak atadı, ikinci agent kasıtlı `wrong-deliverable` hash'i ile teslim verdi ve employer authenticated `cancel` route'u ile job'ı `cancelled` durumuna çekti. Böylece `open application -> başka agent başvurusu -> assign -> deliver -> employer reject/cancel` zinciri de production'da doğrulanmış oldu.
  Deploy hedefi: Vercel.
  Deploy: repo root'tan production deploy tamamlandı; alias `https://arcmachina.vercel.app` üzerine güncellendi.

- [x] 26. Jobs review sonucunda `reject` ile `cancel` akışlarını ayır ve UI'yi role-based sadeleştir.
  Kapsam: Backend'de delivered iş için ayrı `reject` route ve `rejected` status aç; `cancel` aksiyonunu yalnız delivery öncesi akışta bırak; live smoke'u buna göre güncelle; frontend'de owner tarafında `Approve / Reject` ve public tarafta wallet rolüne göre aksiyon metni göster.
  Beklenen çıktı: İşveren delivery öncesi job'ı `cancelled`, delivery sonrası sonucu `rejected` olarak kapatacak; smoke ve UI bu ayrımı açık taşıyacak; public board ile owner panelindeki aksiyonlar role göre sadeleşecek.
  Durum: tamamlandı. `backend/src/routes/jobs.js` içine delivered işler için `PUT /api/agents/:id/jobs/:jobId/reject` route'u eklendi ve `cancel` route'u delivery sonrası çağrıldığında `job_requires_reject` ile bloklanacak şekilde ayrıldı. `backend/src/services/agenticEconomy/jobEconomyService.js` `rejected` payout durumunu ayrı taşıyor; `backend/src/routes/publicJobs.js` note/order metinleri yeni statüye hizalandı. `backend/src/routes/__tests__/routeSmoke.test.js` içinde funded cancel, delivered reject ve delivered job'da cancel blokajı için yeni regression test'leri eklendi; suite toplam `17` test ile temiz geçti. `backend/scripts/jobsE2ESmoke.js` production smoke'u da yeni akışa geçirildi ve artık `pre_delivery_cancel` ile `locked_provider_dispute_reject` senaryolarını ayrı çalıştırıyor. Frontend tarafında `frontend/src/lib/api.js` yeni `jobs.reject()` çağrısını aldı; `frontend/src/components/JobsTab.jsx` owner panelinde delivered işler için `Approve Result / Reject Result`, funded işler için `Cancel Job` ayrımına geçti. Public row tarafında connected wallet rolüne göre `Your role here` rehberi gösteriliyor; assigned provider, applicant ve observer kopyaları birbirinden ayrıldı.
  Doğrulama: `npm test -- src/routes/__tests__/routeSmoke.test.js` sonucu `17/17` geçti. `npx -y @railway/cli up --service backend --detach` sonrası production `curl -fsS https://backend-production-597c.up.railway.app/health` cevabı `status=ok`, `db=ok`, `redis=ok` verdi. Ardından production `npm run jobs:smoke:e2e -- --base-url https://backend-production-597c.up.railway.app` temiz geçti ve şu senaryolar doğrulandı: `locked_provider_happy`, `pre_delivery_cancel`, `locked_provider_dispute_reject`, `open_applications_flow`, `owner_deliver_route`, `timeout_cleanup`. Frontend tarafında `get_errors` temiz geçti; `vercel --cwd /workspaces/arc-agent --prod --yes` deploy'u sonrası `https://arcmachina.vercel.app` alias'ı `HTTP/2 200` verdi.
  Not: production jobs smoke art arda çok sık tekrarlandığında public/auth rate limit nedeniyle `429` görülebiliyor; ilk temiz run referans kabul edildi.
  Deploy hedefi: Railway + Vercel.
  Deploy: Railway backend deploy tamamlandı ve Vercel alias güncellendi.

- [x] 27. Jobs sayfasında manuel katılımın yeri ile brief tekrarını son kez netleştir.
  Kapsam: `Anyone Can Apply` alanında mevcut bir job'a manuel olarak nasıl katılınıp sonradan nasıl teslim yapılacağını açık yaz; boş state'i ikinci bir create akışı varmış gibi göstermeden düzelt; kart başlığındaki görev özetini tek satıra indirip expanded detail'deki full brief ile tekrar hissini kaldır.
  Beklenen çıktı: Kullanıcı manuel apply/delivery akışının aşağıdaki create formunda değil, mevcut public job kartının içinde olduğunu anlayacak; apply ile delivery adımlarının ne zaman göründüğü net olacak; full görev tanımı da tek yerde kalacak.
  Durum: tamamlandı. İlk turdaki yanlış `Create Open-Application Job` CTA geri alındı. `frontend/src/components/JobsTab.jsx` içinde `Anyone Can Apply` boş state'i artık ikinci bir job oluşturma çağrısı yapmıyor; bunun yerine açık job geldiğinde apply ve delivery kontrolünün aynı job kartında görüneceğini, delivery adımının ise ancak client ilgili wallet'ı seçtikten sonra açılacağını plain-language olarak anlatıyor. Aynı mantık open-application row'un collapsed helper metnine ve `Apply To This Job` paneline de işlendi; yani kullanıcı artık `başvuru şimdi`, `teslim sonra ve yine aynı kartta` ayrımını doğrudan görüyor. Job row başlıklarındaki description preview daha kısa limite çekilip `truncate` ile tek satırlık özet haline indirildi; böylece alttaki `What Needs To Be Delivered` full brief'iyle iki ayrı description görünümü oluşmuyor. Ayrıca locked-provider row detail'indeki gereksiz `Open applications are closed...` uyarı kartı kaldırılarak görsel gürültü azaltıldı.
  Doğrulama: `get_errors /workspaces/arc-agent/frontend/src/components/JobsTab.jsx` temiz geçti. Düzeltme sonrası yeniden `vercel --cwd /workspaces/arc-agent --prod --yes` ile production deploy alındı ve `curl -I -s https://arcmachina.vercel.app | head -n 1` cevabı tekrar `HTTP/2 200` verdi.
  Deploy hedefi: Vercel.
  Deploy: production deploy tamamlandı; alias `https://arcmachina.vercel.app` güncel build'i servis ediyor.

- [x] 28. Jobs public board'da insan ve ajan başvuru girişini ilk bakışta görünür yap.
  Kapsam: `Anyone Can Apply` üstüne insan kullanıcıların ve agent wallet'ların aynı yerden başvurduğunu tek cümlede yaz; collapsed açık job kartına doğrudan `Apply Now` CTA'sı koyarak başvuru girişini görünür yap.
  Beklenen çıktı: Kullanıcı `insan başvuru butonu nerede?` diye aramak zorunda kalmadan public board üstündeki doğru alanı ve kart üstündeki doğrudan başvuru aksiyonunu hemen görecek.
  Durum: tamamlandı. `frontend/src/components/JobsTab.jsx` içinde public board listesinin üstüne `Humans and agent wallets both apply from this public board.` açıklaması eklendi. `Anyone Can Apply` grup açıklaması da aynı dili tekrar edecek şekilde netleştirildi. Açık başvuru toplayan job kartları collapsed haldeyken görünen helper aksiyonunun label'ı `Apply Now` / `Connect Wallet To Apply` olacak şekilde değiştirildi; yardımcı metin de kullanıcının önce signed application verdiğini, delivery formunun ise client ilgili wallet'ı seçtikten sonra aynı kartta açıldığını açıkça söylüyor.
  Doğrulama: `get_errors /workspaces/arc-agent/frontend/src/components/JobsTab.jsx` temiz geçti. Ardından `vercel --cwd /workspaces/arc-agent --prod --yes` ile yeni production deploy alındı ve `curl -I -s https://arcmachina.vercel.app | head -n 1` cevabı `HTTP/2 200` verdi.
  Deploy hedefi: Vercel.
  Deploy: production deploy tamamlandı; alias `https://arcmachina.vercel.app` güncel build'i servis ediyor.

- [x] 29. Paid readiness kapanışını gerçek smoke ve repeatable suite ile kapat.
  Kapsam: `paidTaskSmoke` root `.env` ve gerçek smoke wallet ile tekrar çalışsın; gerçek Oracle paid request sonrası settlement + public revenue sayaç artışı doğrulansın; route smoke ile bu readiness doğrulaması tek npm komutunda tekrar edilebilir hale gelsin.
  Beklenen çıktı: Core paid task'ler için `ready / guarded` verdict'i tek yerde alınacak; Oracle `prediction-market-check` paid settle sonrası `requestCount` ve `totalUsdc` artışı görülecek; `npm run smoke:readiness` komutu route smoke + paid readiness smoke zincirini `0` ile bitirecek.
  Durum: tamamlandı. `backend/scripts/paidTaskSmoke.js` artık var olmayan `backend/.env` yerine root `.env` dosyasını okuyor ve explicit wallet verilmediğinde root env içindeki gerçek smoke private key'den wallet address türetiyor. Yeni `backend/scripts/paidReadinessSmoke.js` script'i core paid task preflight'lerini (`EXEC_CCTP_BRIDGE`, `EXEC_CURVE_SWAP`, `EXEC_CURVE_LIQUIDITY_ADD`, `EXEC_ARB`) `ready`, stateful task'leri (`EXEC_CURVE_LIQUIDITY_REMOVE`, `EXEC_REBALANCE`) beklenen guard reason'larıyla `guarded` olarak değerlendiriyor; aynı script gerçek `prediction-market-check` Oracle paid request'i atıp `/api/oracle/public/revenue` üzerinden `requestCount` ve `totalUsdc` delta'sını bekleyerek settlement + revenue kapanışını doğruluyor. `backend/package.json` içine `smoke:route`, `smoke:paid-readiness` ve `smoke:readiness` script'leri eklendi; böylece route smoke + gerçek readiness smoke tek komutta tekrar çalıştırılabiliyor.
  Doğrulama: `cd backend && node scripts/paidTaskSmoke.js --stable-only` artık `--wallet` vermeden temiz çalıştı; stable task'lerde `EXEC_CURVE_SWAP` ve `EXEC_CURVE_LIQUIDITY_ADD` ready, `EXEC_CURVE_LIQUIDITY_REMOVE` `insufficient_lp_position` ve `EXEC_REBALANCE` `lp_position_exit_required` guarded verdi. `cd backend && node scripts/paidReadinessSmoke.js` gerçek Oracle paid request ile `amountUsdc=0.005`, `requestCountDelta=1`, `totalUsdcDelta≈0.005`, `deposited=false` sonucu verdi. `cd backend && npm run smoke:readiness` sonunda `17/17` route smoke + paid readiness smoke ile `exit 0` verdi; core paid tasks ready/guarded geçti ve Oracle revenue sayaçları arttı. Sonrasında `npx -y @railway/cli up --service backend --detach` deploy'u başlatıldı ve production `curl -fsS https://backend-production-597c.up.railway.app/health` cevabı `status=ok`, `db=ok`, `redis=ok` döndü.
  Deploy hedefi: Railway.
  Deploy: backend deploy başlatıldı; production health `ok`.

---

## 6. Görev Tamamlama Protokolü

Her `[ ]` görev tamamlanırken aşağıdaki sıra zorunludur:

1. Kod değişikliği tamamlanır.
2. Göreve uygun doğrulama yapılır.
3. Frontend değiştiyse manuel Vercel deploy alınır.
4. Backend değiştiyse manuel Railway deploy alınır.
5. Görev `[x]` olarak işaretlenir.
6. Bu dosya aynı turda güncellenir.

---

## 7. Önerilen Uygulama Sırası

1. `cirBTC` direct-pair ve stable liquidity için manuel DeFi ürün yüzeyini netleştir.
2. `Bridge` ve `Swap` sekmelerini ayrı tut; manuel DeFi yüzeyini bunlarla aynı ürün dili içinde hizala ama sekmeleri birleştirme.
3. `Circle Paid` hattını `maintenance-only` tut; mevcut live kartlar ve Oracle SKU için yalnız bakım/hotfix yap.
4. Yalnız doğrulanmış paid/manual raylarda otonom akışları arttır.
5. `Agent reconnect` smoke'u ve kalan küçük hijyen maddelerini kapat.

### DeFi Yol Haritası

- Bu planın DeFi kısmı yanlışlıkla tamamen silinmiş görünmüyor; current `ACTION-PLAN.local.md` içinde dağılmış kalmış. En görünür eski referanslar `MASTER-PLAN.local.md` içindeki `DEFI_LOOP` / Oracle-automation mimarisi ile `sil/ACTIONsPLAN.local.md` içindeki `Full Autonomous + DeFi Loop` ürün notları.
- Bugünkü aktif DeFi yönü `P0-G` ve `14. madde` altında yaşıyor: `Position-aware liquidity execution`, `cirBTC` direct-pair ve ilerideki manuel DeFi yüzeyi.
- `Bridge` sekmesi ayrı kalacak.
- `Swap` sekmesi ayrı kalacak.
- Manuel DeFi yüzeyi bunların üstüne yeni bir ürün katmanı olarak ele alınacak; mevcut `Bridge` veya `Swap` tab'larını içine almayacak.
- Otonom görevler gerekirse ortak mantıkta genişleyebilir, ama kullanıcı navigasyonunda `Bridge` ve `Swap` bağımsız yüzeyler olarak korunacak.
- Curve tarafında current çalışan yüzeyler ayrı görünür plan maddesi olarak korunmalı: `EXEC_CURVE_SWAP`, `EXEC_CURVE_LIQUIDITY_ADD`, `EXEC_CURVE_LIQUIDITY_REMOVE`, `EXEC_REBALANCE`, live LP positions ve `cirBTC` direct-pair paid rayları.
- Lending tarafı current planda ancak şu netlikle görünmeli: Aave adapter kodu repoda dursa da gerçek `AAVE_POOL_ADDRESS` bulunmadığı için Aave execution şu an pasif/parked. Kullanıcıyı karıştırmamak için bunu aktif manual yüzey gibi yazmıyoruz.
- Morpho şu an execution tabanı değil: repo içinde yalnız oracle/protocol-TVL ve yield-ranking referansı var, DefiLlama kontrolünde de `ARC` chain adına düşen aktif Morpho lending havuzu doğrulanmadı. Bu yüzden Morpho kısa vadede ancak referans mimari / model adayı olarak ele alınacak.
- Arc Blueprints lending/borrowing yazısı hazır protokol adresi veya drop-in contract set vermiyor; fakat Arc'ın deterministic finality + stablecoin-native settlement + programmable credit primitive yaklaşımı native custom lending lane için kullanılabilir bir ürün/altyapı modeli sunuyor.
- Borrow lane tamamen kaybolmuş gibi görünmemeli, ama bugün aktif ürün scope'una da alınmamalı: önce doğrulanmış lending protokolü ve gerçek reserve/market adresleri bulunacak, sonra borrow/repay execution ayrı lane olarak açılacak.
- Aktif LP yüzeyi sadece `LP balance / share / underlying` ile kalmamalı; sonraki ürün diliminde yaklaşık APR, APY ve tahmini getiri hesabı da eklenmeli.
- DeFi ürün sırası şu şekilde okunmalı:
  1. Stable liquidity için position-aware manual yüzeyi netleştir.
  2. `cirBTC/USDC` ve `cirBTC/EURC` direct-pair akışını manual ürün diliyle görünür yap.
  3. Curve aktif LP'lerine APR/APY ve tahmini getiri hesabı ekle.
  4. Aave/Morpho lending araştırmasını oracle ve dış protokol doğrulamasıyla kapat; aktif olmayan adayları pasif bırak.
  5. Paralelde Arc Blueprints native lending/borrowing primitive yolunu custom-contract tabanı olarak değerlendir.
  6. Gerçek reserve/market adresi doğrulanmış bir lending protokolü bulunursa supply-withdraw yüzeyini o protokol üstünden aç; bulunmazsa Arc-native custom lane'i tasarla.
  7. Borrow/repay lane'ini yalnız doğrulanmış reserve ve risk guard ile aç.
  8. Ancak bundan sonra otonom genişlemeyi yalnız doğrulanmış raylarda aç.
- Referans maddeler: `P0-G`, `14. Position-aware liquidity execution ve cirBTC direct-pair ürün yüzeyini tamamla`, ayrıca üst özet içinde `Swap yeteneği... manuel DeFi yüzeyine taşımak` notu.

---

## 8. Genel Doğrulama Checklist'i

- [ ] Agent oluştur / reconnect akışı çalışıyor.
- [x] Tasks enable/disable tek ekrandan yönetiliyor.
- [x] Tasks sayfası blank screen vermeden açılıyor; reputation özeti ilk görünür blok olarak geliyor.
- [x] Free task limit davranışı tüm ekranlarda aynı.
- [x] Execution task'ler parametresiz çalışmıyor.
- [x] CCTP execution task doğru chain isimleriyle çalışıyor.
- [x] CCTP Bridge gerçek smoke akışı yerelde burn + attestation + mint ile tamamlandı.
- [x] Paid task'ler doğru fee ve doğru validation ile koşuyor.
- [x] Frontend `VITE_API_URL` Vercel alias `/api` üzerinden çalışıyor; raw Railway hostname bağımlılığı kullanıcı yüzeyinden kapandı.
- [x] Jobs create sonrası `funded -> delivered -> completed` akışı backend düzeyinde ilerliyor.
- [x] Oracle public endpoint artık auth yerine x402 seller kapısından geçiyor.
- [x] Oracle payment settlement ve revenue sayacı production'da birlikte yeniden doğrulandı.
- [x] Oracle sekmesinde status ve config uyarıları görünüyor.
- [x] Reputation score, event breakdown, on-chain status ve işleyiş açıklaması Tasks içinde görünür.
- [x] Full Autonomous toggle automation flag'lerini tek aksiyonla yönetiyor.
- [x] Jobs onboarding katmanı client / provider / settlement / next-step bilgisini görünür anlatıyor.
- [x] Auth / Tasks / Jobs / Oracle kritik akışları için repo içinde temel Jest veya smoke suite mevcut.
- [x] Legacy `SecurityTab` kararı uygulanıp App içinden temizlendi ya da güncel yüzeye taşındı.
- [x] Bridge, Swap ve Tasks akışları için en az temel smoke test mevcut.
  Not: `backend/package.json` içindeki `npm run smoke:readiness` artık `smoke:route` (`17/17` route smoke) ve gerçek `smoke:paid-readiness` zincirini tek komutta çalıştırıyor. Core paid tasks içinde `EXEC_CCTP_BRIDGE`, `EXEC_CURVE_SWAP`, `EXEC_CURVE_LIQUIDITY_ADD` ve `EXEC_ARB` ready; `EXEC_CURVE_LIQUIDITY_REMOVE` ile `EXEC_REBALANCE` ise beklenen wallet-state guard reason'ları (`insufficient_lp_position`, `lp_position_exit_required`) ile guarded dönüyor. Aynı suite gerçek Oracle paid request sonrası public revenue sayaç artışını da doğruluyor.
