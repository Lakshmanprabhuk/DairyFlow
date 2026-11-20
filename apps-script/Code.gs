/* ══════════════════════════════════════════════════════════════════
   DairyFlow API · Google Apps Script bound to the "DairyFlow users" sheet
   ══════════════════════════════════════════════════════════════════
   What it does
   • Keeps the list of users (verkopers) and their passwords in the sheet.
     Passwords are never stored: only a random salt and a salted hash.
   • First sign-in: the user creates a password with a 6-digit code sent to
     their email, or a setup code Johan or Leon typed in the sheet.
   • Holds the DairyFlow data (uploaded every morning by GitHub Actions) as a
     file in this Drive, and serves it only to a signed-in user, filtered to
     what that user may see. Admins (Role = admin) get everything.

   Set-up (once)
   1. Create a Google Sheet "DairyFlow users", Extensions → Apps Script, paste this file.
   2. Project Settings → Script properties: add UPLOAD_KEY = a long random text
      (the same value goes into the GitHub secret DAIRYFLOW_UPLOAD_KEY).
   3. Run setup() once from the editor and allow the permissions it asks for.
   4. Deploy → New deployment → Web app · Execute as: Me · Who has access: Anyone.
      Copy the web app URL into the GitHub secret DAIRYFLOW_API_URL.
   5. The Email column fills itself from each verkoper's own Microfas record at every
      upload (only empty cells; a typed address is kept). Codes are sent by MailApp from
      the Google account that deploys this script, with the name "DairyFlow".
   Reset a password: clear that person's Salt and Hash cells.
   ══════════════════════════════════════════════════════════════════ */

const CFG = {
  USERS: 'Users', SESSIONS: 'Sessions',
  ADMINS: ['Johan Hoogendoorn', 'Leon'],
  CHANNELS: ['Kantoor', 'Webshop', 'Multiple representatives', 'Unassigned'],
  ROUNDS: 3000,                 // hash rounds
  SESSION_DAYS: 30, CODE_MINUTES: 15, MAX_FAILS: 5, LOCK_MINUTES: 15, MIN_PW: 8,
  DATA_FILE: 'dairyflow-data.json',
  MAIL_FROM_NAME: 'DairyFlow',
};
const COLS = ['Name', 'Role', 'Email', 'Setup code', 'Salt', 'Hash', 'Code hash', 'Code expires', 'Failed', 'Locked until', 'Last login', 'Password set'];

/* ---------------- entry points ---------------- */
function doGet() { return out({ ok: true, app: 'DairyFlow API' }); }
function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return out({ ok: false, error: 'Bad request' }); }
  try {
    switch (req.a) {
      case 'people':      return out({ ok: true, people: people_() });
      case 'sendCode':    return out(sendCode_(req.name));
      case 'setPassword': return out(withData_(setPassword_(req.name, req.code, req.password)));
      case 'login':       return out(withData_(login_(req.name, req.password)));
      case 'data':        return dataFor_(req.token, req.have);
      case 'logout':      return out(logout_(req.token));
      case 'upload':      return out(upload_(req.key, req.data));
      default:            return out({ ok: false, error: 'Unknown action' });
    }
  } catch (err) {
    console.error(err && err.stack || err);
    return out({ ok: false, error: 'Something went wrong. Try again.' });
  }
}
function out(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

/* ---------------- set-up ---------------- */
function setup() {
  const ss = SpreadsheetApp.getActive();
  const u = ss.getSheetByName(CFG.USERS) || ss.insertSheet(CFG.USERS);
  if (u.getLastRow() === 0) { u.appendRow(COLS); u.setFrozenRows(1); u.getRange(1, 1, 1, COLS.length).setFontWeight('bold'); }
  const s = ss.getSheetByName(CFG.SESSIONS) || ss.insertSheet(CFG.SESSIONS);
  if (s.getLastRow() === 0) { s.appendRow(['Token hash', 'Name', 'Expires', 'Created']); s.setFrozenRows(1); }
  u.hideColumns(5, 4);                                   // Salt, Hash, Code hash, Code expires
  s.hideSheet();
  seedUsersFromData_();
  console.log('Set-up done. Users: ' + Math.max(0, u.getLastRow() - 1));
}
/** Adds every verkoper found in the latest data file (channels excluded). Safe to run again. */
function seedUsersFromData_() {
  const d = readData_(); if (!d) return;
  const names = [...new Set([...d.verkopers, ...d.vkOfCust])].filter(v => v && CFG.CHANNELS.indexOf(v) < 0).sort();
  const u = sheet_(CFG.USERS), have = new Set(u.getRange(2, 1, Math.max(1, u.getLastRow() - 1), 1).getValues().flat().filter(String));
  const staff = d.staff || {};
  names.filter(n => !have.has(n)).forEach(n => u.appendRow([n, CFG.ADMINS.indexOf(n) >= 0 ? 'admin' : 'verkoper', staff[n] || '', '', '', '', '', '', 0, '', '', '']));
  users_().forEach(x => { if (!String(x.Email).trim() && staff[x.Name]) put_(x, 'Email', staff[x.Name]); });
}

/* ---------------- users ---------------- */
function sheet_(n) { return SpreadsheetApp.getActive().getSheetByName(n); }
function users_() {
  const sh = sheet_(CFG.USERS), v = sh.getDataRange().getValues(), h = v[0], rows = [];
  for (let i = 1; i < v.length; i++) { const o = { _row: i + 1 }; h.forEach((k, j) => o[k] = v[i][j]); if (o.Name) rows.push(o); }
  return rows;
}
function user_(name) { return users_().find(u => String(u.Name) === String(name)); }
function put_(u, field, value) { sheet_(CFG.USERS).getRange(u._row, COLS.indexOf(field) + 1).setValue(value); }
function people_() {
  return users_().map(u => ({ n: u.Name, admin: u.Role === 'admin', hasPw: !!u.Hash, hasEmail: !!String(u.Email).trim() }));
}
function mask_(e) { const [a, b] = String(e).split('@'); return a.slice(0, 2) + '•••@' + b; }

/* ---------------- passwords ---------------- */
function b64_(bytes) { return Utilities.base64Encode(bytes); }
function sha_(s) { return b64_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)); }
function hashPw_(pw, salt) { let h = salt + ':' + pw; for (let i = 0; i < CFG.ROUNDS; i++) h = sha_(h + salt); return h; }
function same_(a, b) { a = String(a); b = String(b); if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }
function locked_(u) { return u['Locked until'] && new Date(u['Locked until']) > new Date(); }

function sendCode_(name) {
  const lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    const u = user_(name); if (!u) return { ok: false, error: 'Unknown name.' };
    const email = String(u.Email).trim();
    if (!email) return { ok: false, error: 'There is no email address for you yet. Ask Johan or Leon for a setup code.' };
    const exp = u['Code expires'] ? new Date(u['Code expires']) : null;
    if (exp && exp - new Date() > (CFG.CODE_MINUTES - 1) * 60000) return { ok: true, sentTo: mask_(email), again: true };   // max one mail a minute
    const code = String(Math.floor(100000 + Math.random() * 900000));
    put_(u, 'Code hash', sha_(code + u.Name)); put_(u, 'Code expires', new Date(Date.now() + CFG.CODE_MINUTES * 60000));
    MailApp.sendEmail({ to: email, name: CFG.MAIL_FROM_NAME, subject: 'Your DairyFlow code: ' + code,
      body: 'Hello ' + u.Name + ',\n\nYour code to set your DairyFlow password is ' + code + '.\nIt works for ' + CFG.CODE_MINUTES + ' minutes.\n\nDid you not ask for this? Then you can ignore this email.\n\nDairyFlow · Powered by Knitworks' });
    return { ok: true, sentTo: mask_(email) };
  } finally { lock.releaseLock(); }
}

function setPassword_(name, code, pw) {
  const lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    const u = user_(name); if (!u) return { ok: false, error: 'Unknown name.' };
    if (locked_(u)) return { ok: false, error: 'Too many attempts. Try again in a few minutes.' };
    if (!pw || String(pw).length < CFG.MIN_PW) return { ok: false, error: 'Use at least ' + CFG.MIN_PW + ' characters.' };
    code = String(code || '').trim();
    const mailOk = u['Code hash'] && u['Code expires'] && new Date(u['Code expires']) > new Date() && same_(sha_(code + u.Name), u['Code hash']);
    const setupOk = String(u['Setup code']).trim() && same_(code, String(u['Setup code']).trim());
    if (!mailOk && !setupOk) { fail_(u); return { ok: false, error: 'That code is not right, or it has expired.' }; }
    const salt = b64_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + Math.random()));
    put_(u, 'Salt', salt); put_(u, 'Hash', hashPw_(String(pw), salt)); put_(u, 'Password set', new Date());
    put_(u, 'Code hash', ''); put_(u, 'Code expires', ''); put_(u, 'Setup code', ''); put_(u, 'Failed', 0); put_(u, 'Locked until', '');
    return session_(u);
  } finally { lock.releaseLock(); }
}

function login_(name, pw) {
  const lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    const u = user_(name); if (!u) return { ok: false, error: 'Unknown name.' };
    if (!u.Hash) return { ok: false, error: 'Create your password first.', needSetup: true };
    if (locked_(u)) return { ok: false, error: 'Too many attempts. Try again in a few minutes.' };
    if (!same_(hashPw_(String(pw || ''), u.Salt), u.Hash)) { fail_(u); return { ok: false, error: 'Wrong password.' }; }
    put_(u, 'Failed', 0); put_(u, 'Locked until', '');
    return session_(u);
  } finally { lock.releaseLock(); }
}
function fail_(u) {
  const n = (Number(u.Failed) || 0) + 1; put_(u, 'Failed', n);
  if (n >= CFG.MAX_FAILS) { put_(u, 'Locked until', new Date(Date.now() + CFG.LOCK_MINUTES * 60000)); put_(u, 'Failed', 0); }
}

/* ---------------- sessions ---------------- */
function session_(u) {
  const token = Utilities.getUuid() + Utilities.getUuid();
  sheet_(CFG.SESSIONS).appendRow([sha_(token), u.Name, new Date(Date.now() + CFG.SESSION_DAYS * 864e5), new Date()]);
  put_(u, 'Last login', new Date());
  return { ok: true, token, name: u.Name, admin: u.Role === 'admin' };
}
function who_(token) {
  if (!token) return null;
  const h = sha_(String(token)), v = sheet_(CFG.SESSIONS).getDataRange().getValues();
  for (let i = v.length - 1; i >= 1; i--) if (v[i][0] === h) { if (new Date(v[i][2]) < new Date()) return null; return user_(v[i][1]) || null; }
  return null;
}
function logout_(token) {
  const sh = sheet_(CFG.SESSIONS), h = sha_(String(token || '')), v = sh.getDataRange().getValues();
  for (let i = v.length - 1; i >= 1; i--) if (v[i][0] === h) sh.deleteRow(i + 1);
  return { ok: true };
}
/** Optional: run daily (time trigger) to remove expired sessions. */
function cleanSessions() {
  const sh = sheet_(CFG.SESSIONS), v = sh.getDataRange().getValues();
  for (let i = v.length - 1; i >= 1; i--) if (new Date(v[i][2]) < new Date()) sh.deleteRow(i + 1);
}

/* ---------------- data ---------------- */
function dataFile_() {
  const p = PropertiesService.getScriptProperties(), id = p.getProperty('DATA_FILE_ID');
  if (id) { try { return DriveApp.getFileById(id); } catch (e) {} }
  return null;
}
/* The data file is kept in the script cache in pieces (a cache value is limited to 100 KB),
   so a sign-in does not wait for a Drive read. An upload replaces the cached copy. */
const CACHE_PIECE = 40000, CACHE_SECONDS = 6 * 3600;
function cacheText_(text) {
  const c = CacheService.getScriptCache(), n = Math.ceil(text.length / CACHE_PIECE), o = { 'df:n': String(n) };
  for (let i = 0; i < n; i++) o['df:' + i] = text.slice(i * CACHE_PIECE, (i + 1) * CACHE_PIECE);
  try { c.putAll(o, CACHE_SECONDS); } catch (e) { c.remove('df:n'); }
}
function readText_() {
  const c = CacheService.getScriptCache(), n = Number(c.get('df:n') || 0);
  if (n) {
    const keys = []; for (let i = 0; i < n; i++) keys.push('df:' + i);
    const got = c.getAll(keys);
    if (keys.every(k => got[k] != null)) return keys.map(k => got[k]).join('');
  }
  const f = dataFile_(); if (!f) return null;
  const text = f.getBlob().getDataAsString('UTF-8'); cacheText_(text); return text;
}
function readData_() { const t = readText_(); return t ? JSON.parse(t) : null; }
/** The data a signed-in user may see (admins everything, a verkoper only their own customers). */
function payload_(u) {
  const d = readData_(); if (!d) return null;
  const admin = u.Role === 'admin';
  delete d.staff;                                       // staff emails stay on the server
  d.meta.me = u.Name; d.meta.admin = admin;
  if (!admin) restrict_(d, u.Name);
  return d;
}
/** A successful sign-in returns the data in the same answer: one round trip instead of two. */
function withData_(r) {
  if (!r || !r.ok) return r;
  const u = user_(r.name); const d = u && payload_(u);
  if (d) r.data = d;
  return r;
}
function upload_(key, text) {
  const want = PropertiesService.getScriptProperties().getProperty('UPLOAD_KEY');
  if (!want || !same_(key, want)) return { ok: false, error: 'Not allowed' };
  const d = JSON.parse(text);                       // refuse anything that is not valid JSON
  if (!d.meta || !d.customers) return { ok: false, error: 'Not DairyFlow data' };
  let f = dataFile_();
  if (f) f.setContent(text); else { f = DriveApp.createFile(CFG.DATA_FILE, text, 'application/json'); PropertiesService.getScriptProperties().setProperty('DATA_FILE_ID', f.getId()); }
  cacheText_(text);
  seedUsersFromData_();
  return { ok: true, through: d.meta.lt, bytes: text.length };
}
function dataFor_(token, have) {
  const u = who_(token); if (!u) return out({ ok: false, error: 'Please sign in again.', signin: true });
  const d = payload_(u); if (!d) return out({ ok: false, error: 'No data uploaded yet.' });
  if (have && have === d.meta.generated) return out({ ok: true, same: true, me: u.Name });   // the app already has this version
  return ContentService.createTextOutput(JSON.stringify({ ok: true, data: d })).setMimeType(ContentService.MimeType.JSON);
}
/** Keeps only this verkoper's customers; company-wide lists are removed. */
function restrict_(d, name) {
  const mine = new Set(d.vkOfCust.map((v, i) => v === name ? i : -1).filter(i => i >= 0)), own = c => mine.has(Number(c));
  d.customers = d.customers.filter(r => own(r[0]));
  d.unmapped = d.unmapped.filter(r => own(r[0]));
  d.names = d.names.map((n, i) => own(i) ? n : '');
  d.terms = d.terms.map((t, i) => own(i) ? t : null);
  d.market = d.market.map((m, i) => own(i) ? m : '');
  d.vkOfCust = d.vkOfCust.map((v, i) => own(i) ? v : '');
  const keep = o => { const r = {}; Object.keys(o).forEach(k => { if (own(k)) r[k] = o[k]; }); return r; };
  d.contacts = keep(d.contacts); d.lateness = keep(d.lateness); d.vatRatio = keep(d.vatRatio);
  d.calls = d.calls.filter(x => own(x.c));
  d.collections = d.collections.filter(x => own(x.c));
  d.orders = d.orders.filter(x => own(x.c));
  d.contracts = d.contracts.filter(x => own(x[0]));
  d.cm = d.cm.filter(x => own(x[0]));
  d.cadence = d.cadence.filter(x => own(x[0]));
  d.cp = d.cp.filter(x => own(x[0]));      // product averages and 'others also buy' come precomputed (prodTot, pen)
  d.margin = []; d.costs = []; d.dayGroup = []; d.monthGroup = [];
  d.verkopers = [name];
}
