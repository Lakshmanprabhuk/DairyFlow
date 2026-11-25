/* In-memory fake of the Apps Script services, with Code.gs loaded into it. Shared by the CRM tests. */
const fs = require('fs'), vm = require('vm'), crypto = require('crypto');
module.exports = function createServer() {
function fakeSheet(name) {
  const sh = { name, rows: [], formats: new Set(), frozen: 0 };
  const grid = (r, c) => { while (sh.rows.length < r) sh.rows.push([]); const row = sh.rows[r - 1]; while (row.length < c) row.push(''); return row; };
  sh.getLastRow = () => sh.rows.length;
  sh.getMaxRows = () => Math.max(sh.rows.length, 1000);
  sh.setFrozenRows = n => { sh.frozen = n; };
  sh.hideColumns = () => {}; sh.hideSheet = () => {};
  sh.appendRow = a => { sh.rows.push(a.slice()); };
  sh.getDataRange = () => ({ getValues: () => sh.rows.map(r => r.slice()) });
  sh.getRange = (r, c, nr = 1, nc = 1) => ({
    setNumberFormat: () => { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) sh.formats.add((r + i) + ':' + (c + j)); return this; },
    setFontWeight: () => {},
    setValues: v => { v.forEach((rowv, i) => rowv.forEach((x, j) => {
      // a cell that was not set to text format would turn ISO dates into Date objects in real Sheets: model that
      grid(r + i, c + j)[c + j - 1] = (!sh.formats.has((r + i) + ':' + (c + j)) && /^\d{4}-\d\d-\d\d/.test(x)) ? new Date(x) : x;
    })); },
    setValue: x => { grid(r, c)[c - 1] = (!sh.formats.has(r + ':' + c) && /^\d{4}-\d\d-\d\d/.test(x)) ? new Date(x) : x; },
    getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => (grid(r + i, c + j)[c + j - 1]))),
  });
  return sh;
}
const sheets = {};
const store = { cache: {}, props: {}, files: {}, mails: [], geocodes: 0 };
const ctx = vm.createContext({
  console,
  SpreadsheetApp: { getActive: () => ({ getSheetByName: n => sheets[n] || null, insertSheet: n => (sheets[n] = fakeSheet(n)) }) },
  CacheService: { getScriptCache: () => ({
    get: k => (k in store.cache ? store.cache[k] : null), put: (k, v) => { store.cache[k] = v; },
    putAll: o => Object.assign(store.cache, o), remove: k => { delete store.cache[k]; },
    getAll: ks => Object.fromEntries(ks.filter(k => k in store.cache).map(k => [k, store.cache[k]])) }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => store.props[k] ?? null, setProperty: (k, v) => { store.props[k] = v; } }) },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  DriveApp: {
    createFile: (name, text) => { const id = 'f' + Object.keys(store.files).length; store.files[id] = { text }; return fileObj(id); },
    getFileById: id => { if (!store.files[id]) throw new Error('nf'); return fileObj(id); } },
  Utilities: {
    DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
    computeDigest: (a, s) => Array.from(crypto.createHash('sha256').update(typeof s === 'string' ? s : Buffer.from(s)).digest()).map(b => b > 127 ? b - 256 : b),
    base64Encode: b => (typeof b === 'string' ? Buffer.from(b) : Buffer.from(b.map(x => x & 255))).toString('base64'),
    getUuid: () => crypto.randomUUID() },
  ContentService: { MimeType: { JSON: 'json' }, createTextOutput: s => ({ s, setMimeType() { return this; }, getContent() { return this.s; } }) },
  MailApp: { sendEmail: m => store.mails.push(m) },
  Maps: { newGeocoder: () => ({ setRegion() { return this; }, geocode: q => { store.geocodes++; return /nowhere/.test(q) ? { status: 'ZERO_RESULTS', results: [] } : { status: 'OK', results: [{ geometry: { location: { lat: 52.1234567, lng: 5.1234567 } } }] }; } }) },
});
function fileObj(id) { return { getId: () => id, setContent: t => { store.files[id].text = t; }, getBlob: () => ({ getDataAsString: () => store.files[id].text }) }; }
vm.runInContext(fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8'), ctx, { filename: 'Code.gs' });
const run = code => vm.runInContext(code, ctx);

  const API = (a, body) => JSON.parse(run('doPost')({ postData: { contents: JSON.stringify({ a, ...body }) } }).getContent());
  return { ctx, store, run, API, sheets };
};
