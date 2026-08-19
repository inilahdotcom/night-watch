# Brief: Night Watch — sistem monitoring & alerting

Bangun sistem monitoring yang mengirim alert ke **push notification browser** dan **grup WhatsApp** ketika terjadi salah satu dari:

1. Traffic melonjak atau anjlok di luar kebiasaan (sumber: Cloudflare Analytics dan/atau Google Analytics 4)
2. Website tidak bisa diakses
3. Muncul pola yang mengindikasikan serangan DDoS

Stack: **TanStack Start + shadcn/ui + TypeScript**. Semua dependensi harus berlisensi open source (OSI-approved).

---

## 0. Sebelum menulis kode apa pun

Pengetahuan model tentang TanStack Start kemungkinan besar sudah usang — framework ini pindah dari Vinxi ke Vite di pertengahan 2025, nama paketnya berubah dari `@tanstack/start` ke `@tanstack/react-start`, dan v1.0 baru rilis Maret 2026. **Jangan mengandalkan ingatan.** Lakukan ini dulu:

1. Baca `https://tanstack.com/start/latest/docs/framework/react/overview` dan halaman _server functions_, _server routes_, serta _hosting/deployment_.
2. Baca `https://ui.shadcn.com/docs/installation/tanstack`.
3. Baru scaffold proyek dengan CLI resmi yang berlaku saat ini.

Kalau ada perbedaan antara dokumen ini dan dokumentasi resmi soal API framework, **dokumentasi resmi yang menang**. Yang tidak boleh diubah tanpa bertanya adalah keputusan arsitektur dan logika deteksi di bawah.

---

## 1. Kendala keras

Ini bukan preferensi. Melanggar salah satunya membuat sistem tidak berfungsi.

**Harus berjalan di runtime Node.js persisten.** Bukan serverless, bukan edge, bukan Cloudflare Workers. Alasannya: koneksi WhatsApp adalah WebSocket yang harus hidup terus-menerus, dan penjadwal harus berjalan di antara request. Gunakan preset deployment **`node-server`**. Kalau nanti ada godaan untuk deploy ke Vercel/Workers, tolak dan jelaskan alasannya.

**WhatsApp grup hanya bisa lewat Baileys.** WhatsApp Cloud API resmi dari Meta tidak bisa mengirim ke grup sama sekali — hanya ke nomor individual. Satu-satunya jalur open source untuk grup adalah `@whiskeysockets/baileys` (MIT), yang berbicara langsung dengan protokol WhatsApp Web. Ini pustaka tidak resmi; rancang lapisan pengirim sebagai interface `NotificationChannel` supaya bisa ditukar ke Telegram/Slack tanpa membongkar sisa sistem.

**Push notification butuh HTTPS** kecuali di `localhost`. Catat ini di README.

**Semua dependensi harus open source.** Sebelum menutup pekerjaan, jalankan pemeriksaan lisensi (`pnpm licenses list` atau `license-checker`) dan tulis tabel hasilnya di README. Kalau ada dependensi yang lisensinya bukan MIT/ISC/Apache-2.0/BSD/MPL-2.0, laporkan ke saya sebelum melanjutkan.

---

## 2. Arsitektur: dua proses, satu repo

Ini keputusan yang paling penting dan paling mudah salah.

Godaannya adalah menaruh cron di dalam aplikasi TanStack Start. **Jangan.** Aplikasi web bisa di-restart, di-hot-reload, dan di-scale ke beberapa instance; kalau penjadwal ikut di dalamnya, prober akan berjalan ganda, alert terkirim dobel, dan sesi WhatsApp saling berebut file auth. Pisahkan:

```
night-watch/
├── apps/
│   ├── web/          TanStack Start — dashboard + server functions. Hanya MEMBACA data.
│   └── worker/       Proses Node biasa — collector, detector, alerting. Satu-satunya PENULIS.
├── packages/
│   └── core/         Skema DB, config, logika deteksi, kanal notifikasi. Dipakai keduanya.
├── pnpm-workspace.yaml
└── docker-compose.yml
```

Gunakan **pnpm workspaces** dan TypeScript project references.

### Bagaimana dua proses ini berkomunikasi

Lewat satu file SQLite bersama. Tanpa Redis, tanpa message queue, tanpa HTTP internal.

- SQLite dalam mode **WAL** dengan `busy_timeout = 5000`. WAL mengizinkan banyak pembaca bersamaan dengan satu penulis — persis pola yang kita butuhkan.
- **web → worker** lewat tabel outbox `commands`. Web menyisipkan baris (`test_alert`, `wa_relink`), worker melakukan polling tiap 2 detik, mengeksekusi, lalu menandai selesai. Tidak perlu membuka port internal.
- **worker → web** lewat tabel `system_state` (key-value). Worker menulis status koneksi WhatsApp, string QR yang sedang menunggu dipindai, dan waktu siklus terakhir. Web tinggal membacanya.

Kalau kamu merasa ada pendekatan yang lebih baik, sampaikan alasannya dulu sebelum mengubah.

---

## 3. Stack

| Kebutuhan     | Pilihan                                       | Catatan                                                         |
| ------------- | --------------------------------------------- | --------------------------------------------------------------- |
| Framework web | `@tanstack/react-start`                       | preset deploy `node-server`                                     |
| UI            | shadcn/ui + Tailwind v4                       | komponen di-_copy in_, bukan dependensi — silakan edit langsung |
| Data fetching | TanStack Query                                | polling 20 detik, `refetchOnWindowFocus`                        |
| Database      | SQLite via `better-sqlite3`                   | native, hanya jalan di Node                                     |
| ORM & migrasi | Drizzle ORM + drizzle-kit                     | skema di `packages/core`, dipakai kedua proses                  |
| Penjadwal     | `croner`                                      | kolom detik cron hanya 0–59, lihat jebakan di §9                |
| Push          | `web-push` (VAPID)                            | MPL-2.0, tetap OSI                                              |
| WhatsApp      | `@whiskeysockets/baileys` + `qrcode-terminal` |                                                                 |
| GA4           | `@google-analytics/data`                      | Realtime API                                                    |
| Cloudflare    | `fetch` biasa ke GraphQL Analytics API        | tidak perlu SDK                                                 |
| Logging       | `pino` (+ `pino-pretty` saat dev)             |                                                                 |
| Validasi env  | `zod`                                         | gagal cepat saat boot, jangan `undefined` merembes              |
| Test          | `vitest`                                      |                                                                 |

---

## 4. Skema data

Definisikan dengan Drizzle di `packages/core/src/db/schema.ts`.

**`metrics`** — deret waktu. Primary key gabungan `(monitor, source, metric, bucketTs)`, `WITHOUT ROWID`, upsert idempoten. Kolom `value` real. Index pada `(monitor, metric, bucketTs DESC)`.
Nama metrik: `cf_requests`, `cf_bytes`, `cf_threats`, `cf_status_5xx`, `cf_status_4xx`, `cf_status_429`, `cf_cache_miss`, `ga_active_users`, `ga_page_views`, `latency_ms`, `up`.

**`alerts`** — state machine. `fingerprint`, `monitor`, `type`, `severity` (`critical|warning|info`), `status` (`firing|resolved`), `title`, `body`, `meta` (JSON), `startedAt`, `lastNotifiedAt`, `notifyCount`, `resolvedAt`.
**Wajib**: unique partial index `ON alerts(fingerprint) WHERE status = 'firing'`. Ini yang secara struktural mencegah satu masalah tercatat dua kali.

**`pushSubscriptions`** — `endpoint` (unique), `p256dh`, `auth`, `label`, `createdAt`, `lastOkAt`, `failCount`.

**`probeState`** — per monitor: `consecutiveFail`, `consecutiveOk`, `isDown`, `lastCheckAt`, `lastStatus`, `lastLatencyMs`, `lastError`.

**`deliveries`** — audit pengiriman: `alertId`, `channel`, `status`, `detail`, `createdAt`.

**`commands`** — outbox web→worker: `id`, `kind`, `payload` (JSON), `status` (`pending|done|failed`), `createdAt`, `processedAt`, `error`.

**`systemState`** — key-value: `key`, `value` (JSON), `updatedAt`.

Konfigurasi runtime (daftar situs, ambang batas) tetap di file `config/monitors.json` yang divalidasi zod, **bukan** di database — supaya bisa masuk version control dan di-review lewat PR.

---

## 5. Logika deteksi — bagian paling substantif

Bagian tersulit dari sistem alert bukan mendeteksi masalah, tapi **tidak membangunkan orang tanpa alasan**. Tulis semua ini sebagai fungsi murni di `packages/core/src/detectors/`, tanpa I/O, supaya bisa diuji tanpa database.

### 5.1 Baseline musiman

Ambang statis seperti "alert kalau request < 1000" pasti gagal: pukul 03.00 memang sepi. Sebagai gantinya:

- Bucket berdurasi 5 menit (`bucketSeconds`, bisa dikonfigurasi).
- Untuk menilai bucket pada waktu T, kumpulkan nilai pada `T - 1 minggu`, `T - 2 minggu`, ... sampai `baselineWeeks` (default 4), masing-masing plus-minus satu bucket sebagai toleransi. Jadi pukul 14.00 Selasa dibandingkan dengan pukul 14.00 Selasa sebelumnya.
- Kalau sampel yang terkumpul < `minSamples`, jatuh ke fallback: jendela bergerak 3 jam terakhir, tidak termasuk bucket yang sedang dinilai. Lebih berisik, tapi sistem tetap berfungsi di hari pertama pemasangan.

### 5.2 Median dan MAD, bukan rata-rata dan standar deviasi

Kalau minggu lalu ada insiden, rata-rata ikut tercemar dan ambangnya melar diam-diam. Median absolute deviation tahan terhadap pencilan.

```
z = 0.6745 × (nilai − median) / MAD
```

**Kasus tepi yang wajib ditangani**: MAD bisa bernilai 0 kalau lebih dari separuh sampel identik — umum pada traffic rendah (deretan nol). Kalau MAD = 0, turun ke rata-rata simpangan absolut; kalau itu pun 0, pakai lantai `max(1, median × 0.1)`. Tanpa penanganan ini pembagiannya menghasilkan `Infinity` dan setiap bucket jadi alert.

### 5.3 Tiga penjaga terhadap alarm palsu

Sebuah penyimpangan baru menjadi alert kalau **semua** terpenuhi:

1. `|z| ≥ spikeZ` (default 3.5)
2. Baseline-nya cukup besar untuk layak diributkan: `median ≥ minBaseline` (default 50)
3. Perubahan relatifnya cukup besar: `|Δ relatif| ≥ minRelativeChange` (default 0.4)

Penjaga kedua dan ketiga adalah yang membedakan sistem yang dipakai orang dari sistem yang notifikasinya dimatikan setelah tiga hari. Naik dari 8 ke 20 pengunjung bisa saja signifikan secara statistik, tapi itu bukan insiden.

Ditambah **konfirmasi berturut-turut**: penyimpangan harus bertahan `consecutiveBuckets` periode (default 2) sebelum jadi alert. Riak sesaat lewat begitu saja.

### 5.4 Uptime

Probe HTTP tiap 60 detik. Gagal kalau: timeout, status ≥ `expectStatusBelow`, atau `expectText` tidak ditemukan di halaman (ini menangkap halaman error yang tetap berstatus 200 — kasus yang sering lolos).

**Penjaga khusus**: sebelum menyatakan situs mati, uji dulu koneksi keluar server monitor sendiri ke `CONTROL_URL`. Kalau itu pun gagal, yang bermasalah adalah server monitor — abaikan hasilnya, jangan kirim alert. Tanpa ini, satu gangguan jaringan di sisi monitor akan mengirim alert "semua situs mati" sekaligus.

Butuh `failThreshold` kegagalan berturut-turut (default 3) untuk `DOWN`, dan `recoverThreshold` keberhasilan (default 2) untuk pulih. Respons lambat (`slowResponseMs`) jadi alert `warning` terpisah — sering merupakan peringatan dini menjelang mati.

### 5.5 Skor DDoS

Tidak ada satu metrik pun yang bisa menyatakan "ini serangan". Pakai skor gabungan dari sinyal Cloudflare dalam satu bucket:

| Sinyal                                                        | Bobot                     |
| ------------------------------------------------------------- | ------------------------- |
| Volume request ≥ `spikeZ` di atas normal                      | 2 (3 kalau ≥ 2× `spikeZ`) |
| ≥ `threatRatioCrit` (35%) request diblokir/ditantang firewall | 3                         |
| ≥ `threatRatioWarn` (15%) request dimitigasi firewall         | 2                         |
| Origin mengembalikan ≥ `errorRatio` (10%) status 5xx          | 2                         |
| Cache miss ≥ 70% **bersamaan dengan** lonjakan volume         | 2                         |
| ≥ 5% request kena rate limit (429)                            | 1                         |

`warning` pada skor ≥ 3, `critical` pada skor ≥ 5. Diamkan sama sekali kalau total request < `minRequests` (default 300).

Perhatikan bahwa lonjakan volume sendirian hanya bernilai 2 dan tidak cukup memicu apa pun — itu bisa saja kampanye marketing yang berhasil. Yang membedakan serangan adalah lonjakan **bersamaan dengan** firewall sibuk, origin mulai 5xx, dan cache miss meroket. Cache miss tinggi saat traffic melonjak adalah pola khas cache-busting: penyerang meminta URL acak supaya menembus cache dan membebani origin.

Untuk menyatakan aman kembali, butuh 3 periode bersih berturut-turut.

Alert `critical` harus menyertakan saran tindakan: aktifkan "Under Attack Mode" di dashboard Cloudflare.

---

## 6. Mesin alert

Satu modul dengan dua fungsi publik: `raiseAlert(input)` dan `resolveAlert(fingerprint, payload)`. Keduanya **idempoten** — aman dipanggil tiap siklus.

- `raiseAlert` untuk fingerprint yang sudah `firing`: perbarui detailnya saja, jangan kirim notifikasi. Ini yang menjaga grup WhatsApp tidak dibanjiri pesan identik tiap lima menit selama insiden berlangsung.
- Kirim ulang hanya kalau: severity `critical` **dan** `ALERT_COOLDOWN_MINUTES` sudah lewat, atau terjadi eskalasi dari `warning` ke `critical`.
- `resolveAlert` menutup alert dan (kalau `ALERT_NOTIFY_ON_RESOLVE`) mengirim notifikasi pemulihan **ke kanal yang sama dengan alert aslinya** — orang yang dikabari saat rusak harus dikabari saat sudah beres.
- Jam tenang (`QUIET_HOURS`, mis. `22:00-07:00`) membungkam WhatsApp untuk alert non-kritis; push tetap jalan. **Alert `critical` menembus jam tenang.** Situs mati tetap membangunkan orang.
- Catat setiap percobaan pengiriman ke tabel `deliveries`, berhasil maupun gagal.

### Kanal

Interface bersama:

```ts
interface NotificationChannel {
  readonly name: string;
  isReady(): boolean;
  send(alert: RenderedAlert): Promise<DeliveryResult>;
}
```

**Push**: payload JSON ke service worker. Hapus permanen langganan yang mengembalikan HTTP 404/410 — itu artinya browser sudah membuangnya. `requireInteraction: true` untuk alert kritis supaya tidak hilang sendiri dari layar.

**WhatsApp**: format teks polos, bold dengan `*asterisk*`, waktu dalam WIB. Beri jeda ~1,2 detik antar pesan. Kalau socket sedang terputus, **antrekan** pesan (maksimal 50) dan kirim saat tersambung kembali — jangan dibuang. Reconnect dengan backoff eksponensial dibatasi 60 detik. Kalau `DisconnectReason.loggedOut`, jangan coba lagi: tulis ke `systemState` bahwa perlu pemindaian QR ulang.

---

## 7. Aplikasi web (TanStack Start + shadcn/ui)

### Server functions

Semua akses data lewat server functions (`createServerFn`), bukan REST route — supaya tipenya menyambung ujung ke ujung. Yang dibutuhkan:

`getStatus` · `getActiveAlerts` · `getAlertHistory` · `getSeries(monitor, metric, hours)` · `getSystemHealth` · `subscribePush` · `unsubscribePush` · `enqueueCommand`

**Aplikasi web tidak boleh menulis ke tabel selain `pushSubscriptions` dan `commands`.** Tegakkan lewat modul akses data terpisah, bukan sekadar konvensi.

### Halaman

Satu halaman utama sudah cukup. Isinya, berurutan:

1. **Vonis** — satu kalimat besar yang menjawab "ada masalah atau tidak" tanpa perlu membaca apa pun di bawahnya. Ditemani indikator berdenyut yang lajunya mengikuti keparahan.
2. **Tombol notifikasi** — daftar/berhenti langganan push. Tangani ketiga status izin (`default`, `granted`, `denied`) dengan pesan yang berbeda; kalau `denied`, beri tahu cara membukanya lewat ikon gembok di address bar.
3. **Sedang berlangsung** — alert aktif.
4. **Yang dipantau** — kartu per monitor.
5. **Riwayat** — 25 kejadian terakhir.
6. Kalau WhatsApp menunggu QR, tampilkan QR-nya di dashboard (render dari string di `systemState`) supaya tidak perlu buka terminal.

### Arahan desain

Halaman ini dibuka lewat ponsel jam 2 pagi oleh orang yang baru bangun. Prioritasnya: satu vonis yang terbaca dalam satu detik.

Ambil karakter dari dunia subjeknya — panel instrumen ruang kendali, bukan dashboard SaaS generik. Palet gelap petrol (`#0C1418` latar, `#131F25` panel), sian `#56C8D8` sebagai aksen sinyal, dengan hijau/amber/merah hanya untuk status. Angka dan label teknis pakai monospace; teks biasa pakai sans. **Jangan muat font dari CDN eksternal** — halaman status harus tetap tampil justru ketika jaringan sedang bermasalah, dan itu alasan teknis yang nyata, bukan preferensi.

**Elemen tanda tangan: pita denyut.** Tiap monitor punya baris batang vertikal tipis, satu batang per periode 5 menit selama 6 jam terakhir, dengan pita gelap horizontal di belakangnya menandai rentang normal (persentil 15–85). Anomali terbaca sebagai batang yang keluar dari pita, diberi warna berbeda. Rendernya SVG langsung, bukan pustaka chart — bentuknya terlalu sederhana untuk membenarkan recharts, dan hasilnya lebih tajam.

Untuk sisanya pakai shadcn/ui apa adanya: `card`, `badge`, `button`, `separator`, `scroll-area`, `sonner`, `skeleton`, `alert`, `dialog`. Sesuaikan token warna di `globals.css` agar cocok dengan palet di atas — jangan menumpuk override Tailwind di atas tema default.

Standar minimum tanpa perlu diumumkan: responsif sampai lebar ponsel, focus ring terlihat saat navigasi keyboard, `prefers-reduced-motion` dihormati (matikan denyut), dan PWA manifest supaya bisa dipasang di layar utama.

---

## 8. Urutan pengerjaan

Kerjakan bertahap. **Berhenti di tiap checkpoint, laporkan, tunggu konfirmasi saya.** Jangan menyelesaikan semuanya sekaligus lalu menyerahkan 40 file.

**Tahap 1 — Fondasi.** Monorepo pnpm, scaffold TanStack Start, shadcn init, drizzle schema + migrasi, config loader dengan validasi zod, logger.
_Checkpoint_: `pnpm typecheck` bersih, migrasi jalan, halaman kosong tampil.

**Tahap 2 — Deteksi + test.** Fungsi murni baseline, traffic, DDoS. Vitest dengan kasus: traffic normal, lonjakan, anjlok, MAD=0, deretan nol, sampel kurang dari minimum, penjaga `minBaseline` dan `minRelativeChange`.
_Checkpoint_: seluruh test hijau. **Ini tahap yang paling penting — jangan lanjut sebelum yakin.**

**Tahap 3 — Data sintetis.** Skrip seed yang menghasilkan 6 minggu metrik palsu dengan pola harian dan mingguan yang realistis, plus flag untuk menyuntikkan lonjakan/anjlok/serangan di titik tertentu. Tanpa ini, menguji baseline musiman berarti menunggu empat minggu.
_Checkpoint_: jalankan detektor terhadap data seed, tunjukkan alert yang terpicu dan yang benar-benar diabaikan.

**Tahap 4 — Collector.** Cloudflare GraphQL (satu dokumen dengan empat alias: total, per status, per cache status, firewall events — jangan empat request terpisah), GA4 Realtime, prober uptime.
_Checkpoint_: dengan kredensial asli, data masuk ke tabel `metrics`.

**Tahap 5 — Alerting.** Mesin alert, kanal push, kanal WhatsApp, tabel `commands`.
_Checkpoint_: `test_alert` sampai ke browser dan grup WhatsApp.

**Tahap 6 — Worker.** Penjadwal, siklus analisis, graceful shutdown, pembersihan data lama.

**Tahap 7 — Dashboard.** Server functions, halaman, pita denyut, service worker.

**Tahap 8 — Rilis.** Dockerfile + compose, pemeriksaan lisensi, README (setup Cloudflare/GA4/WhatsApp, penjelasan cara sistem memutuskan sesuatu itu anomali, tabel parameter yang bisa disetel).

---

## 9. Jebakan yang sudah diketahui

Semuanya nyata dan sudah pernah menggigit di implementasi sebelumnya.

**Jangan menganalisis bucket yang belum matang.** Cloudflare dan GA4 tertinggal beberapa menit. Bucket yang baru terisi separuh akan terbaca sebagai "traffic anjlok" — persis alarm palsu paling menyebalkan. Selalu mundur `ingestLagSeconds` (default 240) **plus** satu bucket penuh sebelum mengevaluasi.

**Kolom detik pada cron hanya menerima 0–59.** Pola `*/60 * * * * *` untuk interval 60 detik tidak sah. Interval ≥ 60 detik harus dinyatakan di kolom menit.

**Cloudflare `httpRequestsAdaptiveGroups` menyampel data pada volume tinggi.** Nilai `count` harus dikalikan `avg.sampleInterval` untuk mendapat estimasi sebenarnya. Melewatkan ini membuat angka traffic salah besar tepat saat sedang diserang.

**Ketersediaan field Cloudflare berbeda antar paket langganan.** Tangani error GraphQL dengan pesan yang jelas, jangan crash.

**GA4 Realtime API mengembalikan potret sesaat, bukan deret waktu.** Polanya berbeda dari Cloudflare: tiap panggilan dicatat sebagai nilai bucket saat itu.

**Baileys sangat cerewet.** Bungkam logger internalnya (`pino({ level: 'silent' })`) supaya tidak menutupi log aplikasi.

**Folder auth WhatsApp harus persisten.** Kalau hilang, QR harus dipindai ulang. Sama dengan file database: kalau hilang, riwayat baseline empat minggu ikut hilang.

**`better-sqlite3` adalah modul native.** Butuh toolchain build di image Docker untuk arsitektur yang belum punya prebuild.

**Retensi data tidak boleh di bawah 35 hari.** Baseline musiman butuh riwayat 4 minggu; memangkas lebih agresif diam-diam melumpuhkan deteksi.

**shadcn/ui bukan dependensi npm.** Komponennya disalin ke dalam repo dan memang dimaksudkan untuk diedit. Commit, jangan gitignore.

---

## 10. Selesai artinya

- `pnpm typecheck` dan `pnpm test` bersih; tidak ada `any` di jalur data.
- `docker compose up -d --build` menghasilkan sistem yang jalan dari nol.
- Alert percobaan sampai ke browser **dan** grup WhatsApp.
- Menjalankan detektor terhadap data seed menghasilkan alert pada anomali yang disuntikkan, dan **diam** pada variasi harian normal. Yang kedua sama pentingnya dengan yang pertama.
- README menjelaskan cara sistem memutuskan sesuatu itu anomali, bukan hanya cara memasangnya.
- Tabel lisensi dependensi ada di README, semuanya OSI-approved.

## 11. Cara bekerja denganku

- Kalau ada keputusan arsitektur yang menurutmu keliru, katakan sebelum mengerjakannya — bukan sesudah.
- Kalau dokumentasi resmi bertentangan dengan brief ini soal API framework, ikuti dokumentasi dan beri tahu aku.
- Kalau sebuah tahap ternyata lebih besar dari perkiraan, potong dan laporkan, jangan diam-diam mengerjakan tiga jam.
- Jangan menambahkan fitur yang tidak diminta. Kalau punya ide bagus, tulis di daftar terpisah di akhir.
- Komentar dalam kode hanya untuk menjelaskan **kenapa**, bukan **apa**. Sebagian besar baris tidak butuh komentar; yang butuh adalah keputusan yang tampak aneh tanpa konteks — misalnya kenapa MAD dipakai alih-alih standar deviasi.
