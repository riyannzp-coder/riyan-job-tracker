/**
 * Job Search Tracker — Data Store API on Google Sheets.
 *
 * Paste this file into Extensions → Apps Script of your Google Sheet, run setup() once,
 * then Deploy → New deployment → Web app (Execute as: Me, Who has access: Anyone).
 * The dashboard talks to the /exec URL with the API key that setup() prints to the log.
 *
 * Tab
 *   Lamaran   one readable row per application. You can also edit it by hand in the sheet:
 *             the dashboard reads status, source and dates back from the labels.
 */

const TAB = 'Lamaran';
const COLS = [
  ['id', 'id'], ['company', 'Perusahaan'], ['position', 'Posisi'], ['source', 'Sumber'],
  ['referrer', 'Direferensikan oleh'], ['appliedDate', 'Tgl apply / dihubungi'], ['status', 'Status'],
  ['lastStage', 'Berhenti di tahap'], ['nextStep', 'Langkah berikutnya'], ['nextDate', 'Tgl langkah berikutnya'],
  ['workType', 'Tipe kerja'], ['location', 'Lokasi'], ['salary', 'Ekspektasi gaji'], ['contact', 'Kontak HR / recruiter'],
  ['link', 'Link lowongan'], ['notes', 'Catatan'], ['updatedAt', 'Terakhir update'],
];
const FIELDS = COLS.map(c => c[0]);
const DATE_FIELDS = ['appliedDate', 'nextDate', 'updatedAt'];
// status codes the dashboard uses ↔ labels shown in the sheet
const STATUS = {
  applied: 'Applied', contacted: 'Contacted', screening: 'Screening CV', test: 'Tes / assessment',
  int_hr: 'Interview HR', int_user: 'Interview user', final: 'Final interview', offer: 'Offering',
  accepted: 'Diterima', rejected: 'Ditolak', ghosted: 'Tidak ada kabar', withdrawn: 'Memutuskan untuk tidak lanjut',
};
const STAGE_CODES = ['applied', 'contacted', 'screening', 'test', 'int_hr', 'int_user', 'final'];
const SOURCES = ['LinkedIn', 'Referral', 'Website perusahaan', 'Job portal', 'Lainnya'];
const WORK = ['Onsite', 'Hybrid', 'Remote'];

/** Run once from the editor: creates the tab, dropdowns and an API key (see View → Logs). */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(TAB) || ss.insertSheet(TAB);
  sh.getRange(1, 1, 1, COLS.length).setValues([COLS.map(c => c[1])])
    .setFontWeight('bold').setBackground('#3a1736').setFontColor('#ffffff');
  sh.setFrozenRows(1);
  sh.setFrozenColumns(2);
  col_('id').setNumberFormat('@');
  DATE_FIELDS.forEach(f => col_(f).setNumberFormat('yyyy-mm-dd'));
  col_('salary').setNumberFormat('#,##0');
  const list = values => SpreadsheetApp.newDataValidation().requireValueInList(values, true).setAllowInvalid(false).build();
  col_('status').setDataValidation(list(Object.keys(STATUS).map(k => STATUS[k])));
  col_('lastStage').setDataValidation(list(STAGE_CODES.map(k => STATUS[k])));
  col_('source').setDataValidation(list(SOURCES));
  col_('workType').setDataValidation(list(WORK));
  sh.hideColumns(1);                                   // the id column is for the dashboard only
  const props = PropertiesService.getScriptProperties();
  let key = props.getProperty('API_KEY');
  if (!key) { key = Utilities.getUuid().replace(/-/g, ''); props.setProperty('API_KEY', key); }
  Logger.log('API key: ' + key);
}

/** Run this if the key ever leaks: the old one stops working immediately. */
function rotateKey() {
  const key = Utilities.getUuid().replace(/-/g, '');
  PropertiesService.getScriptProperties().setProperty('API_KEY', key);
  Logger.log('New API key: ' + key);
}

function doGet() {
  return json_({ ok: true, service: 'job-search-tracker', hint: 'Use POST with your API key.' });
}

function doPost(e) {
  let body;
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch (err) { return json_({ ok: false, error: 'bad_json' }); }
  const expected = PropertiesService.getScriptProperties().getProperty('API_KEY');
  if (!expected || body.key !== expected) return json_({ ok: false, error: 'unauthorized' });

  try {
    switch (body.action) {
      case 'ping': return json_({ ok: true, sheet: SpreadsheetApp.getActiveSpreadsheet().getName() });
      case 'all': return json_({ ok: true, apps: readAll_() });
      case 'set': return withLock_(() => { upsert_([body.app]); return json_({ ok: true }); });
      case 'delete': return withLock_(() => { deleteRow_(body.id); return json_({ ok: true }); });
      case 'import': return withLock_(() => { upsert_(body.apps || []); return json_({ ok: true, total: readAll_().length }); });
      default: return json_({ ok: false, error: 'unknown_action' });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

/* ---------- read ---------- */
function readAll_() {
  const sh = sheet_(), last = sh.getLastRow();
  if (last < 2) return [];
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const labelToCode = {};
  Object.keys(STATUS).forEach(k => { labelToCode[STATUS[k].toLowerCase()] = k; labelToCode[k] = k; });
  return sh.getRange(2, 1, last - 1, FIELDS.length).getValues()
    .map((r, i) => {
      const a = {};
      FIELDS.forEach((f, j) => {
        let v = r[j];
        if (v instanceof Date) v = Utilities.formatDate(v, tz, 'yyyy-MM-dd');
        if (f === 'status' || f === 'lastStage') v = labelToCode[String(v).trim().toLowerCase()] || '';
        a[f] = v === null || v === undefined ? '' : (f === 'salary' && v !== '' ? v : String(v));
      });
      // a row typed by hand in the sheet gets an id the first time it is read
      if (!a.id && a.company) { a.id = 'r' + Utilities.getUuid().replace(/-/g, '').slice(0, 12); sh.getRange(i + 2, 1).setValue(a.id); }
      if (a.company && !a.status) a.status = 'applied';
      return a;
    })
    .filter(a => a.id && a.company);
}

/* ---------- write ---------- */
function toRow_(a) {
  return FIELDS.map(f => {
    const v = a[f];
    if (f === 'status' || f === 'lastStage') return STATUS[v] || '';
    if (DATE_FIELDS.indexOf(f) >= 0 && /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''))) {
      const p = String(v).split('-').map(Number);
      return new Date(p[0], p[1] - 1, p[2]);
    }
    if (f === 'salary' && v !== '' && v != null && !isNaN(Number(v))) return Number(v);
    return v == null ? '' : String(v);
  });
}

// one read of the id column, then each application overwrites its own row or is appended
function upsert_(apps) {
  const sh = sheet_(), last = sh.getLastRow();
  const ids = last > 1 ? sh.getRange(2, 1, last - 1, 1).getValues().map(r => String(r[0])) : [];
  let next = last + 1;
  apps.forEach(a => {
    if (!a || !a.id || !/^[A-Za-z0-9_-]{1,64}$/.test(String(a.id))) throw new Error('bad_id');
    if (!a.company) throw new Error('missing_company');
    const i = ids.indexOf(String(a.id));
    const target = i >= 0 ? i + 2 : next++;
    if (i < 0) ids.push(String(a.id));
    sh.getRange(target, 1, 1, FIELDS.length).setValues([toRow_(a)]);
  });
}

function deleteRow_(id) {
  const sh = sheet_(), last = sh.getLastRow();
  if (last < 2) return;
  const i = sh.getRange(2, 1, last - 1, 1).getValues().map(r => String(r[0])).indexOf(String(id));
  if (i >= 0) sh.deleteRow(i + 2);
}

/* ---------- utils ---------- */
function sheet_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TAB);
  if (!sh) throw new Error('missing_tab_' + TAB + ' (run setup)');
  return sh;
}
function col_(field) {
  const sh = sheet_(), c = FIELDS.indexOf(field) + 1;
  return sh.getRange(2, c, sh.getMaxRows() - 1, 1);
}
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
