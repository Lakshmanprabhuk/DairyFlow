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
      default:            return crmRoute_(req);          // CRM actions; anything else still ends in 'Unknown action'
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
  crmInvalidate_();
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
  d.quiet = (d.quiet || []).filter(x => own(x.c));
  d.collections = d.collections.filter(x => own(x.c));
  d.orders = d.orders.filter(x => own(x.c));
  d.contracts = d.contracts.filter(x => own(x[0]));
  d.cm = d.cm.filter(x => own(x[0]));
  d.cp = d.cp.filter(x => own(x[0]));      // product averages and 'others also buy' come precomputed (prodTot, pen)
  d.margin = []; d.costs = []; d.dayGroup = []; d.monthGroup = [];
  d.verkopers = [name];
  crmRestrict_(d, own);
}

/* ══════════════════════════════════════════════════════════════════
   CRM (added). Visit notes, follow-up tasks and prospects.
   Lives in three tabs of this same sheet: Activities, Tasks, Prospects.
   Run setupCrm() once after pasting this file, then deploy a new version.
   • A note, task or prospect belongs to a customer by its Microfas id (data.ref), or to a prospect ('p:<id>').
   • Who writes: the verkoper who owns the customer. Customers with several verkopers, or with no verkoper
     (Kantoor, Webshop, Unassigned), are written by admins (Johan, Leon) only.
   • Who reads: the owner and the admins. A note marked Private is read by its author only.
   • Everything is decided here on the server; the app only hides what it may not offer.
   ══════════════════════════════════════════════════════════════════ */
const CRM = {
  SHEETS: {
    Activities: ['Id', 'Ref', 'Type', 'Date', 'Outcome', 'Summary', 'Private', 'By', 'Created', 'Updated', 'Deleted'],
    Tasks: ['Id', 'Ref', 'Text', 'Due', 'Status', 'Owner', 'Private', 'By', 'Created', 'Updated', 'Done', 'Deleted'],
    Prospects: ['Id', 'Name', 'Country', 'Postcode', 'Place', 'Phone', 'Email', 'Status', 'Owner', 'Lat', 'Lon', 'Notes', 'Linked', 'Created', 'Updated', 'Deleted'],
  },
  TYPES: ['visit', 'call', 'email', 'note'],
  OUTCOMES: ['', 'spoke', 'noanswer', 'order', 'quote', 'followup', 'notinterested', 'other'],
  TASK_STATUS: ['open', 'done'],
  PROSPECT_STATUS: ['new', 'contacted', 'interested', 'quote', 'won', 'lost'],
  COUNTRIES: { NL: 'Netherlands', DE: 'Germany', BE: 'Belgium', AT: 'Austria', CH: 'Switzerland', DK: 'Denmark', FR: 'France', LU: 'Luxembourg',
    PL: 'Poland', CZ: 'Czechia', HU: 'Hungary', ES: 'Spain', GB: 'United Kingdom', IE: 'Ireland', SE: 'Sweden', SK: 'Slovakia', RO: 'Romania' },
  MAX: { summary: 2000, text: 300, name: 120, notes: 2000, place: 80, postcode: 16, phone: 40, email: 120 },
  WRITES_PER_MINUTE: 60,
  OWN_PIECE: 30000,
};
const CRM_ID = /^[A-Za-z0-9_-]{8,40}$/, CRM_DATE = /^\d{4}-\d{2}-\d{2}$/, CRM_EMAIL = /^[^@\s;,]+@[^@\s;,]+\.[A-Za-z]{2,}$/;

/** Creates the three tabs (safe to run again). Text format on every column keeps dates and ids exactly as written. */
function setupCrm() {
  const ss = SpreadsheetApp.getActive();
  Object.keys(CRM.SHEETS).forEach(name => {
    const cols = CRM.SHEETS[name];
    const sh = ss.getSheetByName(name) || ss.insertSheet(name);
    if (sh.getLastRow() === 0) { sh.getRange(1, 1, 1, cols.length).setNumberFormat('@'); sh.appendRow(cols); sh.setFrozenRows(1); sh.getRange(1, 1, 1, cols.length).setFontWeight('bold'); }
    sh.getRange(1, 1, sh.getMaxRows(), cols.length).setNumberFormat('@');
  });
  console.log('CRM tabs ready. Keep this sheet shared with as few people as possible: it holds visit notes, and private notes are readable by anyone who can open it.');
}
function crmSheet_(name) {
  let sh = sheet_(name);
  if (!sh) { setupCrm(); sh = sheet_(name); }
  return sh;
}
function s_(v) { return v instanceof Date ? v.toISOString() : String(v == null ? '' : v); }
function crmRows_(name) {
  const sh = crmSheet_(name), v = sh.getDataRange().getValues(), h = CRM.SHEETS[name], rows = [];
  for (let i = 1; i < v.length; i++) {
    if (!s_(v[i][0])) continue;
    const o = { _row: i + 1 }; h.forEach((k, j) => o[k] = s_(v[i][j])); rows.push(o);
  }
  return rows;
}
function crmPut_(name, row, o) {            // writes (or appends) one record, text format first so nothing is auto-converted
  const sh = crmSheet_(name), cols = CRM.SHEETS[name], r = row || sh.getLastRow() + 1, rg = sh.getRange(r, 1, 1, cols.length);
  rg.setNumberFormat('@'); rg.setValues([cols.map(k => o[k] == null ? '' : s_(o[k]))]);
}
function crmNow_() { return new Date().toISOString(); }

/* ---- validation ---- */
function crmStr_(v, max) { return String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max); }
function crmDate_(v, fromDays, toDays) {
  v = String(v || '').trim();
  if (!CRM_DATE.test(v)) return null;
  const t = Date.parse(v + 'T00:00:00Z'); if (isNaN(t)) return null;
  const d = (t - Date.now()) / 864e5; return d >= fromDays && d <= toDays ? v : null;
}

/* ---- who owns which customer: {microfasId: verkoper}, cached in pieces next to the data ---- */
function crmPutPieces_(prefix, text) {
  const c = CacheService.getScriptCache(), n = Math.ceil(text.length / CRM.OWN_PIECE), o = {};
  o[prefix + ':n'] = String(n);
  for (let i = 0; i < n; i++) o[prefix + ':' + i] = text.slice(i * CRM.OWN_PIECE, (i + 1) * CRM.OWN_PIECE);
  try { c.putAll(o, CACHE_SECONDS); } catch (e) { c.remove(prefix + ':n'); }
}
function crmGetPieces_(prefix) {
  const c = CacheService.getScriptCache(), n = Number(c.get(prefix + ':n') || 0);
  if (!n) return null;
  const keys = []; for (let i = 0; i < n; i++) keys.push(prefix + ':' + i);
  const got = c.getAll(keys);
  return keys.every(k => got[k] != null) ? keys.map(k => got[k]).join('') : null;
}
function crmInvalidate_() { try { CacheService.getScriptCache().remove('crm:own:n'); } catch (e) {} }
function crmOwners_() {
  const t = crmGetPieces_('crm:own'); if (t) return JSON.parse(t);
  const d = readData_(); if (!d || !d.ref) return null;           // data from before the CRM pipeline step: not ready
  const m = {}; d.ref.forEach((r, i) => { if (r) m[r] = d.vkOfCust[i] || ''; });
  crmPutPieces_('crm:own', JSON.stringify(m)); return m;
}

/* ---- permissions ---- */
function crmAdmin_(u) { return u.Role === 'admin'; }
function crmChannel_(owner) { return !owner || CFG.CHANNELS.indexOf(owner) >= 0; }
/** ctx = { owners, prospects: {id: row} } */
function crmCtx_(withProspects) {
  const owners = crmOwners_(); if (!owners) return null;
  const prospects = {}; if (withProspects) crmRows_('Prospects').forEach(p => prospects[p.Id] = p);
  return { owners, prospects };
}
function crmCanSee_(u, ref, ctx) {
  if (String(ref).indexOf('p:') === 0) { const p = ctx.prospects[String(ref).slice(2)]; return !!p && !p.Deleted && (crmAdmin_(u) || p.Owner === u.Name); }
  const owner = ctx.owners[ref]; if (owner === undefined) return false;
  return crmChannel_(owner) ? crmAdmin_(u) : (crmAdmin_(u) || owner === u.Name);
}
function crmCanWrite_(u, ref, ctx) {
  if (String(ref).indexOf('p:') === 0) { const p = ctx.prospects[String(ref).slice(2)]; return !!p && !p.Deleted && !p.Linked && p.Owner === u.Name; }
  const owner = ctx.owners[ref]; if (owner === undefined) return false;
  return crmChannel_(owner) ? crmAdmin_(u) : owner === u.Name;
}
function crmCanRead_(u, rec, ctx) { return crmCanSee_(u, rec.Ref, ctx) && (!rec.Private || rec.By === u.Name); }

/* ---- shapes sent to the app ---- */
const crmAct_ = r => ({ id: r.Id, ref: r.Ref, type: r.Type, date: r.Date, outcome: r.Outcome, summary: r.Summary, priv: r.Private ? 1 : 0, by: r.By, created: r.Created, updated: r.Updated });
const crmTask_ = r => ({ id: r.Id, ref: r.Ref, text: r.Text, due: r.Due, status: r.Status, owner: r.Owner, priv: r.Private ? 1 : 0, by: r.By, created: r.Created, updated: r.Updated, done: r.Done });
const crmPros_ = r => ({ id: r.Id, name: r.Name, cc: r.Country, pc: r.Postcode, place: r.Place, phone: r.Phone, email: r.Email, status: r.Status, owner: r.Owner,
  la: r.Lat === '' ? null : Number(r.Lat), lo: r.Lon === '' ? null : Number(r.Lon), notes: r.Notes, linked: r.Linked, created: r.Created, updated: r.Updated });

/* ---- routing ---- */
function crmRoute_(req) {
  switch (req.a) {
    case 'crmList':   return crmList_(req);
    case 'crmSave':   return crmWrite_(req, crmSave_);
    case 'crmDelete': return crmWrite_(req, crmDelete_);
    case 'crmLink':   return crmWrite_(req, crmLink_);
  }
  return out({ ok: false, error: 'Unknown action' });
}
function crmThrottled_(u) {
  const c = CacheService.getScriptCache(), k = 'crm:w:' + u.Name + ':' + Math.floor(Date.now() / 60000), n = Number(c.get(k) || 0) + 1;
  c.put(k, String(n), 120); return n > CRM.WRITES_PER_MINUTE;
}
function crmWrite_(req, fn) {
  const u = who_(req.token); if (!u) return out({ ok: false, error: 'Please sign in again.', signin: true });
  if (crmThrottled_(u)) return out({ ok: false, error: 'Too many changes at once. Wait a minute.' });
  const lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    const ctx = crmCtx_(true); if (!ctx) return out({ ok: false, error: 'CRM is not ready: it starts after the next data update.', notReady: true });
    return out(fn(u, req, ctx));
  } finally { lock.releaseLock(); }
}

/* ---- read ---- */
/** Everything this user may read. With since, only what changed after it (deleted ones come back as { id, del: 1 }). */
function crmList_(req) {
  const u = who_(req.token); if (!u) return out({ ok: false, error: 'Please sign in again.', signin: true });
  const ctx = crmCtx_(true); if (!ctx) return out({ ok: false, error: 'CRM is not ready: it starts after the next data update.', notReady: true });
  const since = String(req.since || ''), now = new Date(Date.now() - 5000).toISOString();   // 5 s overlap: the app merges by id
  const pick = (rows, shape) => {
    const res = [];
    rows.forEach(r => {
      if (since && !(r.Updated > since)) return;
      if (!crmCanRead_(u, r, ctx)) return;
      if (r.Deleted) { if (since) res.push({ id: r.Id, del: 1 }); return; }
      res.push(shape(r));
    });
    return res;
  };
  const pros = [];
  Object.keys(ctx.prospects).forEach(id => {
    const p = ctx.prospects[id];
    if (since && !(p.Updated > since)) return;
    if (!(crmAdmin_(u) || p.Owner === u.Name)) return;
    if (p.Deleted) { if (since) pros.push({ id: p.Id, del: 1 }); return; }
    pros.push(crmPros_(p));
  });
  return out({ ok: true, now, full: !since, activities: pick(crmRows_('Activities'), crmAct_), tasks: pick(crmRows_('Tasks'), crmTask_), prospects: pros });
}

/* ---- write ---- */
function crmSave_(u, req, ctx) {
  const rec = req.rec || {}, id = String(rec.id || '');
  if (!CRM_ID.test(id)) return { ok: false, error: 'Bad id.' };
  if (req.kind === 'activity') return crmSaveActivity_(u, rec, id, ctx);
  if (req.kind === 'task') return crmSaveTask_(u, rec, id, ctx);
  if (req.kind === 'prospect') return crmSaveProspect_(u, rec, id, ctx);
  return { ok: false, error: 'Unknown kind.' };
}
function crmSaveActivity_(u, rec, id, ctx) {
  const rows = crmRows_('Activities'), old = rows.find(r => r.Id === id);
  const type = String(rec.type || ''), outcome = String(rec.outcome || ''), summary = crmStr_(rec.summary, CRM.MAX.summary), date = crmDate_(rec.date, -3650, 1);
  if (CRM.TYPES.indexOf(type) < 0) return { ok: false, error: 'Choose what kind of contact it was.' };
  if (CRM.OUTCOMES.indexOf(outcome) < 0) return { ok: false, error: 'Unknown outcome.' };
  if (!date) return { ok: false, error: 'Check the date.' };
  if (!summary) return { ok: false, error: 'Write a short note.' };
  const now = crmNow_();
  if (old) {                                                          // an edit (or a repeated send of the same note)
    if (old.Deleted) return { ok: false, error: 'This note was deleted.' };
    if (old.By !== u.Name || !crmCanWrite_(u, old.Ref, ctx)) return { ok: false, error: 'Not allowed.' };
    Object.assign(old, { Type: type, Date: date, Outcome: outcome, Summary: summary, Updated: now });   // ref and privacy never change
    crmPut_('Activities', old._row, old); return { ok: true, rec: crmAct_(old) };
  }
  const ref = String(rec.ref || '');
  if (!crmCanWrite_(u, ref, ctx)) return { ok: false, error: 'You can not add notes to this customer.' };
  const o = { Id: id, Ref: ref, Type: type, Date: date, Outcome: outcome, Summary: summary, Private: rec.priv ? 'Y' : '', By: u.Name, Created: now, Updated: now, Deleted: '' };
  crmPut_('Activities', 0, o); return { ok: true, rec: crmAct_(o) };
}
function crmSaveTask_(u, rec, id, ctx) {
  const rows = crmRows_('Tasks'), old = rows.find(r => r.Id === id);
  const text = crmStr_(rec.text, CRM.MAX.text), due = crmDate_(rec.due, -365, 1100), status = String(rec.status || 'open');
  if (!text) return { ok: false, error: 'Write what needs doing.' };
  if (!due) return { ok: false, error: 'Check the due date.' };
  if (CRM.TASK_STATUS.indexOf(status) < 0) return { ok: false, error: 'Unknown status.' };
  const now = crmNow_();
  if (old) {
    if (old.Deleted) return { ok: false, error: 'This task was deleted.' };
    if ((old.By !== u.Name && old.Owner !== u.Name) || !crmCanWrite_(u, old.Ref, ctx)) return { ok: false, error: 'Not allowed.' };
    Object.assign(old, { Text: text, Due: due, Status: status, Updated: now, Done: status === 'done' ? (old.Done || now) : '' });
    crmPut_('Tasks', old._row, old); return { ok: true, rec: crmTask_(old) };
  }
  const ref = String(rec.ref || '');
  if (!crmCanWrite_(u, ref, ctx)) return { ok: false, error: 'You can not add tasks to this customer.' };
  const o = { Id: id, Ref: ref, Text: text, Due: due, Status: status, Owner: u.Name, Private: rec.priv ? 'Y' : '', By: u.Name, Created: now, Updated: now, Done: status === 'done' ? now : '', Deleted: '' };
  crmPut_('Tasks', 0, o); return { ok: true, rec: crmTask_(o) };
}
function crmGeocode_(cc, postcode, place) {
  try {
    const r = Maps.newGeocoder().setRegion(String(cc).toLowerCase()).geocode([postcode, place, CRM.COUNTRIES[cc]].filter(String).join(', '));
    if (!r || r.status !== 'OK' || !r.results.length) return null;
    const p = r.results[0].geometry.location;
    if (p.lat < 35 || p.lat > 61 || p.lng < -11 || p.lng > 30) return null;       // outside the area DairyTop sells in: ignore
    return [Math.round(p.lat * 1e4) / 1e4, Math.round(p.lng * 1e4) / 1e4];
  } catch (e) { return null; }
}
function crmSaveProspect_(u, rec, id, ctx) {
  const name = crmStr_(rec.name, CRM.MAX.name), cc = String(rec.cc || '').toUpperCase(), status = String(rec.status || 'new');
  const pc = crmStr_(rec.pc, CRM.MAX.postcode), place = crmStr_(rec.place, CRM.MAX.place), phone = crmStr_(rec.phone, CRM.MAX.phone), email = crmStr_(rec.email, CRM.MAX.email).replace(/\s/g, ''), notes = crmStr_(rec.notes, CRM.MAX.notes);
  if (!name) return { ok: false, error: 'Enter the name of the farm.' };
  if (!CRM.COUNTRIES[cc]) return { ok: false, error: 'Choose a country.' };
  if (CRM.PROSPECT_STATUS.indexOf(status) < 0) return { ok: false, error: 'Unknown status.' };
  if (phone && phone.replace(/\D/g, '').length < 6) return { ok: false, error: 'Check the phone number.' };
  if (email && !CRM_EMAIL.test(email)) return { ok: false, error: 'Check the email address.' };
  const old = ctx.prospects[id], now = crmNow_();
  if (old) {
    if (old.Deleted) return { ok: false, error: 'This prospect was deleted.' };
    if (old.Owner !== u.Name || old.Linked) return { ok: false, error: 'Not allowed.' };
    const moved = old.Country !== cc || old.Postcode !== pc || old.Place !== place || old.Lat === '';
    const g = moved && (pc || place) ? crmGeocode_(cc, pc, place) : null;
    Object.assign(old, { Name: name, Country: cc, Postcode: pc, Place: place, Phone: phone, Email: email, Status: status, Notes: notes, Updated: now });
    if (moved) { old.Lat = g ? g[0] : ''; old.Lon = g ? g[1] : ''; }
    crmPut_('Prospects', old._row, old); return { ok: true, rec: crmPros_(old) };
  }
  const g = pc || place ? crmGeocode_(cc, pc, place) : null;
  const o = { Id: id, Name: name, Country: cc, Postcode: pc, Place: place, Phone: phone, Email: email, Status: status, Owner: u.Name, Lat: g ? g[0] : '', Lon: g ? g[1] : '', Notes: notes, Linked: '', Created: now, Updated: now, Deleted: '' };
  crmPut_('Prospects', 0, o); return { ok: true, rec: crmPros_(o) };
}
function crmDelete_(u, req, ctx) {
  const id = String(req.id || ''), kind = req.kind, name = kind === 'activity' ? 'Activities' : kind === 'task' ? 'Tasks' : kind === 'prospect' ? 'Prospects' : '';
  if (!name || !CRM_ID.test(id)) return { ok: false, error: 'Bad request.' };
  const r = crmRows_(name).find(x => x.Id === id); if (!r) return { ok: true };            // already gone
  const mine = kind === 'prospect' ? r.Owner === u.Name : (r.By === u.Name || (kind === 'task' && r.Owner === u.Name));
  if (!mine) return { ok: false, error: 'Not allowed.' };
  r.Deleted = 'Y'; r.Updated = crmNow_(); crmPut_(name, r._row, r); return { ok: true };
}
/** Admin: a prospect became a Microfas customer. Its notes and tasks move to that customer. */
function crmLink_(u, req, ctx) {
  if (!crmAdmin_(u)) return { ok: false, error: 'Only Johan or Leon can link a prospect.' };
  const id = String(req.id || ''), ref = String(req.ref || ''), p = ctx.prospects[id];
  if (!p || p.Deleted || p.Linked) return { ok: false, error: 'Prospect not found or already linked.' };
  if (ctx.owners[ref] === undefined) return { ok: false, error: 'Customer not found.' };
  const now = crmNow_(), from = 'p:' + id;
  ['Activities', 'Tasks'].forEach(n => crmRows_(n).forEach(r => { if (r.Ref === from) { r.Ref = ref; r.Updated = now; crmPut_(n, r._row, r); } }));
  p.Linked = ref; p.Status = 'won'; p.Updated = now; crmPut_('Prospects', p._row, p);
  return { ok: true };
}

/** Called from restrict_: a verkoper's copy of the data carries Microfas ids of their own customers only, and no rep lists. */
function crmRestrict_(d, own) {
  if (d.ref) d.ref = d.ref.map((r, i) => own(i) ? r : '');
  d.reps = {};
}
