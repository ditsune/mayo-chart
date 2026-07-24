// ============================================================
//  MAYO TOOLS — Rekap Proses/Item + Saldo Akun (Merged Project)
//  Google Apps Script (HtmlService)
// ============================================================

// ⚠️ KONFIGURASI SPREADSHEET — REKAP PROSES/ITEM
const SHEETS_CONFIG = [
  { id: "19yETtrXqCAf_fjhfHgtqaRhKLXRraM8P-uRwW_r10Hg", label: "Sheet Website",  adminCol: 13, prosesCol: 14, itemCol: 10, terjualCol: 11 },
  { id: "1GmOzkKSjUaFkGGiQC4ITrFAzdrqYUhf_n24HnN-zP1U", label: "Sheet Telegram", adminCol: 14, prosesCol: 15, itemCol: 11, terjualCol: 12 },
  { id: "179HJQc9q-UssQNjlMtuxE6HNl-GkIpSGJqOaXyC3n_U", label: "Sheet Reseller", adminCol: 13, prosesCol: 14, itemCol: 10, terjualCol: 11 },
];

// ⚠️ KONFIGURASI SPREADSHEET — SALDO AKUN
const AKUN_SHEETS_CONFIG = [
  { id: "1GmOzkKSjUaFkGGiQC4ITrFAzdrqYUhf_n24HnN-zP1U", label: "Telegram", akunCol: 1, nominalCol: 5, statusCol: 6 },  // B=1, F=5, G=6
  { id: "179HJQc9q-UssQNjlMtuxE6HNl-GkIpSGJqOaXyC3n_U", label: "Reseller", akunCol: 1, nominalCol: 4, statusCol: 5 },  // B=1, E=4, F=5
  { id: "19yETtrXqCAf_fjhfHgtqaRhKLXRraM8P-uRwW_r10Hg", label: "Website",  akunCol: 7, nominalCol: 4, statusCol: 5 },  // H=7, E=4, F=5
];

// ── KONFIGURASI TIM (dipakai rekap proses) ──────────────────
const TIM_CONFIG = {
  FLOPPA:  ["KRISNA", "ADIT", "INDRA"],
  MERPATI: ["RIZKI", "RANGGA", "ARI PERSIB"],
};
const NAME_ALIASES = { "ARI PERSIB": "ARI" };
const SKIP_KEYWORDS = ["admin", "proses", "total proses", "total", ""];

// ── HARGA TABLE (dipakai saldo akun) ────────────────────────
const HARGA_TABLE = {
  80:0.99, 160:1.98, 240:2.97, 320:3.96, 500:4.99,
  1000:9.99, 1080:10.98, 1160:11.97, 1240:12.96, 1320:13.95, 1500:14.98,
  2000:19.99, 2500:24.98, 3000:29.98, 3500:34.98, 4000:39.98, 4500:44.98,
  5000:49.98, 5500:54.98, 6000:59.97, 6500:64.97, 7000:69.97, 7500:74.97,
  8000:79.96, 8500:84.96, 9000:89.96, 9500:94.96, 10000:99.95,
  15000:149.92, 17000:169.91, 31000:309.84
};
const HARGA_TABLE_PREM = { 450: 5.99, 1000: 9.99, 2200: 19.99 };
const HARGA_PER_DENOM_SEN = { 2000: 1999, 1000: 999, 500: 499, 80: 99 };

// ── ALIAS NAMA BULAN (SHARED) ────────────────────────────────
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
const RESULT_CACHE_TTL   = 120; // detik — cache hasil hitung per periode (rekap proses)
const CACHE_VALUE_MAX_BYTES = 95000; // batas aman CacheService (limit sebenarnya 100KB/key)

// ── WEB APP ENTRY POINT ──────────────────────────────────────
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Mayo Tools by Dits')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// ══════════════════════════════════════════════════════════
//  SHARED HELPERS (dipakai kedua fitur — jangan diduplikat!)
// ══════════════════════════════════════════════════════════

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

// Ambil daftar nama tab untuk semua spreadsheet sekaligus (paralel).
// configs bisa SHEETS_CONFIG ATAU AKUN_SHEETS_CONFIG — generik.
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

// Ambil values untuk semua spreadsheet sekaligus (paralel).
// Menerima colConfig fleksibel: fungsi ini butuh tahu kolom mana saja yang
// perlu di-buffer, jadi kita hitung maxCol dari semua field angka di config.
function fetchAllBatchValues_(configs, targetSheetsPerConfig) {
  const requestSpecs = configs.map((c, i) => {
    const sheetNames = targetSheetsPerConfig[i];
    if (!sheetNames.length) return null;

    const colFields = Object.keys(c).filter(k => k.endsWith('Col')).map(k => c[k]);
    const maxCol    = Math.max.apply(null, colFields) + 2; // +2 buffer aman
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

// ── PROGRESS (per-user — dipakai rekap proses) ───────────────
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

function buildCacheKey_(bulan, tanggalMulai, tanggalAkhir) {
  return `REKAP_${resolveCanonicalMonth(bulan)}_${tanggalMulai}_${tanggalAkhir}`;
}


// ══════════════════════════════════════════════════════════
//  FITUR 1 — REKAP TOTAL PROSES & ITEM (Website/Telegram/Reseller)
// ══════════════════════════════════════════════════════════

function hitungRekapWeb(bulan, tanggalMulai, tanggalAkhir, bypassCache) {
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

  const allTitles = fetchAllSheetTitles_(SHEETS_CONFIG);
  const targetSheetsPerConfig = allTitles.map(titles =>
    titles.filter(name => isTargetSheet(name, bulanAliases, tanggalMulai, tanggalAkhir))
  );

  setProgress({ current: 1, total: 3, text: "Mengambil data (paralel)..." });

  const allValueRanges = fetchAllBatchValues_(SHEETS_CONFIG, targetSheetsPerConfig);

  setProgress({ current: 2, total: 3, text: "Menyusun rekap..." });

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

  try {
    const serialized = JSON.stringify(finalResult);
    if (serialized.length < CACHE_VALUE_MAX_BYTES) {
      CacheService.getScriptCache().put(cacheKey, serialized, RESULT_CACHE_TTL);
    }
  } catch (e) { /* kalau kegedean / gagal cache, gapapa, tetep return hasil */ }

  return finalResult;
}

function buildSortedResult(adminMap) {
  const sorted = Object.entries(adminMap)
    .map(([admin, total]) => ({ admin, total, tim: getTim(admin) }))
    .sort((a, b) => b.total - a.total);

  const floppaTotal  = sorted.filter(a => a.tim === "FLOPPA").reduce((s, a) => s + a.total, 0);
  const merpatiTotal = sorted.filter(a => a.tim === "MERPATI").reduce((s, a) => s + a.total, 0);
  const grandTotal   = sorted.reduce((s, a) => s + a.total, 0);

  return { admins: sorted, floppaTotal, merpatiTotal, grandTotal };
}

function buildItemResult(itemMap) {
  const sorted = Object.entries(itemMap)
    .map(([nama, terjual]) => ({ nama, terjual }))
    .sort((a, b) => b.terjual - a.terjual);

  const totalItemTerjual = sorted.reduce((s, i) => s + i.terjual, 0);

  return { items: sorted, totalItemTerjual };
}

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

function getTim(adminName) {
  const key = adminName.toUpperCase().trim();
  if (TIM_CONFIG.FLOPPA.some(m => m.toUpperCase() === key))  return "FLOPPA";
  if (TIM_CONFIG.MERPATI.some(m => m.toUpperCase() === key)) return "MERPATI";
  if (key === "ARI") return "MERPATI";
  return "LAINNYA";
}


// ══════════════════════════════════════════════════════════
//  FITUR 2 — SALDO AKUN (dulu project terpisah "Cek Saldo Akun Myx")
// ══════════════════════════════════════════════════════════

function hitungHargaGreedy_(nominal) {
  let sisa = nominal;
  let totalSen = 0;
  for (const denom of [2000, 1000, 500, 80]) {
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
  if (kMatch) return { nominal: Math.round(parseFloat(kMatch[1]) * 1000), isPrem };

  const cleaned = s.replace(/\./g, "");
  const numMatch = cleaned.match(/\d+/);
  if (!numMatch) return null;

  return { nominal: parseInt(numMatch[0], 10), isPrem };
}

function hargaUntukNominal_(nominal, isPrem) {
  if (isPrem) {
    return HARGA_TABLE_PREM.hasOwnProperty(nominal)
      ? { harga: HARGA_TABLE_PREM[nominal], isEstimasi: false }
      : null;
  }

  if (HARGA_TABLE.hasOwnProperty(nominal)) {
    return { harga: HARGA_TABLE[nominal], isEstimasi: false };
  }

  const estimasi = hitungHargaGreedy_(nominal);
  return estimasi !== null ? { harga: estimasi, isEstimasi: true } : null;
}

function hitungSaldoAkun(kodeAkun, bulan, tanggalMulai, tanggalAkhir) {
  kodeAkun = String(kodeAkun).trim().toLowerCase();
  bulan = String(bulan).trim().toLowerCase();
  tanggalMulai = parseInt(tanggalMulai, 10);
  tanggalAkhir = parseInt(tanggalAkhir, 10);

  if (!kodeAkun) throw new Error("Kode akun tidak boleh kosong.");
  if (!bulan) throw new Error("Bulan tidak boleh kosong.");
  if (isNaN(tanggalMulai) || tanggalMulai < 1 || tanggalMulai > 31) throw new Error("Tanggal mulai tidak valid (1-31).");
  if (isNaN(tanggalAkhir) || tanggalAkhir < tanggalMulai || tanggalAkhir > 31) throw new Error("Tanggal akhir tidak valid.");

  const bulanAliases = resolveMonthAliases(bulan);

  const allTitles = fetchAllSheetTitles_(AKUN_SHEETS_CONFIG);
  const targetSheetsPerConfig = allTitles.map(titles =>
    titles.filter(name => isTargetSheet(name, bulanAliases, tanggalMulai, tanggalAkhir))
  );
  const allValueRanges = fetchAllBatchValues_(AKUN_SHEETS_CONFIG, targetSheetsPerConfig);

  let totalSaldoTerpakai = 0;
  let totalNominalTerpakai = 0; // dalam Robux — dipakai buat dibandingin sama saldo awal
  const perSheet = [];
  const failedRows = [];
  const estimasiRows = [];
  const successLog = [];

  AKUN_SHEETS_CONFIG.forEach((config, idx) => {
    const targetSheets = targetSheetsPerConfig[idx];
    const valueRanges  = allValueRanges[idx] || [];
    let sheetTotal = 0;
    let sheetNominal = 0; // Robux
    let jumlahTransaksi = 0;

    valueRanges.forEach((vr, i) => {
      const sheetName = targetSheets[i];
      const rows = vr.values || [];
      let jumlahDiTab = 0;

      rows.forEach((row, rIdx) => {
        const akunRaw = String(row[config.akunCol] ?? "").trim().toLowerCase();
        if (akunRaw !== kodeAkun) return;

        const statusRaw = String(row[config.statusCol] ?? "").trim().toLowerCase();
        if (statusRaw !== "done") {
          failedRows.push({
            sheet: sheetName, label: config.label, row: rIdx + 1,
            alasan: "Status bukan Done (nilai: \"" + (String(row[config.statusCol] ?? "").trim() || "kosong") + "\")",
            raw: String(row[config.nominalCol] ?? "")
          });
          return;
        }

        const nominalRaw = row[config.nominalCol];
        const parsed = parseNominal_(nominalRaw);

        if (parsed === null) {
          failedRows.push({ sheet: sheetName, label: config.label, row: rIdx + 1, alasan: "Nominal tidak terbaca", raw: String(nominalRaw) });
          return;
        }

        const hasil = hargaUntukNominal_(parsed.nominal, parsed.isPrem);
        if (hasil === null) {
          failedRows.push({ sheet: sheetName, label: config.label, row: rIdx + 1, alasan: "Nominal " + parsed.nominal + (parsed.isPrem ? " PREM" : "") + " belum ada di tabel & gak bisa didekomposisi", raw: String(nominalRaw) });
          return;
        }

        sheetTotal += hasil.harga;
        sheetNominal += parsed.nominal;
        jumlahTransaksi++;
        jumlahDiTab++;

        if (hasil.isEstimasi) {
          estimasiRows.push({ sheet: sheetName, label: config.label, row: rIdx + 1, nominal: parsed.nominal, harga: hasil.harga });
        }
      });

      successLog.push({ label: config.label, sheet: sheetName, jumlahData: jumlahDiTab });
    });

    totalSaldoTerpakai += sheetTotal;
    totalNominalTerpakai += sheetNominal;
    perSheet.push({ label: config.label, total: sheetTotal, nominalTerpakai: sheetNominal, jumlahTransaksi });
  });

  return {
    kodeAkun,
    periodeLabel: `${tanggalMulai} - ${tanggalAkhir} ${capitalize(resolveCanonicalMonth(bulan))} 2026`,
    totalSaldoTerpakai,
    totalNominalTerpakai,
    perSheet,
    failedRows,
    estimasiRows,
    successLog,
  };
}
