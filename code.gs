// ============================================================
//  KALKULATOR TOTAL PROSES - MULTI SHEET WEB APP
//  Google Apps Script (HtmlService)
//  Versi: 6.0 — Performance overhaul:
//   - Parallel fetch (UrlFetchApp.fetchAll) ganti sequential forEach
//   - Ambil daftar tab via Sheets REST API (bukan SpreadsheetApp.getSheets)
//   - batchGet dibatasi kolom + UNFORMATTED_VALUE (payload lebih kecil, lebih cepat)
//   - Result caching per (bulan+range) supaya user lain yg minta periode sama dapet instant
//   - Progress cache jadi per-user (getUserCache), bukan global
// ============================================================

// ⚠️ KONFIGURASI 3 SPREADSHEET DI SINI
const SHEETS_CONFIG = [
  { id: "19yETtrXqCAf_fjhfHgtqaRhKLXRraM8P-uRwW_r10Hg", label: "Sheet Website",  adminCol: 13, prosesCol: 14, itemCol: 10, terjualCol: 11 },
  { id: "1GmOzkKSjUaFkGGiQC4ITrFAzdrqYUhf_n24HnN-zP1U", label: "Sheet Telegram", adminCol: 14, prosesCol: 15, itemCol: 11, terjualCol: 12 },
  { id: "179HJQc9q-UssQNjlMtuxE6HNl-GkIpSGJqOaXyC3n_U", label: "Sheet Reseller", adminCol: 13, prosesCol: 14, itemCol: 10, terjualCol: 11 },
];

// ── KONFIGURASI TIM ─────────────────────────────────────────
const TIM_CONFIG = {
  FLOPPA:  ["KRISNA", "ADIT", "INDRA"],
  MERPATI: ["RIZKI", "RANGGA", "ARI PERSIB"],
};

const NAME_ALIASES = {
  "ARI PERSIB": "ARI",
};

const SKIP_KEYWORDS = ["admin", "proses", "total proses", "total", ""];

// ── ALIAS NAMA BULAN ──────────────────────────────────────────
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

const PROGRESS_KEY   = "CALC_PROGRESS";
const RESULT_CACHE_TTL   = 120; // detik — cache hasil hitung per periode
const CACHE_VALUE_MAX_BYTES = 95000; // batas aman CacheService (limit sebenarnya 100KB/key)

// ── WEB APP ENTRY POINT ──────────────────────────────────────
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Rekap Sheet Mayo')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// ── HELPER ALIAS BULAN ────────────────────────────────────────
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

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ── PROGRESS (per-user, bukan global lagi) ───────────────────
function setProgress(obj) {
  try {
    CacheService.getUserCache().put(PROGRESS_KEY, JSON.stringify(obj), 300);
  } catch (e) {}
}

function getProgress() {
  try {
    const raw = CacheService.getUserCache().get(PROGRESS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

// ── AMBIL OAUTH TOKEN UNTUK PANGGIL SHEETS REST API LANGSUNG ─
// (dipakai biar bisa fetchAll / paralel — advanced service Sheets.* tidak bisa)
function authHeader_() {
  return { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() };
}

function columnToLetter_(col) {
  let letter = '';
  while (col > 0) {
    const rem = (col - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    col = Math.floor((col - 1) / 26);
  }
  return letter;
}

// ── AMBIL DAFTAR NAMA TAB UNTUK SEMUA SPREADSHEET SEKALIGUS (PARALEL) ─
function fetchAllSheetTitles_(configs) {
  const requests = configs.map(c => ({
    url: `https://sheets.googleapis.com/v4/spreadsheets/${c.id}?fields=sheets.properties.title`,
    headers: authHeader_(),
    muteHttpExceptions: true,
  }));

  const responses = UrlFetchApp.fetchAll(requests);

  return responses.map((res, i) => {
    const code = res.getResponseCode();
    if (code !== 200) {
      throw new Error(`Gagal ambil daftar tab "${configs[i].label}" (HTTP ${code}): ${res.getContentText().slice(0, 200)}`);
    }
    const json = JSON.parse(res.getContentText());
    return (json.sheets || []).map(s => s.properties.title);
  });
}

// ── AMBIL VALUES UNTUK SEMUA SPREADSHEET SEKALIGUS (PARALEL) ─────
// targetSheetsPerConfig[i] = array nama tab yang mau diambil utk configs[i]
function fetchAllBatchValues_(configs, targetSheetsPerConfig) {
  const requestSpecs = configs.map((c, i) => {
    const sheetNames = targetSheetsPerConfig[i];
    if (!sheetNames.length) return null;

    const maxCol    = Math.max(c.adminCol, c.prosesCol, c.itemCol, c.terjualCol) + 2; // +2 buffer aman
    const colLetter = columnToLetter_(maxCol);

    const rangeParams = sheetNames
      .map(n => `ranges=${encodeURIComponent(`'${n.replace(/'/g, "''")}'!A1:${colLetter}`)}`)
      .join('&');

    return {
      url: `https://sheets.googleapis.com/v4/spreadsheets/${c.id}/values:batchGet?${rangeParams}&valueRenderOption=UNFORMATTED_VALUE`,
      headers: authHeader_(),
      muteHttpExceptions: true,
    };
  });

  const validIdx = [];
  const validRequests = [];
  requestSpecs.forEach((r, i) => { if (r) { validIdx.push(i); validRequests.push(r); } });

  const responses = validRequests.length ? UrlFetchApp.fetchAll(validRequests) : [];

  const results = new Array(configs.length).fill(null);
  responses.forEach((res, k) => {
    const i = validIdx[k];
    const code = res.getResponseCode();
    if (code !== 200) {
      throw new Error(`Gagal ambil data "${configs[i].label}" (HTTP ${code}): ${res.getContentText().slice(0, 200)}`);
    }
    results[i] = JSON.parse(res.getContentText()).valueRanges || [];
  });
  return results;
}

// ── CACHE KEY HELPER ──────────────────────────────────────────
function buildCacheKey_(bulan, tanggalMulai, tanggalAkhir) {
  return `REKAP_${resolveCanonicalMonth(bulan)}_${tanggalMulai}_${tanggalAkhir}`;
}

// ── DIPANGGIL DARI WEB (google.script.run) ───────────────────
function hitungRekapWeb(bulan, tanggalMulai, tanggalAkhir, bypassCache) {
  bulan = String(bulan).trim().toLowerCase();
  tanggalMulai = parseInt(tanggalMulai, 10);
  tanggalAkhir = parseInt(tanggalAkhir, 10);

  if (!bulan) throw new Error("Nama bulan tidak boleh kosong.");
  if (isNaN(tanggalMulai) || tanggalMulai < 1 || tanggalMulai > 31) throw new Error("Tanggal mulai tidak valid (1-31).");
  if (isNaN(tanggalAkhir) || tanggalAkhir < tanggalMulai || tanggalAkhir > 31) throw new Error("Tanggal akhir tidak valid.");

  const cacheKey = buildCacheKey_(bulan, tanggalMulai, tanggalAkhir);

  // ── Cek cache dulu (kecuali user klik Refresh / bypassCache) ──
  if (!bypassCache) {
    try {
      const cached = CacheService.getScriptCache().get(cacheKey);
      if (cached) {
        setProgress({ current: 1, total: 1, text: "Diambil dari cache", done: true });
        return JSON.parse(cached);
      }
    } catch (e) { /* cache miss/corrupt, lanjut hitung normal */ }
  }

  const bulanAliases     = resolveMonthAliases(bulan);
  const bulanCapitalized = capitalize(resolveCanonicalMonth(bulan));
  const periodeLabel     = `${tanggalMulai} - ${tanggalAkhir} ${bulanCapitalized} 2026`;

  setProgress({ current: 0, total: 3, text: "Mengambil daftar tab (paralel)..." });

  // ── TAHAP 1: ambil nama semua tab dari 3 spreadsheet SEKALIGUS ──
  const allTitles = fetchAllSheetTitles_(SHEETS_CONFIG);

  const targetSheetsPerConfig = allTitles.map(titles =>
    titles.filter(name => isTargetSheet(name, bulanAliases, tanggalMulai, tanggalAkhir))
  );

  setProgress({ current: 1, total: 3, text: "Mengambil data (paralel)..." });

  // ── TAHAP 2: ambil isi semua tab yang cocok dari 3 spreadsheet SEKALIGUS ──
  const allValueRanges = fetchAllBatchValues_(SHEETS_CONFIG, targetSheetsPerConfig);

  setProgress({ current: 2, total: 3, text: "Menyusun rekap..." });

  // ── TAHAP 3: proses data (murni lokal, cepat) ──
  const combinedMap  = {};
  const combinedItem = {};
  const perSheet      = [];

  SHEETS_CONFIG.forEach((config, idx) => {
    const targetSheets = targetSheetsPerConfig[idx];

    if (targetSheets.length === 0) {
      perSheet.push({
        label: config.label, totalSheets: 0, skipped: [],
        admins: [], floppaTotal: 0, merpatiTotal: 0, grandTotal: 0,
        items: [], totalItemTerjual: 0,
      });
      return;
    }

    const valueRanges = allValueRanges[idx] || [];
    const adminMap = {};
    const itemMap  = {};
    const skipped  = [];

    valueRanges.forEach((vr, i) => {
      const sheetName = targetSheets[i];
      const rows      = vr.values || [];

      if (rows.length === 0) { skipped.push(sheetName); return; }

      const hasilAdmin = bacaDataSheet(rows, config.adminCol, config.prosesCol);
      if (!hasilAdmin) { skipped.push(sheetName); return; }

      hasilAdmin.forEach(({ admin, proses }) => {
        let key = admin.toUpperCase().trim();
        if (NAME_ALIASES[key]) key = NAME_ALIASES[key];
        adminMap[key]    = (adminMap[key]    || 0) + proses;
        combinedMap[key] = (combinedMap[key] || 0) + proses;
      });

      const hasilItem = bacaDataItem(rows, config.itemCol, config.terjualCol);
      hasilItem.forEach(({ nama, terjual }) => {
        itemMap[nama]      = (itemMap[nama]      || 0) + terjual;
        combinedItem[nama] = (combinedItem[nama] || 0) + terjual;
      });
    });

    perSheet.push({
      label: config.label,
      totalSheets: targetSheets.length,
      skipped,
      ...buildSortedResult(adminMap),
      ...buildItemResult(itemMap),
    });
  });

  setProgress({ current: 3, total: 3, text: "Selesai!", done: true });

  const finalResult = {
    periodeLabel,
    perSheet,
    combined: {
      ...buildSortedResult(combinedMap),
      ...buildItemResult(combinedItem),
    },
  };

  // ── Simpan ke cache buat user lain yang minta periode sama ──
  try {
    const serialized = JSON.stringify(finalResult);
    if (serialized.length < CACHE_VALUE_MAX_BYTES) {
      CacheService.getScriptCache().put(cacheKey, serialized, RESULT_CACHE_TTL);
    }
  } catch (e) { /* kalau kegedean / gagal cache, gapapa, tetep return hasil */ }

  return finalResult;
}

// ── HELPER: SUSUN HASIL ADMIN TERURUT ────────────────────────
function buildSortedResult(adminMap) {
  const sorted = Object.entries(adminMap)
    .map(([admin, total]) => ({ admin, total, tim: getTim(admin) }))
    .sort((a, b) => b.total - a.total);

  const floppaTotal  = sorted.filter(a => a.tim === "FLOPPA").reduce((s, a) => s + a.total, 0);
  const merpatiTotal = sorted.filter(a => a.tim === "MERPATI").reduce((s, a) => s + a.total, 0);
  const grandTotal   = sorted.reduce((s, a) => s + a.total, 0);

  return { admins: sorted, floppaTotal, merpatiTotal, grandTotal };
}

// ── HELPER: SUSUN HASIL ITEM TERURUT ─────────────────────────
function buildItemResult(itemMap) {
  const sorted = Object.entries(itemMap)
    .map(([nama, terjual]) => ({ nama, terjual }))
    .sort((a, b) => b.terjual - a.terjual);

  const totalItemTerjual = sorted.reduce((s, i) => s + i.terjual, 0);

  return { items: sorted, totalItemTerjual };
}

// ── FILTER TAB ───────────────────────────────────────────────
function isTargetSheet(name, bulanAliases, tanggalMulai, tanggalAkhir) {
  const lower = name.toLowerCase().trim();
  const blacklist = ["template", "akun", "summary", "log", "total proses"];
  if (blacklist.some(b => lower.includes(b))) return false;

  let bulanIdx = -1;
  for (const alias of bulanAliases) {
    const idx = lower.indexOf(alias);
    if (idx !== -1) { bulanIdx = idx; break; }
  }
  if (bulanIdx === -1) return false;

  const prefix = lower.substring(0, bulanIdx).trim();
  const digits = prefix.replace(/\D/g, "");
  if (!digits) return false;

  const tgl = parseInt(digits, 10);
  if (isNaN(tgl)) return false;
  return tgl >= tanggalMulai && tgl <= tanggalAkhir;
}

// ── BACA DATA ADMIN/PROSES ───────────────────────────────────
function bacaDataSheet(rows, adminCol, prosesCol) {
  adminCol  = adminCol  ?? 13;
  prosesCol = prosesCol ?? 14;

  const result = [];
  let inBlock = false;
  let headerPassed = false;

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];

    if (!inBlock) {
      if (row.some(cell => String(cell ?? "").trim().toLowerCase() === "total proses")) {
        inBlock = true;
      }
      continue;
    }

    if (!headerPassed) {
      if (row.some(cell => String(cell ?? "").trim().toLowerCase() === "admin")) {
        headerPassed = true;
      }
      continue;
    }

    const adminVal  = String(row[adminCol] ?? "").trim();
    const prosesVal = row[prosesCol];

    if (adminVal.toLowerCase() === "total") break;
    if (!adminVal || SKIP_KEYWORDS.includes(adminVal.toLowerCase())) continue;

    const proses = Number(prosesVal);
    if (isNaN(proses) || proses <= 0) continue;

    result.push({ admin: adminVal, proses });
  }

  return result.length > 0 ? result : null;
}

// ── BACA DATA ITEM TERJUAL ───────────────────────────────────
function bacaDataItem(rows, itemCol, terjualCol) {
  itemCol    = itemCol    ?? 10;
  terjualCol = terjualCol ?? 11;

  const result     = [];
  let headerFound  = false;

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];

    if (!headerFound) {
      const hasHeader = row.some(cell =>
        String(cell ?? "").trim().toLowerCase() === "nama item"
      );
      if (hasHeader) { headerFound = true; }
      continue;
    }

    const namaRaw    = String(row[itemCol]    ?? "").trim();
    const terjualRaw = String(row[terjualCol] ?? "").trim();

    if (namaRaw.toLowerCase() === "total") break;
    if (!namaRaw) {
      if (result.length > 0) break;
      continue;
    }

    const terjual = Number(terjualRaw);
    if (isNaN(terjual) || terjual <= 0) continue;

    result.push({ nama: namaRaw, terjual });
  }

  return result;
}

// ── HELPER TIM ───────────────────────────────────────────────
function getTim(adminName) {
  const key = adminName.toUpperCase().trim();
  if (TIM_CONFIG.FLOPPA.some(m => m.toUpperCase() === key))  return "FLOPPA";
  if (TIM_CONFIG.MERPATI.some(m => m.toUpperCase() === key)) return "MERPATI";
  if (key === "ARI") return "MERPATI";
  return "LAINNYA";
}
