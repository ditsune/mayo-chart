// ============================================================
//  AUTH GATE — password-based, server-side only
// ============================================================
const AUTH_TOKEN_TTL_SEC = 60 * 60 * 1; // token valid 1 jam

// Jalanin fungsi ini SEKALI aja manual dari editor (pilih function ini di dropdown, klik Run)
// tiap kali lu mau ganti password. Setelah dijalanin, gak perlu disimpen di kode lagi.
function setAuthPassword() {
  const password = "adiitganss"; // ganti ini pas mau ubah password, run ulang, ini aman gak ke-expose ke user
  const hash = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, password)
    .map(function(b) { return (b < 0 ? b + 256 : b).toString(16).padStart(2, '0'); }).join('');
  PropertiesService.getScriptProperties().setProperty('AUTH_HASH', hash);
  Logger.log('Password hash tersimpan.');
}

function hashPw_(input) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, input)
    .map(function(b) { return (b < 0 ? b + 256 : b).toString(16).padStart(2, '0'); }).join('');
}

function checkPassword_(input) {
  if (!input) return false;
  const stored = PropertiesService.getScriptProperties().getProperty('AUTH_HASH');
  if (!stored) return false;
  return hashPw_(input) === stored;
}

function generateToken_() {
  const token = Utilities.getUuid();
  CacheService.getScriptCache().put('TOKEN_' + token, 'valid', AUTH_TOKEN_TTL_SEC);
  return token;
}

function isValidToken_(token) {
  if (!token) return false;
  return CacheService.getScriptCache().get('TOKEN_' + token) === 'valid';
}

// ⚠️ Dipanggil dari SEMUA fungsi data (hitungRekapWeb, hitungSaldoAkun, hitungSaldoBatchAuto,
// deepIdentifyAkun) di baris pertama mereka. Ini pengaman SISI SERVER — tanpa ini, orang bisa
// buka console browser dan manggil fungsi itu langsung lewat google.script.run, skip overlay
// password di client sama sekali. Overlay di Index.html itu cuma UX, ini yang beneran nge-gate
// akses datanya.
function requireAuth_(token) {
  if (!isValidToken_(token)) {
    throw new Error("SESI_HABIS: Sesi login habis atau belum login. Refresh halaman dan login ulang.");
  }
}

// Dipanggil dari client saat page load buat cek apakah token yang tersimpan di localStorage
// masih valid, tanpa perlu password lagi (biar gak login ulang tiap buka link).
function checkSession(token) {
  return { valid: isValidToken_(token) };
}

// Dipanggil dari halaman login via google.script.run
function verifyLoginAttempt(password) {
  // rate limit kasar: max 5 percobaan salah per 5 menit per proses
  const cache = CacheService.getScriptCache();
  const failKey = 'FAILCOUNT_' + (Session.getTemporaryActiveUserKey() || 'anon');
  const failCount = parseInt(cache.get(failKey) || '0', 10);
  if (failCount >= 5) {
    return { success: false, locked: true, message: 'Terlalu banyak percobaan salah. Coba lagi dalam beberapa menit.' };
  }

  if (checkPassword_(password)) {
    cache.remove(failKey);
    return { success: true, token: generateToken_() };
  }

  cache.put(failKey, String(failCount + 1), 300);
  return { success: false, locked: false, message: 'Password salah.' };
}

// ============================================================
//  MAYO FORENSICS ENGINE — Full GAS Backend (v7.1 — fix kandidatTypo false-positive)
//  v7.1: FIX kandidatTypo di Deep Identify — sebelumnya, transaksi milik AKUN LAIN yang
//        VALID (misal AXM67) bisa nyangkut jadi "kandidat typo" cuma gara-gara jarak
//        Levenshtein ke kode yang lagi discan (misal AXM57) kebetulan <= 2. Sekarang
//        kandidatTypo WAJIB kodenya gak valid dulu (sama kayak syarat kandidatOrphan),
//        baru dicek jaraknya. Efeknya: akun lain yang udah akurat gak lagi nyangkut ke
//        identifier akun yang lagi diperiksa.
//  v7: Cutoff tanggal 25 Juli 2026 buat SEMUA kalkulasi berbasis kode akun AXM
//      (Satuan, Batch, Deep Identify) — sebelum tanggal ini kode akun masih MYX,
//      AXM belum ada, jadi tab-tab sebelum itu SENGAJA DIABAIKAN TOTAL, bukan
//      dianggap error. Juga nutup celah myx di typo-detection Deep Identify.
//  v6: Deep Identify — window scan otomatis dari Use Date/Habis Date (kolom H/I
//      tab AKUN XBOX MAYO), nyisir semua tab di window itu buat nemuin kandidat
//      human error (kode kosong, typo, orphan, aktivitas handler sama).
//  v5: overlay password di Index.html (client-side, gak reload) + SEMUA fungsi data
//      wajib token valid di sisi server (requireAuth_).
//  Fitur: Invoice-based Duplicate Detector + Account-Status-Aware
//         Accuracy Check + Report Tab Inclusion + Cross-month Saldo
// ============================================================

const SHEETS_CONFIG = [
  { id: "19yETtrXqCAf_fjhfHgtqaRhKLXRraM8P-uRwW_r10Hg", label: "Sheet Website",  adminCol: 13, prosesCol: 14, itemCol: 10, terjualCol: 11 },
  { id: "1GmOzkKSjUaFkGGiQC4ITrFAzdrqYUhf_n24HnN-zP1U", label: "Sheet Telegram", adminCol: 14, prosesCol: 15, itemCol: 11, terjualCol: 12 },
  { id: "179HJQc9q-UssQNjlMtuxE6HNl-GkIpSGJqOaXyC3n_U", label: "Sheet Reseller", adminCol: 13, prosesCol: 14, itemCol: 10, terjualCol: 11 },
];

// ⚠️ invoiceCol WAJIB diisi kalau mau duplikat-detection jalan buat sumber ini.
//    Kalau null, duplikat detection di-skip buat sumber itu (biar gak nebak asal).
const AKUN_SHEETS_CONFIG = [
  { id: "1GmOzkKSjUaFkGGiQC4ITrFAzdrqYUhf_n24HnN-zP1U", label: "Telegram", akunCol: 1, nominalCol: 5, statusCol: 6, invoiceCol: 2 },   // B=akun, C=invoice, F=nominal, G=status
  { id: "179HJQc9q-UssQNjlMtuxE6HNl-GkIpSGJqOaXyC3n_U", label: "Reseller", akunCol: 1, nominalCol: 4, statusCol: 5, invoiceCol: null }, // invoice belum dikonfirmasi -> duplikat check di-skip
  { id: "19yETtrXqCAf_fjhfHgtqaRhKLXRraM8P-uRwW_r10Hg", label: "Website",  akunCol: 7, nominalCol: 4, statusCol: 5, invoiceCol: 1 },   // B=invoice, E=nominal, F=status, H=akun
];

const DAFTAR_AKUN_CONFIG = {
  id: "1GmOzkKSjUaFkGGiQC4ITrFAzdrqYUhf_n24HnN-zP1U",
  tabName: "AKUN XBOX MAYO",
  kodeCol: 0,          // A = kode akun
  statusAkunCol: 1,    // B = status akun (Habis / Ready / Dipake)
  saldoCol: 4,         // E = saldo awal
  handlerCol: 6,       // G = handler
  lastBalanceCol: 9,   // J = last balance (dicatat manual, HANYA valid kalau status = Habis)
  useDateCol: 7,       // H = use date
  habisDateCol: 8,     // I = habis date
};

const AKURASI_TOLERANSI = 0.02;
// Selisih di bawah ini dianggap rounding noise wajar — gak perlu kartu investigasi forensik.
const SELISIH_INVESTIGASI_MIN = 1.00;

const TIM_CONFIG = {
  FLOPPA:  ["RANGGA", "ADIT", "INDRA"],
  MERPATI: ["RIZKI", "KRISNA", "ARI PERSIB"],
};
const NAME_ALIASES = { "ARI PERSIB": "ARI" };
const SKIP_KEYWORDS = ["admin", "proses", "total proses", "total", ""];

const HARGA_TABLE = {
  80:0.99, 160:1.98, 240:2.97, 320:3.96, 500:4.99,
  1000:9.99, 1080:10.98, 1160:11.97, 1240:12.96, 1320:13.95, 1500:14.98,
  2000:19.99, 2500:24.98, 3000:29.98, 3500:34.97, 4000:39.98, 4500:44.97,
  5000:49.97, 5500:54.96, 6000:59.97, 6500:64.96, 7000:69.96, 7500:74.95,
  8000:79.96, 8500:84.95, 9000:89.95, 9500:94.94, 10000:99.95,
  15000:149.92, 17000:169.91, 31000:309.84
};
const HARGA_TABLE_PREM = { 450: 5.99, 1000: 9.99, 2200: 19.99 };
const HARGA_PER_DENOM_SEN = { 2000: 1999, 1000: 999, 500: 499, 80: 99 };
const ROBUX_DENOMINATIONS = Object.keys(HARGA_TABLE).map(Number).sort(function(a,b){return a-b;});

const MONTH_ALIASES = {
  januari:   ["januari", "january", "jan"],
  februari:  ["februari", "february", "feb", "pebruari", "peb"],
  maret:     ["maret", "march", "mar"],
  april:     ["april", "apr"],
  mei:       ["mei", "may"],
  juni:      ["juni", "june", "jun"],
  juli:      ["juli", "july", "jul"],
  agustus:   ["agustus", "august", "agu", "agt", "aug"],
  september: ["september", "sept", "sep"],
  oktober:   ["oktober", "october", "okt", "oct"],
  november:  ["november", "nov"],
  desember:  ["desember", "december", "des", "dec"],
};

const MONTH_ORDER = ["januari","februari","maret","april","mei","juni","juli","agustus","september","oktober","november","desember"];

// ── CUTOFF PERGANTIAN KODE AKUN: MYX -> AXM ──
// Sebelum tanggal ini, kode akun AXM BELUM ADA SAMA SEKALI (masih pakai MYX). Jadi tab
// mana pun yang tanggalnya sebelum ini, SENGAJA diabaikan total dari SEMUA kalkulasi yang
// berbasis kode akun AXM (Satuan, Batch, Deep Identify) — bukan dianggap "anomali" atau
// "error", tapi literally di luar cakupan sistem penomoran yang sekarang berlaku.
// Fitur 1 (Rekap Proses admin) TIDAK kena cutoff ini karena gak berhubungan sama kode akun.
const AXM_CUTOFF_MONTH = 'juli';
const AXM_CUTOFF_DAY = 25;

const PROGRESS_KEY   = "CALC_PROGRESS";
const RESULT_CACHE_TTL   = 120;
const CACHE_VALUE_MAX_BYTES = 95000;

function doGet(e) {
  // ⚠️ SENGAJA gak branching berdasarkan token/query param lagi.
  // Kita udah coba 3 cara redirect/reload (window.top, document.write, window.location) buat
  // pindah dari halaman login ke halaman app — SEMUANYA kena masalah beda-beda di sandbox iframe
  // Google Apps Script (window.top diblokir, document.write bikin Uncaught, window.location gak
  // pernah nyampe token-nya ke server). Root cause-nya konsisten: NAVIGASI/RELOAD itu sendiri gak
  // reliable di environment ini.
  //
  // Solusinya: berhenti reload sama sekali. doGet SELALU balikin Index.html (app-nya kemuat penuh
  // dari awal, tapi gak auto-narik data apapun sampai user klik tombol). Index.html sendiri yang
  // nampilin overlay password di atas app-nya — begitu password bener, overlay di-hide via JS
  // biasa (display:none), TANPA reload/navigasi apapun. Auth-check tetep di server (verifyLoginAttempt
  // + rate limit), cuma transisinya yang sekarang full client-side tanpa page load baru.
  //
  // PENTING: karena doGet gak ngegate apa-apa, overlay di Index.html WAJIB ada (lihat file itu)
  // DAN setiap fungsi data (hitungRekapWeb dkk) WAJIB manggil requireAuth_(token) di baris
  // pertama mereka — dua-duanya harus ada bareng, kalau salah satu ilang keamanannya bolong.
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Mayo Chart')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function resolveCanonicalMonth(input) {
  const lower = input.toLowerCase().trim();
  for (const canonical in MONTH_ALIASES) {
    if (MONTH_ALIASES[canonical].includes(lower)) return canonical;
  }
  return lower;
}
function resolveMonthAliases(input) {
  const canonical = resolveCanonicalMonth(input);
  return MONTH_ALIASES[canonical] || [input.toLowerCase().trim()];
}
function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
function authHeader_() { return { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }; }
function columnToLetter_(col) {
  let letter = '';
  while (col > 0) {
    const rem = (col - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    col = Math.floor((col - 1) / 26);
  }
  return letter;
}

function fetchAllSheetTitles_(configs) {
  const requests = configs.map(function(c) {
    return { url: 'https://sheets.googleapis.com/v4/spreadsheets/' + c.id + '?fields=sheets.properties.title', headers: authHeader_(), muteHttpExceptions: true };
  });
  const responses = UrlFetchApp.fetchAll(requests);
  return responses.map(function(res, i) {
    const code = res.getResponseCode();
    if (code !== 200) throw new Error('Gagal ambil daftar tab "' + configs[i].label + '" (HTTP ' + code + '): ' + res.getContentText().slice(0, 200));
    const json = JSON.parse(res.getContentText());
    return (json.sheets || []).map(function(s) { return s.properties.title; });
  });
}

function fetchAllBatchValues_(configs, targetSheetsPerConfig) {
  const requestSpecs = configs.map(function(c, i) {
    const sheetNames = targetSheetsPerConfig[i];
    if (!sheetNames.length) return null;
    const colFields = Object.keys(c).filter(function(k) { return k.endsWith('Col') && c[k] !== null && c[k] !== undefined; }).map(function(k) { return c[k]; });
    const maxCol    = Math.max.apply(null, colFields) + 2;
    const colLetter = columnToLetter_(maxCol);
    const rangeParams = sheetNames.map(function(n) { return 'ranges=' + encodeURIComponent("'" + n.replace(/'/g, "''") + "'!A1:" + colLetter); }).join('&');
    return { url: 'https://sheets.googleapis.com/v4/spreadsheets/' + c.id + '/values:batchGet?' + rangeParams + '&valueRenderOption=UNFORMATTED_VALUE', headers: authHeader_(), muteHttpExceptions: true };
  });
  const validIdx = [];
  const validRequests = [];
  requestSpecs.forEach(function(r, i) { if (r) { validIdx.push(i); validRequests.push(r); } });
  const responses = validRequests.length ? UrlFetchApp.fetchAll(validRequests) : [];
  const results = new Array(configs.length).fill(null);
  responses.forEach(function(res, k) {
    const i = validIdx[k];
    const code = res.getResponseCode();
    if (code !== 200) throw new Error('Gagal ambil data "' + configs[i].label + '" (HTTP ' + code + '): ' + res.getContentText().slice(0, 200));
    results[i] = JSON.parse(res.getContentText()).valueRanges || [];
  });
  return results;
}

function extractTanggalDariNamaSheet_(name, bulanAliases) {
  const lower = name.toLowerCase().trim();
  let bulanIdx = -1;
  for (let a = 0; a < bulanAliases.length; a++) {
    const idx = lower.indexOf(bulanAliases[a]);
    if (idx !== -1) { bulanIdx = idx; break; }
  }
  if (bulanIdx === -1) return null;
  const prefix = lower.substring(0, bulanIdx).trim();
  const digits = prefix.replace(/\D/g, "");
  if (!digits) return null;
  const tgl = parseInt(digits, 10);
  if (isNaN(tgl)) return null;
  return tgl;
}

// Beda dari extractTanggalDariNamaSheet_ yang butuh tau bulannya duluan — ini nyoba SEMUA
// bulan buat nama tab yang gak tau bulannya apa. Dipakai buat cutoff filter & Deep Identify.
function extractTanggalBulanDariNamaSheet_(name) {
  var lower = name.toLowerCase().trim();
  for (var mi = 0; mi < MONTH_ORDER.length; mi++) {
    var canonical = MONTH_ORDER[mi];
    var aliases = MONTH_ALIASES[canonical];
    for (var a = 0; a < aliases.length; a++) {
      var idx = lower.indexOf(aliases[a]);
      if (idx !== -1) {
        var prefix = lower.substring(0, idx).trim();
        var digits = prefix.replace(/\D/g, "");
        if (digits) {
          var tgl = parseInt(digits, 10);
          if (!isNaN(tgl) && tgl >= 1 && tgl <= 31) return { month: canonical, day: tgl };
        }
      }
    }
  }
  return null;
}

function monthDayToDate_(monthCanonical, day, year) {
  var idx = MONTH_ORDER.indexOf(monthCanonical);
  if (idx === -1) return null;
  return new Date(Date.UTC(year, idx, day));
}

// true kalau (bulan,tanggal) yang dikasih jatuh SEBELUM cutoff 25 Juli 2026.
function isBeforeAxmCutoff_(monthCanonical, day) {
  var idx = MONTH_ORDER.indexOf(monthCanonical);
  var cutoffIdx = MONTH_ORDER.indexOf(AXM_CUTOFF_MONTH);
  if (idx === -1) return false; // gak dikenali -> jangan difilter, biar aman
  if (idx < cutoffIdx) return true;
  if (idx > cutoffIdx) return false;
  return day < AXM_CUTOFF_DAY;
}

// Buang tab yang tanggalnya sebelum cutoff 25 Juli. Tab yang gak bisa diekstrak tanggalnya
// (misal tab "Report" yang emang gak ada tanggal di namanya) SENGAJA dibiarin lolos — itu
// bukan soal cutoff, itu soal desain "Report selalu disertakan" yang udah ada duluan.
function filterOutPreAxmCutoff_(names) {
  return names.filter(function(name) {
    var md = extractTanggalBulanDariNamaSheet_(name);
    if (!md) return true;
    return !isBeforeAxmCutoff_(md.month, md.day);
  });
}

function isBlacklistedSheetName_(name) {
  const lower = name.toLowerCase().trim();
  const blacklist = ["template", "akun", "summary", "log", "total proses"];
  return blacklist.some(function(b) { return lower.includes(b); });
}

// ── Tab "Report" SELALU disertakan, gak peduli tanggal — karena kadang proses dicatat di sana ──
function isReportSheetName_(name) {
  return name.toLowerCase().indexOf('report') !== -1;
}

function isTargetSheet(name, bulanAliases, tanggalMulai, tanggalAkhir) {
  if (isBlacklistedSheetName_(name)) return false;
  if (isReportSheetName_(name)) return true;
  const tgl = extractTanggalDariNamaSheet_(name, bulanAliases);
  if (tgl === null) return false;
  return tgl >= tanggalMulai && tgl <= tanggalAkhir;
}

function isTargetSheetCrossMonth_(name, bulanMulaiAliases, tanggalMulai, bulanAkhirAliases, tanggalAkhir) {
  if (isBlacklistedSheetName_(name)) return false;
  if (isReportSheetName_(name)) return true;
  const tglDiBulanMulai = extractTanggalDariNamaSheet_(name, bulanMulaiAliases);
  if (tglDiBulanMulai !== null && tglDiBulanMulai >= tanggalMulai) return true;
  const tglDiBulanAkhir = extractTanggalDariNamaSheet_(name, bulanAkhirAliases);
  if (tglDiBulanAkhir !== null && tglDiBulanAkhir <= tanggalAkhir) return true;
  return false;
}

function validateAdjacentMonths_(bulanMulai, bulanAkhir) {
  const a = resolveCanonicalMonth(bulanMulai);
  const b = resolveCanonicalMonth(bulanAkhir);
  const idxA = MONTH_ORDER.indexOf(a);
  const idxB = MONTH_ORDER.indexOf(b);
  if (idxA === -1 || idxB === -1) throw new Error("Nama bulan tidak dikenali.");
  const diff = (idxB - idxA + 12) % 12;
  if (diff !== 1) throw new Error("Bulan mulai dan bulan akhir harus berdekatan (misal Juli → Agustus), gak boleh loncat.");
}

// ── Dipakai SALDO (Satuan/Batch) — support cross-month + cutoff kode AXM ──
function resolveTargetSheetsForConfig_(titles, bulanMulai, tanggalMulai, bulanAkhir, tanggalAkhir) {
  const isCrossMonth = resolveCanonicalMonth(bulanAkhir) !== resolveCanonicalMonth(bulanMulai);
  var result;
  if (!isCrossMonth) {
    const aliases = resolveMonthAliases(bulanMulai);
    result = titles.filter(function(name) { return isTargetSheet(name, aliases, tanggalMulai, tanggalAkhir); });
  } else {
    validateAdjacentMonths_(bulanMulai, bulanAkhir);
    const aliasesMulai = resolveMonthAliases(bulanMulai);
    const aliasesAkhir  = resolveMonthAliases(bulanAkhir);
    result = titles.filter(function(name) { return isTargetSheetCrossMonth_(name, aliasesMulai, tanggalMulai, aliasesAkhir, tanggalAkhir); });
  }
  // Cutoff kode AXM — buang tab pra-25 Juli 2026 SEBELUM data-nya sempat kepakai buat kalkulasi apapun.
  return filterOutPreAxmCutoff_(result);
}

function buildPeriodeLabel_(bulanMulai, tanggalMulai, bulanAkhir, tanggalAkhir) {
  const isCrossMonth = resolveCanonicalMonth(bulanAkhir) !== resolveCanonicalMonth(bulanMulai);
  if (!isCrossMonth) return tanggalMulai + ' - ' + tanggalAkhir + ' ' + capitalize(resolveCanonicalMonth(bulanMulai)) + ' 2026';
  return tanggalMulai + ' ' + capitalize(resolveCanonicalMonth(bulanMulai)) + ' - ' + tanggalAkhir + ' ' + capitalize(resolveCanonicalMonth(bulanAkhir)) + ' 2026';
}

function setProgress(obj) { try { CacheService.getUserCache().put(PROGRESS_KEY, JSON.stringify(obj), 300); } catch (e) {} }
function getProgress() {
  try { const raw = CacheService.getUserCache().get(PROGRESS_KEY); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
}
function buildCacheKey_(bulan, tanggalMulai, tanggalAkhir) { return 'REKAP_' + resolveCanonicalMonth(bulan) + '_' + tanggalMulai + '_' + tanggalAkhir; }

// ══════════════════════════════════════════════════════════
//  FITUR 1 — REKAP TOTAL PROSES & ITEM (GAK kena cutoff AXM — gak berhubungan sama kode akun)
// ══════════════════════════════════════════════════════════
function hitungRekapWeb(bulan, tanggalMulai, tanggalAkhir, bypassCache, token) {
  requireAuth_(token);
  bulan = String(bulan).trim().toLowerCase();
  tanggalMulai = parseInt(tanggalMulai, 10);
  tanggalAkhir = parseInt(tanggalAkhir, 10);
  if (!bulan) throw new Error("Nama bulan tidak boleh kosong.");
  if (isNaN(tanggalMulai) || tanggalMulai < 1 || tanggalMulai > 31) throw new Error("Tanggal mulai tidak valid (1-31).");
  if (isNaN(tanggalAkhir) || tanggalAkhir < tanggalMulai || tanggalAkhir > 31) throw new Error("Tanggal akhir tidak valid.");

  const cacheKey = buildCacheKey_(bulan, tanggalMulai, tanggalAkhir);
  if (!bypassCache) {
    try {
      const cached = CacheService.getScriptCache().get(cacheKey);
      if (cached) { setProgress({ current: 1, total: 1, text: "Diambil dari cache", done: true }); return JSON.parse(cached); }
    } catch (e) {}
  }

  const bulanAliases     = resolveMonthAliases(bulan);
  const bulanCapitalized = capitalize(resolveCanonicalMonth(bulan));
  const periodeLabel     = tanggalMulai + ' - ' + tanggalAkhir + ' ' + bulanCapitalized + ' 2026';

  setProgress({ current: 0, total: 3, text: "Mengambil daftar tab (paralel)..." });
  const allTitles = fetchAllSheetTitles_(SHEETS_CONFIG);
  const targetSheetsPerConfig = allTitles.map(function(titles) {
    return titles.filter(function(name) { return isTargetSheet(name, bulanAliases, tanggalMulai, tanggalAkhir); });
  });

  setProgress({ current: 1, total: 3, text: "Mengambil data (paralel)..." });
  const allValueRanges = fetchAllBatchValues_(SHEETS_CONFIG, targetSheetsPerConfig);

  setProgress({ current: 2, total: 3, text: "Menyusun rekap..." });
  const combinedMap  = {};
  const combinedItem = {};
  const perSheet      = [];

  SHEETS_CONFIG.forEach(function(config, idx) {
    const targetSheets = targetSheetsPerConfig[idx];
    if (targetSheets.length === 0) {
      perSheet.push({ label: config.label, totalSheets: 0, skipped: [], admins: [], floppaTotal: 0, merpatiTotal: 0, grandTotal: 0, items: [], totalItemTerjual: 0 });
      return;
    }
    const valueRanges = allValueRanges[idx] || [];
    const adminMap = {};
    const itemMap  = {};
    const skipped  = [];

    valueRanges.forEach(function(vr, i) {
      const sheetName = targetSheets[i];
      const rows      = vr.values || [];
      if (rows.length === 0) { skipped.push(sheetName); return; }
      const hasilAdmin = bacaDataSheet(rows, config.adminCol, config.prosesCol);
      if (!hasilAdmin) { skipped.push(sheetName); return; }
      hasilAdmin.forEach(function(h) {
        let key = h.admin.toUpperCase().trim();
        if (NAME_ALIASES[key]) key = NAME_ALIASES[key];
        adminMap[key]    = (adminMap[key]    || 0) + h.proses;
        combinedMap[key] = (combinedMap[key] || 0) + h.proses;
      });
      const hasilItem = bacaDataItem(rows, config.itemCol, config.terjualCol);
      hasilItem.forEach(function(h) {
        itemMap[h.nama]      = (itemMap[h.nama]      || 0) + h.terjual;
        combinedItem[h.nama] = (combinedItem[h.nama] || 0) + h.terjual;
      });
    });

    const srt = buildSortedResult(adminMap);
    const itm = buildItemResult(itemMap);
    perSheet.push({ label: config.label, totalSheets: targetSheets.length, skipped: [], admins: srt.admins, floppaTotal: srt.floppaTotal, merpatiTotal: srt.merpatiTotal, grandTotal: srt.grandTotal, items: itm.items, totalItemTerjual: itm.totalItemTerjual });
  });

  setProgress({ current: 3, total: 3, text: "Selesai!", done: true });
  const cmb = buildSortedResult(combinedMap);
  const cItm = buildItemResult(combinedItem);
  const finalResult = {
    periodeLabel: periodeLabel, perSheet: perSheet,
    combined: { admins: cmb.admins, floppaTotal: cmb.floppaTotal, merpatiTotal: cmb.merpatiTotal, grandTotal: cmb.grandTotal, items: cItm.items, totalItemTerjual: cItm.totalItemTerjual },
  };
  try {
    const serialized = JSON.stringify(finalResult);
    if (serialized.length < CACHE_VALUE_MAX_BYTES) CacheService.getScriptCache().put(cacheKey, serialized, RESULT_CACHE_TTL);
  } catch (e) {}
  return finalResult;
}

function buildSortedResult(adminMap) {
  const sorted = Object.keys(adminMap).map(function(admin) { return { admin: admin, total: adminMap[admin], tim: getTim(admin) }; }).sort(function(a, b) { return b.total - a.total; });
  const floppaTotal  = sorted.filter(function(a) { return a.tim === "FLOPPA"; }).reduce(function(s, a) { return s + a.total; }, 0);
  const merpatiTotal = sorted.filter(function(a) { return a.tim === "MERPATI"; }).reduce(function(s, a) { return s + a.total; }, 0);
  const grandTotal   = sorted.reduce(function(s, a) { return s + a.total; }, 0);
  return { admins: sorted, floppaTotal: floppaTotal, merpatiTotal: merpatiTotal, grandTotal: grandTotal };
}
function buildItemResult(itemMap) {
  const sorted = Object.keys(itemMap).map(function(nama) { return { nama: nama, terjual: itemMap[nama] }; }).sort(function(a, b) { return b.terjual - a.terjual; });
  const totalItemTerjual = sorted.reduce(function(s, i) { return s + i.terjual; }, 0);
  return { items: sorted, totalItemTerjual: totalItemTerjual };
}
function bacaDataSheet(rows, adminCol, prosesCol) {
  adminCol = adminCol ?? 13; prosesCol = prosesCol ?? 14;
  const result = []; let inBlock = false; let headerPassed = false;
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    if (!inBlock) { if (row.some(function(cell) { return String(cell ?? "").trim().toLowerCase() === "total proses"; })) inBlock = true; continue; }
    if (!headerPassed) { if (row.some(function(cell) { return String(cell ?? "").trim().toLowerCase() === "admin"; })) headerPassed = true; continue; }
    const adminVal = String(row[adminCol] ?? "").trim();
    const prosesVal = row[prosesCol];
    if (adminVal.toLowerCase() === "total") break;
    if (!adminVal || SKIP_KEYWORDS.includes(adminVal.toLowerCase())) continue;
    const proses = Number(prosesVal);
    if (isNaN(proses) || proses <= 0) continue;
    result.push({ admin: adminVal, proses: proses });
  }
  return result.length > 0 ? result : null;
}
function bacaDataItem(rows, itemCol, terjualCol) {
  itemCol = itemCol ?? 10; terjualCol = terjualCol ?? 11;
  const result = []; let headerFound = false;
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    if (!headerFound) { const hasHeader = row.some(function(cell) { return String(cell ?? "").trim().toLowerCase() === "nama item"; }); if (hasHeader) headerFound = true; continue; }
    const namaRaw = String(row[itemCol] ?? "").trim();
    const terjualRaw = String(row[terjualCol] ?? "").trim();
    if (namaRaw.toLowerCase() === "total") break;
    if (!namaRaw) { if (result.length > 0) break; continue; }
    const terjual = Number(terjualRaw);
    if (isNaN(terjual) || terjual <= 0) continue;
    result.push({ nama: namaRaw, terjual: terjual });
  }
  return result;
}
function getTim(adminName) {
  const key = adminName.toUpperCase().trim();
  if (TIM_CONFIG.FLOPPA.some(function(m) { return m.toUpperCase() === key; })) return "FLOPPA";
  if (TIM_CONFIG.MERPATI.some(function(m) { return m.toUpperCase() === key; })) return "MERPATI";
  if (key === "ARI") return "MERPATI";
  return "LAINNYA";
}

function hitungHargaGreedy_(nominal) {
  let sisa = nominal; let totalSen = 0;
  const denoms = [2000, 1000, 500, 80];
  for (let d = 0; d < denoms.length; d++) {
    const denom = denoms[d];
    const jumlah = Math.floor(sisa / denom);
    totalSen += jumlah * HARGA_PER_DENOM_SEN[denom];
    sisa -= jumlah * denom;
  }
  if (sisa !== 0) return null;
  return totalSen / 100;
}
function parseNominal_(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  const isPrem = /prem/i.test(s);
  const kMatch = s.match(/(\d+(?:\.\d+)?)\s*K/i);
  if (kMatch) return { nominal: Math.round(parseFloat(kMatch[1]) * 1000), isPrem: isPrem };
  const cleaned = s.replace(/\./g, "");
  const numMatch = cleaned.match(/\d+/);
  if (!numMatch) return null;
  return { nominal: parseInt(numMatch[0], 10), isPrem: isPrem };
}
function hargaUntukNominal_(nominal, isPrem) {
  if (isPrem) return HARGA_TABLE_PREM.hasOwnProperty(nominal) ? { harga: HARGA_TABLE_PREM[nominal], isEstimasi: false } : null;
  if (HARGA_TABLE.hasOwnProperty(nominal)) return { harga: HARGA_TABLE[nominal], isEstimasi: false };
  const estimasi = hitungHargaGreedy_(nominal);
  return estimasi !== null ? { harga: estimasi, isEstimasi: true } : null;
}

// ============================================================
//  FORENSICS ENGINE
// ============================================================
function fmtUsd_(n) { return '$' + Number(n || 0).toFixed(2); }

function analyzeSelisihPattern_(absSelisihUsd) {
  const results = [];
  for (let d = 0; d < ROBUX_DENOMINATIONS.length; d++) {
    const denom = ROBUX_DENOMINATIONS[d];
    const harga = HARGA_TABLE[denom];
    if (harga && Math.abs(absSelisihUsd - harga) < 0.05) results.push({ type: 'SINGLE_DENOMINATION', denom: denom, harga: harga, confidence: 'HIGH' });
  }
  for (let i = 0; i < ROBUX_DENOMINATIONS.length; i++) {
    for (let j = i; j < ROBUX_DENOMINATIONS.length; j++) {
      const h1 = HARGA_TABLE[ROBUX_DENOMINATIONS[i]] || 0;
      const h2 = HARGA_TABLE[ROBUX_DENOMINATIONS[j]] || 0;
      if (Math.abs(absSelisihUsd - (h1 + h2)) < 0.05) results.push({ type: 'DOUBLE_DENOMINATION', denoms: [ROBUX_DENOMINATIONS[i], ROBUX_DENOMINATIONS[j]], harga: h1 + h2, confidence: 'MEDIUM' });
    }
  }
  return results;
}

function getHandlerHistory_(kode, daftarAkun) {
  const akun = daftarAkun.find(function(a) { return a.kode.toLowerCase() === kode.toLowerCase(); });
  return { lastHandler: akun ? akun.handler : null };
}

// forensik CUMA dipanggil untuk akun berstatus "habis" yang beneran bermasalah (dijaga di pemanggil)
function forensikSelisihAkun_(akunHasil, allOrphanTrans, allAkunHasil, daftarAkun) {
  const selisih = akunHasil.selisih;
  const absSelisih = Math.abs(selisih);
  const kode = akunHasil.kode;

  const patternMatches = analyzeSelisihPattern_(absSelisih);
  const matchingOrphans = (allOrphanTrans || []).filter(function(o) { return Math.abs(o.harga - absSelisih) < 0.05; });
  const swapCandidates = (allAkunHasil || []).filter(function(a) { if (a.kode === kode) return false; return Math.abs(a.selisih + selisih) < 0.05 && a.selisih !== 0; });
  const handlerHistory = getHandlerHistory_(kode, daftarAkun);
  const handlerMismatch = akunHasil.handler && handlerHistory.lastHandler && akunHasil.handler !== handlerHistory.lastHandler;

  if (swapCandidates.length > 0) {
    return {
      cause: 'SWAP_AKUN', confidence: 'HIGH',
      evidence: 'Selisih ' + fmtUsd_(selisih) + ' ditolak oleh ' + swapCandidates.map(function(s){return s.kode.toUpperCase();}).join(', '),
      suggestion: 'Cek transaksi — kemungkinan 1 transaksi milik ' + kode.toUpperCase() + ' ter-input di akun ' + swapCandidates[0].kode.toUpperCase(),
      relatedAkun: swapCandidates.map(function(s) { return s.kode; })
    };
  }
  if (matchingOrphans.length > 0) {
    const orphan = matchingOrphans[0];
    return {
      cause: 'ORPHAN_TRANSACTION', confidence: 'HIGH',
      evidence: 'Ditemukan transaksi "ngambang" senilai ' + fmtUsd_(absSelisih) + ' di ' + orphan.label + '/' + orphan.sheet + ' baris ' + orphan.row,
      suggestion: 'Transaksi kode "' + (orphan.kodeDitulis || '(kosong)') + '" kemungkinan seharusnya ' + kode.toUpperCase(),
      orphans: matchingOrphans
    };
  }
  if (patternMatches.some(function(p) { return p.type === 'SINGLE_DENOMINATION'; })) {
    const match = patternMatches.find(function(p) { return p.type === 'SINGLE_DENOMINATION'; });
    return {
      cause: 'SINGLE_TRANSACTION_ERROR', confidence: 'HIGH',
      evidence: 'Selisih ' + fmtUsd_(absSelisih) + ' = harga ' + match.denom + ' Robux (' + fmtUsd_(match.harga) + ')',
      suggestion: 'Cek: 1 transaksi ' + match.denom + ' Robux kemungkinan ' + (selisih > 0 ? 'BELUM tercatat (missing)' : 'DOUBLE INPUT / salah nominal'),
      pattern: match
    };
  }
  if (patternMatches.some(function(p) { return p.type === 'DOUBLE_DENOMINATION'; })) {
    const match = patternMatches.find(function(p) { return p.type === 'DOUBLE_DENOMINATION'; });
    return {
      cause: 'MULTI_TRANSACTION_ERROR', confidence: 'MEDIUM',
      evidence: 'Selisih ' + fmtUsd_(absSelisih) + ' = kombinasi ' + match.denoms.join('+') + ' Robux',
      suggestion: 'Kemungkinan ' + (selisih > 0 ? '2 transaksi belum tercatat' : '2 transaksi double input / salah nominal'),
      pattern: match
    };
  }
  if (handlerMismatch) {
    return {
      cause: 'HANDLER_MISMATCH', confidence: 'MEDIUM',
      evidence: 'Handler sekarang: ' + akunHasil.handler + ', biasanya: ' + handlerHistory.lastHandler,
      suggestion: 'Verifikasi apakah ' + akunHasil.handler + ' beneran megang ' + kode.toUpperCase() + ' — kemungkinan typo kode saat input'
    };
  }
  return {
    cause: 'UNKNOWN', confidence: 'UNKNOWN',
    evidence: 'Selisih ' + fmtUsd_(absSelisih) + ' tidak match pola apapun',
    suggestion: 'Investigasi manual: (1) Cek catatan pembelian Robux fisik, (2) Cek apakah ada transaksi "Done" yang terhapus, (3) Cek apakah Last Balance manual sudah update'
  };
}

function generateForensicsSummary_(hasilPerAkun) {
  const bermasalah = hasilPerAkun.filter(function(a) { return a.forensik && a.forensik.cause !== 'AKURAT' && a.forensik.cause !== 'SEDANG_DIPAKAI'; });
  const byCause = {};
  bermasalah.forEach(function(a) { const c = a.forensik.cause; byCause[c] = (byCause[c] || 0) + 1; });
  return {
    totalInvestigate: bermasalah.length,
    byCause: byCause,
    highConfidence: bermasalah.filter(function(a) { return a.forensik.confidence === 'HIGH'; }).length,
    swapDetected: Math.floor(hasilPerAkun.filter(function(a) { return a.forensik && a.forensik.cause === 'SWAP_AKUN'; }).length / 2)
  };
}

function levenshtein_(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({length: m+1}, function() { return new Array(n+1).fill(0); });
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

function fetchDaftarAkun_() {
  const cfg = DAFTAR_AKUN_CONFIG;
  const range = encodeURIComponent("'" + cfg.tabName + "'!A2:Z2000");
  const url = 'https://sheets.googleapis.com/v4/spreadsheets/' + cfg.id + '/values/' + range + '?valueRenderOption=UNFORMATTED_VALUE';
  const res = UrlFetchApp.fetch(url, { headers: authHeader_(), muteHttpExceptions: true });
  const code = res.getResponseCode();
  if (code !== 200) throw new Error('Gagal ambil daftar akun dari tab "' + cfg.tabName + '" (HTTP ' + code + '): ' + res.getContentText().slice(0, 200));

  const rows = JSON.parse(res.getContentText()).values || [];
  const daftar = [];

  rows.forEach(function(row) {
    const kode = String(row[cfg.kodeCol] ?? "").trim();
    if (!kode) return;

    const saldoRaw = row[cfg.saldoCol];
    if (saldoRaw === undefined || saldoRaw === null) return;
    let saldoStr = String(saldoRaw).trim();
    if (!saldoStr) return;
    let cleanStr = saldoStr.replace(/[^0-9.\-]/g, '');
    if (!cleanStr) return;
    const saldo = parseFloat(cleanStr);
    if (isNaN(saldo)) return;

    // ── STATUS AKUN (kolom B) — Habis / Ready / Dipake ──
    const statusAkunRaw = String(row[cfg.statusAkunCol] ?? "").trim().toLowerCase();
    const isHabis = statusAkunRaw === "habis";

    const handlerRaw = String(row[cfg.handlerCol] ?? "").trim();
    const handler = handlerRaw ? handlerRaw.toUpperCase() : "";
    const handlerTim = handler ? getTim(handler) : null;

    let lastBalance = null;
    const lbRaw = row[cfg.lastBalanceCol];
    if (lbRaw !== undefined && lbRaw !== null) {
      const lbStr = String(lbRaw).trim();
      if (lbStr !== "") {
        const lbClean = lbStr.replace(/[^0-9.\-]/g, '');
        if (lbClean !== "") { const lbNum = parseFloat(lbClean); if (!isNaN(lbNum)) lastBalance = lbNum; }
      }
    }

    daftar.push({
      kode: kode, saldoAwal: saldo, statusAkun: statusAkunRaw, isHabis: isHabis,
      handler: handler, handlerTim: handlerTim, lastBalance: lastBalance,
      useDateRaw: row[cfg.useDateCol] ?? null,
      habisDateRaw: row[cfg.habisDateCol] ?? null
    });
  });

  return daftar;
}

// ============================================================
//  FITUR SALDO — SATUAN (cross-month, forensics-aware, cutoff AXM)
// ============================================================
function hitungSaldoAkun(kodeAkun, bulanMulai, tanggalMulai, bulanAkhir, tanggalAkhir, token) {
  requireAuth_(token);
  kodeAkun = String(kodeAkun).trim().toLowerCase();
  bulanMulai = String(bulanMulai).trim().toLowerCase();
  bulanAkhir = bulanAkhir ? String(bulanAkhir).trim().toLowerCase() : bulanMulai;
  tanggalMulai = parseInt(tanggalMulai, 10);
  tanggalAkhir = parseInt(tanggalAkhir, 10);

  if (!kodeAkun) throw new Error("Kode akun tidak boleh kosong.");
  if (!bulanMulai) throw new Error("Bulan tidak boleh kosong.");
  if (isNaN(tanggalMulai) || tanggalMulai < 1 || tanggalMulai > 31) throw new Error("Tanggal awal tidak valid (1-31).");
  if (isNaN(tanggalAkhir) || tanggalAkhir < 1 || tanggalAkhir > 31) throw new Error("Tanggal akhir tidak valid (1-31).");

  const isCrossMonth = resolveCanonicalMonth(bulanAkhir) !== resolveCanonicalMonth(bulanMulai);
  if (isCrossMonth) validateAdjacentMonths_(bulanMulai, bulanAkhir);
  else if (tanggalAkhir < tanggalMulai) throw new Error("Tanggal akhir tidak boleh sebelum tanggal awal (dalam bulan yang sama).");

  const daftarAkun = fetchDaftarAkun_();
  const akunInfo = daftarAkun.find(function(a) { return a.kode.toLowerCase() === kodeAkun; });
  const kodeValidSet = new Set(daftarAkun.map(function(a) { return a.kode.toLowerCase(); }));

  const allTitles = fetchAllSheetTitles_(AKUN_SHEETS_CONFIG);
  const targetSheetsPerConfig = allTitles.map(function(titles) { return resolveTargetSheetsForConfig_(titles, bulanMulai, tanggalMulai, bulanAkhir, tanggalAkhir); });
  const allValueRanges = fetchAllBatchValues_(AKUN_SHEETS_CONFIG, targetSheetsPerConfig);

  let totalSaldoTerpakai = 0;
  let totalNominalTerpakai = 0;
  const perSheet = [];
  const failedRows = [];
  const estimasiRows = [];
  const successLog = [];
  const orphanDetails = [];

  AKUN_SHEETS_CONFIG.forEach(function(config, idx) {
    const targetSheets = targetSheetsPerConfig[idx];
    const valueRanges  = allValueRanges[idx] || [];
    let sheetTotal = 0, sheetNominal = 0, jumlahTransaksi = 0;

    valueRanges.forEach(function(vr, i) {
      const sheetName = targetSheets[i];
      const rows = vr.values || [];
      let jumlahDiTab = 0;

      rows.forEach(function(row, rIdx) {
        const akunRaw = String(row[config.akunCol] ?? "").trim().toLowerCase();
        if (akunRaw !== kodeAkun) {
          if (akunRaw) {
            const statusRawOrphan = String(row[config.statusCol] ?? "").trim().toLowerCase();
            if (statusRawOrphan === "done") {
              const parsedOrphan = parseNominal_(row[config.nominalCol]);
              if (parsedOrphan) {
                const hasilOrphan = hargaUntukNominal_(parsedOrphan.nominal, parsedOrphan.isPrem);
                if (hasilOrphan && !kodeValidSet.has(akunRaw) && !akunRaw.startsWith('myx')) {
                  orphanDetails.push({ label: config.label, sheet: sheetName, row: rIdx + 1, kodeDitulis: akunRaw, nominal: parsedOrphan.nominal, isPrem: parsedOrphan.isPrem, harga: hasilOrphan.harga, isEstimasi: hasilOrphan.isEstimasi });
                }
              }
            }
          }
          return;
        }

        const statusRaw = String(row[config.statusCol] ?? "").trim().toLowerCase();
        if (statusRaw !== "done") {
          failedRows.push({ sheet: sheetName, label: config.label, row: rIdx + 1, alasan: "Status bukan Done (nilai: \"" + (String(row[config.statusCol] ?? "").trim() || "kosong") + "\")", raw: String(row[config.nominalCol] ?? "") });
          return;
        }

        const nominalRaw = row[config.nominalCol];
        const parsed = parseNominal_(nominalRaw);
        if (parsed === null) { failedRows.push({ sheet: sheetName, label: config.label, row: rIdx + 1, alasan: "Nominal tidak terbaca", raw: String(nominalRaw) }); return; }

        const hasil = hargaUntukNominal_(parsed.nominal, parsed.isPrem);
        if (hasil === null) { failedRows.push({ sheet: sheetName, label: config.label, row: rIdx + 1, alasan: "Nominal " + parsed.nominal + (parsed.isPrem ? " PREM" : "") + " belum ada di tabel & gak bisa didekomposisi", raw: String(nominalRaw) }); return; }

        sheetTotal += hasil.harga; sheetNominal += parsed.nominal; jumlahTransaksi++; jumlahDiTab++;
        if (hasil.isEstimasi) estimasiRows.push({ sheet: sheetName, label: config.label, row: rIdx + 1, nominal: parsed.nominal, harga: hasil.harga });
      });

      successLog.push({ label: config.label, sheet: sheetName, jumlahData: jumlahDiTab });
    });

    totalSaldoTerpakai += sheetTotal; totalNominalTerpakai += sheetNominal;
    perSheet.push({ label: config.label, total: sheetTotal, nominalTerpakai: sheetNominal, jumlahTransaksi: jumlahTransaksi });
  });

  const saldoAwalAkun = akunInfo ? akunInfo.saldoAwal : null;
  const sisaSistem = saldoAwalAkun !== null ? Math.round((saldoAwalAkun - totalSaldoTerpakai) * 100) / 100 : null;
  const isHabis = akunInfo ? akunInfo.isHabis : false;

  let akurasi = null, deltaAkurasi = null;
  // ── Validasi Last Balance HANYA berlaku kalau status akun = Habis ──
  if (isHabis && akunInfo && akunInfo.lastBalance !== null && sisaSistem !== null) {
    deltaAkurasi = Math.round((sisaSistem - akunInfo.lastBalance) * 100) / 100;
    akurasi = Math.abs(deltaAkurasi) <= AKURASI_TOLERANSI ? "AKURAT" : "BEDA_CATATAN";
  }

  const dummyHasil = { kode: kodeAkun, saldoAwal: saldoAwalAkun || 0, terpakai: totalSaldoTerpakai, selisih: sisaSistem || 0,
    status: (sisaSistem || 0) === 0 ? "NORMAL" : ((sisaSistem || 0) > 0 ? "KURANG_TERCATAT" : "KELEBIHAN_TERCATAT"),
    handler: akunInfo ? akunInfo.handler : null, handlerTim: akunInfo ? akunInfo.handlerTim : null,
    lastBalance: akunInfo ? akunInfo.lastBalance : null, akurasi: akurasi, deltaAkurasi: deltaAkurasi, isHabis: isHabis };

  let forensik;
  if (!isHabis) {
    forensik = { cause: 'SEDANG_DIPAKAI', confidence: 'N/A', evidence: 'Akun masih berstatus "' + (akunInfo ? akunInfo.statusAkun : '?') + '" — belum selesai dipakai, jadi selisih di sini WAJAR (siklus belum tutup). Last Balance cuma valid setelah status jadi Habis.', suggestion: 'Gak perlu tindakan sekarang — cek lagi setelah akun ini di-set Habis.' };
  } else if (akurasi === 'AKURAT') {
    forensik = { cause: 'AKURAT', confidence: 'CERTAIN', evidence: 'Cocok dengan catatan manual', suggestion: 'Tidak perlu tindakan' };
  } else if (sisaSistem === null || Math.abs(sisaSistem) < SELISIH_INVESTIGASI_MIN) {
    // Selisih kecil (di bawah threshold) = rounding noise wajar, bukan human error — gak perlu alarm.
    forensik = { cause: 'MINOR', confidence: 'CERTAIN', evidence: 'Selisih kecil, dalam batas wajar rounding harga', suggestion: 'Tidak perlu tindakan' };
  } else if (akurasi === 'BEDA_CATATAN' || (sisaSistem !== null && sisaSistem !== 0)) {
    forensik = forensikSelisihAkun_(dummyHasil, orphanDetails, [dummyHasil], daftarAkun);
  } else {
    forensik = { cause: 'AKURAT', confidence: 'CERTAIN', evidence: 'Tidak ada selisih', suggestion: 'Tidak perlu tindakan' };
  }

  return {
    kodeAkun: kodeAkun,
    periodeLabel: buildPeriodeLabel_(bulanMulai, tanggalMulai, bulanAkhir, tanggalAkhir),
    totalSaldoTerpakai: totalSaldoTerpakai, totalNominalTerpakai: totalNominalTerpakai,
    perSheet: perSheet, failedRows: failedRows, estimasiRows: estimasiRows, successLog: successLog,
    saldoAwal: akunInfo ? akunInfo.saldoAwal : null,
    handler: akunInfo ? akunInfo.handler : null, handlerTim: akunInfo ? akunInfo.handlerTim : null,
    lastBalance: akunInfo ? akunInfo.lastBalance : null,
    statusAkun: akunInfo ? akunInfo.statusAkun : null, isHabis: isHabis,
    akunDitemukan: !!akunInfo, akurasi: akurasi, deltaAkurasi: deltaAkurasi,
    forensik: forensik, orphanTransactions: orphanDetails
  };
}

// ============================================================
//  FITUR SALDO — BATCH (cross-month, forensics-aware, cutoff AXM)
// ============================================================
function hitungSaldoBatchAuto(bulanMulai, tanggalMulai, bulanAkhir, tanggalAkhir, token) {
  requireAuth_(token);
  bulanMulai = String(bulanMulai).trim().toLowerCase();
  bulanAkhir = bulanAkhir ? String(bulanAkhir).trim().toLowerCase() : bulanMulai;
  tanggalMulai = parseInt(tanggalMulai, 10);
  tanggalAkhir = parseInt(tanggalAkhir, 10);

  if (!bulanMulai) throw new Error("Nama bulan tidak boleh kosong.");
  if (isNaN(tanggalMulai) || tanggalMulai < 1 || tanggalMulai > 31) throw new Error("Tanggal awal tidak valid (1-31).");
  if (isNaN(tanggalAkhir) || tanggalAkhir < 1 || tanggalAkhir > 31) throw new Error("Tanggal akhir tidak valid (1-31).");

  const isCrossMonth = resolveCanonicalMonth(bulanAkhir) !== resolveCanonicalMonth(bulanMulai);
  if (isCrossMonth) validateAdjacentMonths_(bulanMulai, bulanAkhir);
  else if (tanggalAkhir < tanggalMulai) throw new Error("Tanggal akhir tidak boleh sebelum tanggal awal (dalam bulan yang sama).");

  const daftarAkun = fetchDaftarAkun_();
  if (daftarAkun.length === 0) throw new Error('Tidak ada data akun ditemukan di tab "' + DAFTAR_AKUN_CONFIG.tabName + '". Cek kolom A (kode) & E (saldo).');
  const kodeValidSet = new Set(daftarAkun.map(function(a) { return a.kode.toLowerCase(); }));

  const allTitles = fetchAllSheetTitles_(AKUN_SHEETS_CONFIG);
  const targetSheetsPerConfig = allTitles.map(function(titles) { return resolveTargetSheetsForConfig_(titles, bulanMulai, tanggalMulai, bulanAkhir, tanggalAkhir); });
  const allValueRanges = fetchAllBatchValues_(AKUN_SHEETS_CONFIG, targetSheetsPerConfig);

  const perAkunMap = {};
  const orphanDetails = [];
  const duplicates = [];

  AKUN_SHEETS_CONFIG.forEach(function(config, idx) {
    const targetSheets = targetSheetsPerConfig[idx];
    const valueRanges  = allValueRanges[idx] || [];

    valueRanges.forEach(function(vr, i) {
      const sheetName = targetSheets[i];
      const rows = vr.values || [];

      // ⚠️ Duplicate detection via invoice DIHAPUS — invoice number di data ini gak unik per
      // transaksi (1 invoice bisa legit nyakup banyak baris beli beda waktu), jadi deteksi
      // berbasis invoice cuma ngasih false-positive massal. Gak ada sinyal reliable lain buat
      // ini dari data yang tersedia sekarang, jadi lebih aman TIDAK menuduh duplikat sama sekali
      // daripada nuduh ratusan baris valid sebagai duplikat palsu.

      rows.forEach(function(row, rIdx) {
        const akunRaw = String(row[config.akunCol] ?? "").trim().toLowerCase();
        const statusRaw = String(row[config.statusCol] ?? "").trim().toLowerCase();
        if (statusRaw !== "done") return;

        const parsed = parseNominal_(row[config.nominalCol]);
        if (parsed === null) return;
        const hasil = hargaUntukNominal_(parsed.nominal, parsed.isPrem);
        if (hasil === null) return;

        // --- ORPHAN DETAIL ---
        if (!akunRaw || (!kodeValidSet.has(akunRaw) && !akunRaw.startsWith('myx'))) {
          orphanDetails.push({ label: config.label, sheet: sheetName, row: rIdx + 1, kodeDitulis: akunRaw || '(KOSONG)', nominal: parsed.nominal, isPrem: parsed.isPrem, harga: hasil.harga, isEstimasi: hasil.isEstimasi });
          if (!akunRaw) return;
        }

        if (!perAkunMap[akunRaw]) perAkunMap[akunRaw] = { total: 0, jumlah: 0 };
        perAkunMap[akunRaw].total += hasil.harga;
        perAkunMap[akunRaw].jumlah++;
      });
    });
  });

  const hasilPerAkun = daftarAkun.map(function(a) {
    const kodeLower = a.kode.toLowerCase();
    const data = perAkunMap[kodeLower] || { total: 0, jumlah: 0 };
    const selisih = Math.round((a.saldoAwal - data.total) * 100) / 100;

    let akurasi = null, deltaAkurasi = null;
    // ── HANYA validasi vs Last Balance kalau status akun = Habis ──
    if (a.isHabis && a.lastBalance !== null) {
      deltaAkurasi = Math.round((selisih - a.lastBalance) * 100) / 100;
      akurasi = Math.abs(deltaAkurasi) <= AKURASI_TOLERANSI ? "AKURAT" : "BEDA_CATATAN";
    }

    return {
      kode: a.kode, saldoAwal: a.saldoAwal, terpakai: data.total, jumlahTransaksi: data.jumlah, selisih: selisih,
      status: selisih === 0 ? "NORMAL" : (selisih > 0 ? "KURANG_TERCATAT" : "KELEBIHAN_TERCATAT"),
      handler: a.handler || null, handlerTim: a.handlerTim || null, lastBalance: a.lastBalance,
      statusAkun: a.statusAkun, isHabis: a.isHabis, akurasi: akurasi, deltaAkurasi: deltaAkurasi,
    };
  });

  // ── Forensik: HANYA jalan untuk akun HABIS yang beneran bermasalah ──
  const hasilPerAkunWithForensics = hasilPerAkun.map(function(a) {
    if (!a.isHabis) {
      return Object.assign({}, a, { forensik: { cause: 'SEDANG_DIPAKAI', confidence: 'N/A', evidence: 'Status akun masih "' + (a.statusAkun || '?') + '" — selisih di sini wajar karena siklus belum tutup.', suggestion: 'Cek lagi setelah status diubah jadi Habis.' } });
    }
    if (a.akurasi === 'AKURAT') {
      return Object.assign({}, a, { forensik: { cause: 'AKURAT', confidence: 'CERTAIN', evidence: 'Cocok dengan catatan manual', suggestion: 'Tidak perlu tindakan' } });
    }
    if (Math.abs(a.selisih) < SELISIH_INVESTIGASI_MIN) {
      // Selisih kecil = rounding noise wajar, bukan human error — gak perlu kartu investigasi.
      return Object.assign({}, a, { forensik: { cause: 'MINOR', confidence: 'CERTAIN', evidence: 'Selisih kecil, dalam batas wajar rounding harga', suggestion: 'Tidak perlu tindakan' } });
    }
    if (a.status === 'NORMAL' && a.akurasi !== 'BEDA_CATATAN') {
      return Object.assign({}, a, { forensik: { cause: 'AKURAT', confidence: 'CERTAIN', evidence: 'Tidak ada selisih', suggestion: 'Tidak perlu tindakan' } });
    }
    const forensik = forensikSelisihAkun_(a, orphanDetails, hasilPerAkun, daftarAkun);
    return Object.assign({}, a, { forensik: forensik });
  });

  const kodeKosong = [];
  const kodeTidakDikenal = [];
  orphanDetails.forEach(function(o) {
    if (o.kodeDitulis === '(KOSONG)') {
      kodeKosong.push({ label: o.label, sheet: o.sheet, row: o.row, nominal: o.nominal });
    } else {
      let saran = null, jarakMin = 999;
      daftarAkun.forEach(function(a) { const jarak = levenshtein_(o.kodeDitulis.toLowerCase(), a.kode.toLowerCase()); if (jarak < jarakMin) { jarakMin = jarak; saran = a.kode; } });
      kodeTidakDikenal.push({ label: o.label, sheet: o.sheet, row: o.row, nominal: o.nominal, kodeDitulis: o.kodeDitulis, saran: jarakMin <= 2 ? saran.toUpperCase() : null, jarak: jarakMin });
    }
  });
  const anomali = { kodeKosong: kodeKosong, kodeTidakDikenal: kodeTidakDikenal, totalAnomali: orphanDetails.length };

  // Kemungkinan swap — HANYA di antara akun berstatus Habis, DAN selisihnya harus
  // cocok sama harga Robux ASLI di tabel (bukan sekadar kebetulan sama angka kecil).
  function isSelisihHargaValid_(nilai) {
    const abs = Math.abs(nilai);
    if (abs < 0.99) return false; // di bawah harga termurah (80 Robux = $0.99), gak mungkin 1 transaksi
    for (const nominal in HARGA_TABLE) {
      if (Math.abs(HARGA_TABLE[nominal] - abs) < 0.02) return true;
    }
    return false;
  }

  const bermasalahHabis = hasilPerAkunWithForensics.filter(function(a) { return a.isHabis && a.status !== "NORMAL"; });
  const kemungkinanSwap = [];
  for (let i = 0; i < bermasalahHabis.length; i++) {
    for (let j = i + 1; j < bermasalahHabis.length; j++) {
      const a = bermasalahHabis[i], b = bermasalahHabis[j];
      if (Math.abs(a.selisih + b.selisih) < 0.02 && a.selisih !== 0 && isSelisihHargaValid_(a.selisih)) {
        kemungkinanSwap.push({ akunKurang: a.selisih > 0 ? a.kode : b.kode, akunLebih: a.selisih > 0 ? b.kode : a.kode, besarSelisih: Math.abs(a.selisih) });
      }
    }
  }

  return {
    periodeLabel: buildPeriodeLabel_(bulanMulai, tanggalMulai, bulanAkhir, tanggalAkhir),
    hasilPerAkun: hasilPerAkunWithForensics,
    kemungkinanSwap: kemungkinanSwap,
    totalAkun: hasilPerAkun.length,
    totalAkunNormal: hasilPerAkun.filter(function(a) { return a.status === "NORMAL" || !a.isHabis; }).length,
    totalAkunBermasalah: bermasalahHabis.length,
    anomali: anomali,
    orphanTransactions: orphanDetails,
    duplicateTransactions: duplicates,
    forensicsSummary: generateForensicsSummary_(hasilPerAkunWithForensics)
  };
}

// ============================================================
//  DEEP IDENTIFY — window scan otomatis dari Use Date/Habis Date, cutoff AXM
// ============================================================
const DEEP_BUFFER_DAYS = 3;              // buffer sebelum Use Date & sesudah Habis Date
const DEEP_FALLBACK_LOOKBACK_DAYS = 14;  // kalau Use Date kosong, mundur segini dari Habis Date

// Parse tanggal dari cell H/I. Nanganin 3 kasus: serial date asli Sheets (angka besar),
// angka kecil aneh (pecahan salah baca, misal "2/8" jadi 0.25), string M/D/YYYY, dan
// string M/D tanpa tahun (format nyempil yang ketemu di data lu — ditandai suspect).
function parseSheetDate_(raw, assumedYear) {
  assumedYear = assumedYear || 2026;
  if (raw === null || raw === undefined || raw === '') {
    return { date: null, raw: raw, suspect: false, reason: 'KOSONG' };
  }
  if (typeof raw === 'number') {
    if (raw < 20000) {
      return { date: null, raw: raw, suspect: true, reason: 'Angka ' + raw + ' bukan serial tanggal valid (kemungkinan salah input, misal "2/8" kebaca sebagai pecahan)' };
    }
    var epoch = new Date(Date.UTC(1899, 11, 30));
    return { date: new Date(epoch.getTime() + raw * 86400000), raw: raw, suspect: false, reason: null };
  }
  var s = String(raw).trim();
  var m1 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m1) {
    var mo = parseInt(m1[1], 10), da = parseInt(m1[2], 10), yr = parseInt(m1[3], 10);
    if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) return { date: new Date(Date.UTC(yr, mo - 1, da)), raw: raw, suspect: false, reason: null };
  }
  var m2 = s.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (m2) {
    var a = parseInt(m2[1], 10), b = parseInt(m2[2], 10);
    if (b >= 1 && b <= 12 && a >= 1 && a <= 31) {
      return { date: new Date(Date.UTC(assumedYear, b - 1, a)), raw: raw, suspect: true,
        reason: 'Format tanpa tahun ("' + s + '") — diasumsikan tanggal ' + a + ' bulan ' + b + ', tapi ini beda format dari baris lain, WAJIB dicek manual' };
    }
  }
  return { date: null, raw: raw, suspect: true, reason: 'Format gak dikenali: "' + s + '"' };
}

function startOfDay_(d) { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0)); }
function endOfDay_(d) { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59)); }

function deepIdentifyAkun(kode, token) {
  requireAuth_(token);
  kode = String(kode).trim().toLowerCase();
  if (!kode) throw new Error("Kode akun tidak boleh kosong.");

  var daftarAkun = fetchDaftarAkun_();
  var kodeValidSet = new Set(daftarAkun.map(function(a) { return a.kode.toLowerCase(); }));
  var akunInfo = daftarAkun.find(function(a) { return a.kode.toLowerCase() === kode; });
  if (!akunInfo) throw new Error('Kode akun "' + kode + '" tidak ditemukan di tab "' + DAFTAR_AKUN_CONFIG.tabName + '".');

  var warnings = [];
  var useParsed = parseSheetDate_(akunInfo.useDateRaw);
  var habisParsed = parseSheetDate_(akunInfo.habisDateRaw);
  if (useParsed.suspect) warnings.push('USE DATE: ' + useParsed.reason);
  if (habisParsed.suspect) warnings.push('HABIS DATE: ' + habisParsed.reason);

  var DAY_MS = 86400000;
  var windowStart, windowEnd;

  if (useParsed.date && habisParsed.date) {
    windowStart = new Date(useParsed.date.getTime() - DEEP_BUFFER_DAYS * DAY_MS);
    windowEnd = new Date(habisParsed.date.getTime() + DEEP_BUFFER_DAYS * DAY_MS);
  } else if (useParsed.date && !habisParsed.date) {
    windowStart = new Date(useParsed.date.getTime() - DEEP_BUFFER_DAYS * DAY_MS);
    windowEnd = new Date();
    warnings.push('HABIS DATE kosong/gak valid — scan sampai hari ini. Kalau akun ini udah lama gak dipake, hasil bisa kebawa transaksi gak relevan.');
  } else if (!useParsed.date && habisParsed.date) {
    windowStart = new Date(habisParsed.date.getTime() - DEEP_FALLBACK_LOOKBACK_DAYS * DAY_MS);
    windowEnd = new Date(habisParsed.date.getTime() + DEEP_BUFFER_DAYS * DAY_MS);
    warnings.push('USE DATE kosong/gak valid — scan mundur ' + DEEP_FALLBACK_LOOKBACK_DAYS + ' hari dari Habis Date sebagai perkiraan kasar.');
  } else {
    throw new Error('USE DATE dan HABIS DATE dua-duanya kosong/gak valid — gak bisa nentuin periode scan. Isi dulu kolom H & I buat akun ini.');
  }

  // ── CUTOFF AXM: window scan gak boleh mundur ke sebelum 25 Juli 2026 — sebelum itu kode
  // akun ini secara harfiah belum eksis (masih MYX), jadi gak ada gunanya nyari di sana. ──
  var cutoffDateObj = monthDayToDate_(AXM_CUTOFF_MONTH, AXM_CUTOFF_DAY, 2026);
  if (windowStart.getTime() < cutoffDateObj.getTime()) {
    windowStart = cutoffDateObj;
    warnings.push('Window scan dibatasi mulai ' + AXM_CUTOFF_DAY + ' ' + capitalize(AXM_CUTOFF_MONTH) + ' 2026 (tanggal pergantian kode akun MYX → AXM) — data sebelum itu pakai kode lama dan gak relevan buat akun ini, jadi gak ikut discan meskipun secara hitungan mundur seharusnya lebih awal.');
  }

  var allTitles = fetchAllSheetTitles_(AKUN_SHEETS_CONFIG);
  var targetSheetsPerConfig = allTitles.map(function(titles) {
    return titles.filter(function(name) {
      if (isBlacklistedSheetName_(name)) return false;
      if (isReportSheetName_(name)) return true;
      var md = extractTanggalBulanDariNamaSheet_(name);
      if (!md) return false;
      if (isBeforeAxmCutoff_(md.month, md.day)) return false; // cutoff AXM
      var d = monthDayToDate_(md.month, md.day, 2026);
      if (!d) return false;
      return d.getTime() >= startOfDay_(windowStart).getTime() && d.getTime() <= endOfDay_(windowEnd).getTime();
    });
  });

  var allValueRanges = fetchAllBatchValues_(AKUN_SHEETS_CONFIG, targetSheetsPerConfig);

  var transaksiValid = [], kandidatKosong = [], kandidatTypo = [], kandidatOrphan = [], handlerActivity = [];
  var totalTerpakai = 0, totalNominal = 0;
  var timelineMap = {};

  function addTimeline(t, key) {
    var k = t.tabSortKey;
    if (!timelineMap[k]) timelineMap[k] = { tanggal: t.tanggal, sortKey: k, valid: 0, validUsd: 0, kosong: 0, typo: 0, orphan: 0 };
    if (key === 'valid') { timelineMap[k].valid++; timelineMap[k].validUsd += t.harga; }
    else timelineMap[k][key]++;
  }

  AKUN_SHEETS_CONFIG.forEach(function(config, idx) {
    var targetSheets = targetSheetsPerConfig[idx];
    var valueRanges = allValueRanges[idx] || [];

    valueRanges.forEach(function(vr, i) {
      var sheetName = targetSheets[i];
      var md = extractTanggalBulanDariNamaSheet_(sheetName);
      var tabDateObj = md ? monthDayToDate_(md.month, md.day, 2026) : null;
      var tanggal = md ? (md.day + ' ' + capitalize(md.month)) : sheetName;
      var tabSortKey = tabDateObj ? tabDateObj.getTime() : 0;
      var rows = vr.values || [];

      rows.forEach(function(row, rIdx) {
        var akunRaw = String(row[config.akunCol] ?? "").trim().toLowerCase();
        var statusRaw = String(row[config.statusCol] ?? "").trim().toLowerCase();
        if (statusRaw !== "done") return;

        var parsed = parseNominal_(row[config.nominalCol]);
        if (!parsed) return;
        var hasil = hargaUntukNominal_(parsed.nominal, parsed.isPrem);
        if (!hasil) return;

        var baseInfo = { label: config.label, sheet: sheetName, tanggal: tanggal, tabSortKey: tabSortKey, row: rIdx + 1, nominal: parsed.nominal, isPrem: parsed.isPrem, harga: hasil.harga, isEstimasi: hasil.isEstimasi, kodeDitulis: akunRaw };

        if (akunRaw === kode) {
          transaksiValid.push(baseInfo);
          totalTerpakai += hasil.harga; totalNominal += parsed.nominal;
          addTimeline(baseInfo, 'valid');
          return;
        }
        if (!akunRaw) {
          kandidatKosong.push(baseInfo);
          addTimeline(baseInfo, 'kosong');
          return;
        }

        // ⚠️ FIX v7.1: dulu di sini cuma dicek "!akunRaw.startsWith('myx')" doang, jadi
        // transaksi milik AKUN LAIN YANG VALID (misal AXM67, udah akurat, gak ada masalah
        // apa-apa) bisa nyangkut jadi "kandidat typo" cuma gara-gara jarak Levenshtein ke
        // kode yang lagi discan kebetulan <= 2 (misal "axm57" vs "axm67" jaraknya cuma 1).
        // Itu FALSE POSITIVE — bukan human error, itu transaksi sah punya akun lain.
        //
        // Sekarang syaratnya SAMA PERSIS kayak kandidatOrphan: kode itu HARUS gak dikenal
        // sama sekali di sistem (bukan myx, DAN gak ada di kodeValidSet) baru dianggap
        // kandidat typo. Kalau kodenya valid milik akun lain, dia otomatis kelewat dari
        // kategori typo maupun orphan — sesuai permintaan: akun yang udah akurat jangan
        // kebawa ke identifier akun lain.
        if (!akunRaw.startsWith('myx') && !kodeValidSet.has(akunRaw)) {
          var jarak = levenshtein_(akunRaw, kode);
          if (jarak > 0 && jarak <= 2) {
            kandidatTypo.push(Object.assign({}, baseInfo, { jarak: jarak }));
            addTimeline(baseInfo, 'typo');
          }
        }

        if (!kodeValidSet.has(akunRaw) && !akunRaw.startsWith('myx')) {
          kandidatOrphan.push(baseInfo);
          addTimeline(baseInfo, 'orphan');
        } else {
          var akunLain = daftarAkun.find(function(a) { return a.kode.toLowerCase() === akunRaw; });
          if (akunLain && akunInfo.handler && akunLain.handler === akunInfo.handler) {
            handlerActivity.push(Object.assign({}, baseInfo, { handlerSama: akunInfo.handler }));
          }
        }
      });
    });
  });

  totalTerpakai = Math.round(totalTerpakai * 100) / 100;
  var selisih = Math.round((akunInfo.saldoAwal - totalTerpakai) * 100) / 100;
  var patternMatches = analyzeSelisihPattern_(Math.abs(selisih));
  var timeline = Object.keys(timelineMap).map(function(k) { return timelineMap[k]; }).sort(function(a, b) { return a.sortKey - b.sortKey; });

  return {
    kode: kode, handler: akunInfo.handler, handlerTim: akunInfo.handlerTim, statusAkun: akunInfo.statusAkun,
    saldoAwal: akunInfo.saldoAwal, lastBalance: akunInfo.lastBalance,
    useDateRaw: akunInfo.useDateRaw, habisDateRaw: akunInfo.habisDateRaw,
    windowStart: windowStart.toISOString(), windowEnd: windowEnd.toISOString(),
    warnings: warnings, totalTerpakai: totalTerpakai, totalNominal: totalNominal, selisih: selisih,
    transaksiValid: transaksiValid, kandidatKosong: kandidatKosong, kandidatTypo: kandidatTypo,
    kandidatOrphan: kandidatOrphan, handlerActivity: handlerActivity, timeline: timeline, patternMatches: patternMatches
  };
}
