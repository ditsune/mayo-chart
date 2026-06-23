// ============================================================
//  KALKULATOR TOTAL PROSES - MULTI SHEET WEB APP
//  Google Apps Script (HtmlService)
//  Versi: 5.0 — Tambah fitur item terjual
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

const PROGRESS_KEY = "CALC_PROGRESS";

// ── WEB APP ENTRY POINT ──────────────────────────────────────
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Total Proses & Item')
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

// ── PROGRESS ─────────────────────────────────────────────────
function setProgress(obj) {
  try {
    CacheService.getScriptCache().put(PROGRESS_KEY, JSON.stringify(obj), 300);
  } catch (e) {}
}

function getProgress() {
  try {
    const raw = CacheService.getScriptCache().get(PROGRESS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

// ── DIPANGGIL DARI WEB (google.script.run) ───────────────────
function hitungRekapWeb(bulan, tanggalMulai, tanggalAkhir) {
  bulan = String(bulan).trim().toLowerCase();
  tanggalMulai = parseInt(tanggalMulai, 10);
  tanggalAkhir = parseInt(tanggalAkhir, 10);

  if (!bulan) throw new Error("Nama bulan tidak boleh kosong.");
  if (isNaN(tanggalMulai) || tanggalMulai < 1 || tanggalMulai > 31) throw new Error("Tanggal mulai tidak valid (1-31).");
  if (isNaN(tanggalAkhir) || tanggalAkhir < tanggalMulai || tanggalAkhir > 31) throw new Error("Tanggal akhir tidak valid.");

  const bulanAliases     = resolveMonthAliases(bulan);
  const bulanCapitalized = capitalize(resolveCanonicalMonth(bulan));
  const periodeLabel     = `${tanggalMulai} - ${tanggalAkhir} ${bulanCapitalized} 2026`;

  const totalConfig  = SHEETS_CONFIG.length;
  const combinedMap  = {};
  const combinedItem = {};  // map gabungan item terjual
  const perSheet     = [];

  setProgress({ current: 0, total: totalConfig, text: "Memulai..." });

  SHEETS_CONFIG.forEach((config, idx) => {
    setProgress({
      current: idx,
      total: totalConfig,
      text: `Membuka ${config.label}...`,
    });

    try {
      const ss = SpreadsheetApp.openById(config.id);

      const targetSheets = ss.getSheets().filter(s =>
        isTargetSheet(s.getName(), bulanAliases, tanggalMulai, tanggalAkhir)
      );

      if (targetSheets.length === 0) {
        setProgress({ current: idx + 1, total: totalConfig, text: `${config.label}: tidak ada tab yang cocok` });
        perSheet.push({
          label: config.label, totalSheets: 0, skipped: [],
          admins: [], floppaTotal: 0, merpatiTotal: 0, grandTotal: 0,
          items: [], totalItemTerjual: 0,
        });
        return;
      }

      setProgress({ current: idx, total: totalConfig, text: `${config.label}: mengambil ${targetSheets.length} tab...` });

      const ranges      = targetSheets.map(s => s.getName());
      const batchResult = Sheets.Spreadsheets.Values.batchGet(config.id, { ranges });
      const valueRanges = batchResult.valueRanges || [];

      const adminMap = {};
      const itemMap  = {};
      const skipped  = [];

      valueRanges.forEach((vr, i) => {
        const sheetName = ranges[i];
        const rows      = vr.values || [];

        setProgress({ current: idx, total: totalConfig, text: `${config.label}: memproses "${sheetName}" (${i + 1}/${ranges.length})` });

        if (rows.length === 0) { skipped.push(sheetName); return; }

        // Baca data admin/proses
        const hasilAdmin = bacaDataSheet(rows, config.adminCol, config.prosesCol);
        if (!hasilAdmin) { skipped.push(sheetName); return; }

        hasilAdmin.forEach(({ admin, proses }) => {
          let key = admin.toUpperCase().trim();
          if (NAME_ALIASES[key]) key = NAME_ALIASES[key];
          adminMap[key]    = (adminMap[key]    || 0) + proses;
          combinedMap[key] = (combinedMap[key] || 0) + proses;
        });

        // Baca data item terjual
        const hasilItem = bacaDataItem(rows, config.itemCol, config.terjualCol);
        hasilItem.forEach(({ nama, terjual }) => {
          itemMap[nama]       = (itemMap[nama]       || 0) + terjual;
          combinedItem[nama]  = (combinedItem[nama]  || 0) + terjual;
        });
      });

      setProgress({ current: idx + 1, total: totalConfig, text: `${config.label} selesai` });

      perSheet.push({
        label: config.label,
        totalSheets: targetSheets.length,
        skipped,
        ...buildSortedResult(adminMap),
        ...buildItemResult(itemMap),
      });

    } catch (e) {
      setProgress({ current: idx + 1, total: totalConfig, text: `${config.label} error: ${e.message}` });
      perSheet.push({
        label: config.label,
        error: `Gagal: ${e.message}`,
        totalSheets: 0, skipped: [], admins: [], floppaTotal: 0, merpatiTotal: 0, grandTotal: 0,
        items: [], totalItemTerjual: 0,
      });
    }
  });

  setProgress({ current: totalConfig, total: totalConfig, text: "Selesai!", done: true });

  return {
    periodeLabel,
    perSheet,
    combined: {
      ...buildSortedResult(combinedMap),
      ...buildItemResult(combinedItem),
    },
  };
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
// Cari baris yang mengandung "nama item" sebagai header,
// lalu baca baris berikutnya sampai ketemu "total" atau baris kosong.
function bacaDataItem(rows, itemCol, terjualCol) {
  itemCol    = itemCol    ?? 10;
  terjualCol = terjualCol ?? 11;

  const result     = [];
  let headerFound  = false;

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];

    if (!headerFound) {
      // Cari header "nama item" di kolom mana saja
      const hasHeader = row.some(cell =>
        String(cell ?? "").trim().toLowerCase() === "nama item"
      );
      if (hasHeader) { headerFound = true; }
      continue;
    }

    const namaRaw   = String(row[itemCol]    ?? "").trim();
    const terjualRaw = String(row[terjualCol] ?? "").trim();

    // Stop saat ketemu baris "total" atau nama kosong setelah sudah dapat data
    if (namaRaw.toLowerCase() === "total") break;
    if (!namaRaw) {
      if (result.length > 0) break;  // baris kosong setelah data = selesai
      continue;
    }

    const terjual = Number(terjualRaw);
    if (isNaN(terjual) || terjual <= 0) continue;  // skip item 0 terjual

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
