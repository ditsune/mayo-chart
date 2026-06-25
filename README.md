# mayo-chart

> Dashboard rekap total proses admin & penjualan item berbasis Google Apps Script — dijalankan langsung di dalam Google Spreadsheet sebagai Web App.

---

## Daftar Isi

- [Tentang Proyek](#tentang-proyek)
- [Fitur](#fitur)
- [Arsitektur](#arsitektur)
- [Cara Kerja](#cara-kerja)
- [Instalasi & Setup](#instalasi--setup)
- [Konfigurasi](#konfigurasi)
- [Penggunaan](#penggunaan)
- [Struktur Proyek](#struktur-proyek)
- [Lisensi](#lisensi)

---

## Tentang Proyek

**mayo-chart** adalah Web App berbasis Google Apps Script yang membaca data dari tiga Google Spreadsheet (Website, Telegram, Reseller) secara sekaligus, lalu menampilkan rekap interaktif berupa:

- Ranking total proses per admin, dikelompokkan per tim
- Chart distribusi item terjual dengan podium top 3
- Filter periode fleksibel (pilih bulan + rentang tanggal)

Tampilan dibangun dengan HTML + Chart.js murni — tidak ada framework, tidak ada hosting eksternal — cukup deploy sebagai Google Apps Script Web App dan langsung bisa dipakai.

---

## Fitur

- **Multi-spreadsheet** — membaca 3 sheet sekaligus (Website, Telegram, Reseller) dalam satu klik
- **Filter periode** — pilih bulan via pill button + input tanggal awal–akhir
- **Tab view** — lihat data Gabungan, atau per sumber (Website / Telegram / Reseller) secara terpisah
- **Rekap Admin** — ranking bar chart dengan warna per tim, dikelompokkan per tim (Floppa & Merpati)
- **Item Terjual** — podium top 3, donut chart distribusi, dan daftar lengkap semua item
- **Refresh data** — tombol refresh tanpa reload halaman, memperbarui data dari spreadsheet
- **Responsive** — sidebar di desktop, bottom navigation di mobile (≤600px)
- **Loading state** — animasi label progresif saat data sedang diambil
- **Alias bulan** — mendukung berbagai penulisan nama bulan (Jan, January, Januari, dll.)
- **Alias nama** — normalisasi nama admin otomatis (misal: "ARI PERSIB" → "ARI")

---

## Arsitektur

```
Browser (Index.html)
    │
    │  google.script.run.hitungRekapWeb(bulan, mulai, akhir)
    ▼
Google Apps Script (code.gs)
    │
    ├── SpreadsheetApp.openById()  → Sheet Website
    ├── SpreadsheetApp.openById()  → Sheet Telegram
    └── SpreadsheetApp.openById()  → Sheet Reseller
              │
              └── Filter tab by nama (bulan + rentang tanggal)
              └── Baca kolom admin/proses & item/terjual
              └── Susun & kembalikan JSON ke browser
```

Data mengalir satu arah: browser meminta → Apps Script membaca semua sheet → JSON dikembalikan ke browser → Chart.js merender visualisasi.

---

## Cara Kerja

**Filter tab otomatis** — Skrip hanya memproses tab (sheet) yang namanya mengandung nama bulan yang dipilih **dan** angka tanggal yang masuk dalam rentang yang ditentukan. Tab seperti `Template`, `Akun`, `Summary`, dan `Total Proses` otomatis dilewati.

**Baca data admin** — Di dalam setiap tab, skrip mencari blok data yang diawali baris `Total Proses` lalu header `Admin`, kemudian membaca kolom admin dan kolom jumlah proses sampai menemukan baris `Total`.

**Baca data item** — Skrip mencari header `Nama Item` di dalam tab, lalu membaca kolom nama item dan kolom terjual sampai baris `Total` atau baris kosong.

**Pengelompokan tim** — Setiap nama admin dicocokkan dengan konfigurasi tim di `TIM_CONFIG`. Admin yang tidak terdaftar masuk ke grup *Lainnya*.

---

## Instalasi & Setup

### 1. Salin file ke Google Apps Script

1. Buka [script.google.com](https://script.google.com) dan buat project baru.
2. Ganti isi file `Code.gs` default dengan konten dari `code.gs` di repositori ini.
3. Buat file HTML baru bernama `Index`, lalu tempel konten dari `Index.html`.

### 2. Konfigurasi spreadsheet

Di bagian atas `code.gs`, isi `SHEETS_CONFIG` dengan ID spreadsheet Anda:

```javascript
const SHEETS_CONFIG = [
  {
    id: "ID_SPREADSHEET_WEBSITE",
    label: "Sheet Website",
    adminCol: 13,   // indeks kolom nama admin (0-based)
    prosesCol: 14,  // indeks kolom jumlah proses
    itemCol: 10,    // indeks kolom nama item
    terjualCol: 11  // indeks kolom jumlah terjual
  },
  // ... tambah sheet lain
];
```

> ID spreadsheet bisa ditemukan di URL: `https://docs.google.com/spreadsheets/d/**ID_DI_SINI**/edit`

### 3. Aktifkan Sheets API

Di Apps Script Editor: **Services → Google Sheets API → Add**.  
API ini digunakan untuk `batchGet` (membaca banyak tab sekaligus secara efisien).

### 4. Deploy sebagai Web App

1. Klik **Deploy → New Deployment**
2. Pilih type: **Web App**
3. Atur *Execute as*: **Me**
4. Atur *Who has access*: sesuai kebutuhan (misalnya *Anyone within organization*)
5. Klik **Deploy**, salin URL yang dihasilkan

---

## Konfigurasi

### Tim Admin (`TIM_CONFIG`)

```javascript
const TIM_CONFIG = {
  FLOPPA:  ["KRISNA", "ADIT", "INDRA"],
  MERPATI: ["RIZKI", "RANGGA", "ARI PERSIB"],
};
```

Tambah atau ubah nama anggota sesuai tim Anda. Admin yang tidak terdaftar di sini akan masuk grup **Lainnya**.

### Alias Nama (`NAME_ALIASES`)

```javascript
const NAME_ALIASES = {
  "ARI PERSIB": "ARI",
};
```

Normalisasi nama sebelum pengelompokan — berguna jika satu admin punya penulisan berbeda antar sheet.

### Kolom Spreadsheet

Setiap entry di `SHEETS_CONFIG` menerima properti:

| Properti | Keterangan | Default |
|----------|-----------|---------|
| `id` | ID Google Spreadsheet | — |
| `label` | Nama tampilan di UI | — |
| `adminCol` | Indeks kolom nama admin (0-based) | `13` |
| `prosesCol` | Indeks kolom jumlah proses | `14` |
| `itemCol` | Indeks kolom nama item | `10` |
| `terjualCol` | Indeks kolom jumlah terjual | `11` |

---

## Penggunaan

1. Buka URL Web App yang sudah di-deploy
2. Pilih **bulan** menggunakan pill button (Jan–Des)
3. Isi **tanggal awal** dan **tanggal akhir**
4. Klik **Hitung**
5. Pilih tab **Gabungan / Website / Telegram / Reseller** untuk melihat data per sumber
6. Toggle antara **Admin** dan **Item terjual** di sidebar (desktop) atau bottom nav (mobile)
7. Klik **Refresh** untuk memperbarui data tanpa mengubah filter

---

## Struktur Proyek

```
mayo-chart/
├── Index.html   # UI lengkap (HTML + CSS + JavaScript + Chart.js)
└── code.gs      # Backend Google Apps Script (baca spreadsheet, filter, kalkulasi)
```

Hanya dua file — tidak ada dependency eksternal selain Chart.js (CDN) dan Tabler Icons (CDN).

---

## Lisensi

Proyek ini bersifat **privat** dan dikelola oleh [cuakproject](https://github.com/cuakproject). Penggunaan ulang atau distribusi tanpa izin tidak diperbolehkan.
