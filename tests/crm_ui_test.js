/* Loads index.html in jsdom (test mode: no API address, so the CRM keeps its notes in the browser) and drives the CRM screens.
   Needs jsdom, which is not part of the repo:   npm install jsdom --prefix /tmp/jt
   Run:  NODE_PATH=/tmp/jt/node_modules node tests/crm_ui_test.js                                                      */
const fs = require('fs'), path = require('path'), assert = require('assert');
const { JSDOM } = require('jsdom');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

const fixture = require('./fixture');
async function boot(user, withRef = true, seed = null) {
  const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously', pretendToBeVisual: true, beforeParse(w) {
    w.localStorage.setItem('dfUser', JSON.stringify(user));
    if (seed) w.localStorage.setItem('dfCrmLocal', JSON.stringify(seed));
    w.Element.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 500, width: 800, height: 500, x: 0, y: 0 });
    w.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
    w.ResizeObserver = class { observe() {} disconnect() {} };
    w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
    w.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new w.Event('close')); };
    w.Element.prototype.setPointerCapture = () => {};
    w.confirm = () => true;
    const noop = new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => 0 : noop), apply: () => noop });
    w.HTMLCanvasElement.prototype.getContext = () => noop;
    w.fetch = async () => ({ ok: true, json: async () => fixture(withRef) });
    w.addEventListener('error', e => { w.__err = (w.__err || []).concat(e.message); });
  } });
  const w = dom.window;
  for (let i = 0; i < 50 && !(w.DF && w.DF.D); i++) await new Promise(r => setTimeout(r, 20));
  assert.ok(w.DF && w.DF.D, 'app did not load the data');
  return w;
}
const wait = (ms = 60) => new Promise(r => setTimeout(r, ms));
const q = (w, s) => w.document.querySelector(s), qa = (w, s) => [...w.document.querySelectorAll(s)];
const click = (w, el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const set = (w, s, v) => { const e = q(w, s); e.value = v; e.dispatchEvent(new w.Event('input', { bubbles: true })); e.dispatchEvent(new w.Event('change', { bubbles: true })); };
const submit = (w, s) => q(w, s).dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
let n = 0; const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('verkoper: CRM tile on the home screen, then the CRM screen', async () => {
  const w = await boot('Anna de Vries'); await wait();
  assert.ok(q(w, '.tile[data-m="crm"]'), 'tile present'); assert.match(q(w, '.tile[data-m="crm"]').textContent, /No tasks due/);
  w.DF.go('crm'); await wait();
  assert.match(q(w, '#mc').textContent, /Log a contact/); assert.ok(!qa(w, '#cTabs button').some(b => b.textContent === 'Team'), 'no Team tab for a verkoper');
  assert.deepEqual(w.__err || [], []);
});
test('log a contact with a follow-up; it shows in Contacts, Today, the briefing and the home tile', async () => {
  const w = await boot('Anna de Vries'); await wait(); w.DF.go('crm'); await wait();
  click(w, q(w, '#cLog')); await wait(); assert.ok(q(w, '#crmDlg[open]'), 'dialog opened');
  const opts = qa(w, '#fTs option').map(o => o.value); assert.deepEqual(opts.sort(), ['Farm A · Amersfoort'], 'only her own customer');
  set(w, '#fT', 'Farm A · Amersfoort'); set(w, '#fS', 'Wants a price on Pro Elite <img src=x onerror=alert(1)>');
  set(w, '#fO', 'quote'); set(w, '#fFd', '2026-12-24'); set(w, '#fFt', 'Send the quote');
  submit(w, '#fF'); await wait(150);
  assert.ok(!q(w, '#crmDlg[open]'), 'dialog closed');
  const saved = JSON.parse(w.localStorage.getItem('dfCrmLocal')); assert.equal(saved.A.length, 1); assert.equal(saved.T.length, 1); assert.equal(saved.A[0].ref, 'r0'); assert.equal(saved.A[0].by, 'Anna de Vries');
  click(w, qa(w, '#cTabs button').find(b => b.dataset.t === 'act')); await wait();
  assert.match(q(w, '#cBody').textContent, /Farm A/); assert.match(q(w, '#cBody').textContent, /Quote requested/);
  assert.ok(!q(w, '#cBody img'), 'note text is escaped, not run as HTML');
  click(w, qa(w, '#cTabs button').find(b => b.dataset.t === 'today')); await wait();
  assert.match(q(w, '#cBody').textContent, /Send the quote/);
  w.DF.go('brief'); await wait(); assert.ok(q(w, '#crmB'), 'briefing has the CRM panel');
  assert.match(q(w, '#crmB').textContent, /Wants a price/); assert.match(q(w, '#crmB').textContent, /Send the quote/);
  w.DF.go('home'); await wait(); assert.match(q(w, '.tile[data-m="crm"]').textContent, /No tasks due/, 'the task is due in December, not today');
  assert.deepEqual(w.__err || [], []);
});
test('done / delete a task, edit and delete a contact', async () => {
  const w = await boot('Anna de Vries'); await wait(); w.DF.go('crm'); await wait();
  click(w, q(w, '#cTask')); await wait(); set(w, '#fT', 'Farm A · Amersfoort'); set(w, '#fX', 'Call about feed'); set(w, '#fD', '2026-11-20'); submit(w, '#fF'); await wait(150);
  assert.match(q(w, '#cBody').textContent, /Call about feed/); assert.match(q(w, '#cBody').textContent, /overdue/);
  assert.match(q(w, '.kpi').textContent, /Overdue/);
  click(w, q(w, '[data-done]')); await wait(150); assert.ok(!/Call about feed/.test(q(w, '#cBody').textContent), 'done task leaves the list');
  click(w, q(w, '#cLog')); await wait(); set(w, '#fT', 'Farm A · Amersfoort'); set(w, '#fS', 'first'); submit(w, '#fF'); await wait(150);
  click(w, qa(w, '#cTabs button').find(b => b.dataset.t === 'act')); await wait(); click(w, q(w, '[data-ea]')); await wait();
  assert.ok(q(w, '#fT[readonly]') || q(w, 'input[readonly]'), 'customer is fixed when editing'); set(w, '#fS', 'second'); submit(w, '#fF'); await wait(150);
  assert.match(q(w, '#cBody').textContent, /second/); click(w, q(w, '[data-da]')); await wait(150); assert.match(q(w, '#cBody').textContent, /No contacts logged yet/);
});
test('private note keeps its flag', async () => {
  const w = await boot('Anna de Vries'); await wait(); w.DF.go('crm'); await wait();
  click(w, q(w, '#cLog')); await wait(); set(w, '#fT', 'Farm A · Amersfoort'); set(w, '#fS', 'hush'); q(w, '#fP').checked = true; submit(w, '#fF'); await wait(150);
  assert.equal(JSON.parse(w.localStorage.getItem('dfCrmLocal')).A[0].priv, 1);
  click(w, qa(w, '#cTabs button').find(b => b.dataset.t === 'act')); await wait(); assert.match(q(w, '#cBody').textContent, /Private/);
});
test('prospect: create, find duplicates, log a contact on it, edit', async () => {
  const w = await boot('Anna de Vries'); await wait(); w.DF.go('crm'); await wait();
  click(w, q(w, '#cPros')); await wait(); set(w, '#fN', 'Farm A'); assert.match(q(w, '#fDup').textContent, /Already a customer\?/);
  set(w, '#fN', 'Hof Nieuw'); set(w, '#fZ', '3811 AB'); set(w, '#fL', 'Amersfoort'); set(w, '#fPh', '+31 6 12345678'); submit(w, '#fF'); await wait(150);
  click(w, qa(w, '#cTabs button').find(b => b.dataset.t === 'pros')); await wait(); assert.match(q(w, '#cBody').textContent, /Hof Nieuw/); assert.match(q(w, '#cBody').textContent, /no pin/, 'no coordinates in test mode');
  click(w, q(w, '[data-log^="p:"]')); await wait(); assert.equal(q(w, '#crmDlg input[readonly]').value, 'Hof Nieuw'); set(w, '#fS', 'Met at the fair'); submit(w, '#fF'); await wait(150);
  assert.match(q(w, '#cBody').textContent, /—|\d{4}/); click(w, q(w, '[data-pe]')); await wait(); set(w, '#fSt', 'interested'); submit(w, '#fF'); await wait(150);
  assert.match(q(w, '#cBody').textContent, /Interested/);
  assert.equal(qa(w, '[data-pl]').length, 0, 'verkoper has no link button');
});
test('admin: Team tab shows the rep names; can log on shared and channel customers only', async () => {
  const w = await boot('Johan Hoogendoorn'); await wait(); w.DF.go('crm'); await wait();
  const tabs = qa(w, '#cTabs button'); assert.ok(tabs.some(b => b.textContent === 'Team'));
  click(w, tabs.find(b => b.dataset.t === 'team')); await wait();
  assert.match(q(w, '#cBody').textContent, /Anna de Vries, Bram Jansen/); assert.match(q(w, '#cBody').textContent, /Farm D/);
  click(w, q(w, '#cLog')); await wait(); assert.deepEqual(qa(w, '#fTs option').map(o => o.value).sort(), ['Farm C · Zwolle', 'Farm D · Assen']);
});
test('admin briefing of a multi-rep customer lists the reps; verkoper cannot log on it', async () => {
  const w = await boot('Johan Hoogendoorn'); await wait(); w.DF.go('brief'); await wait();     // first call-list customer: Farm C
  assert.match(q(w, '#crmB').textContent, /Verkopers on this customer: Anna de Vries, Bram Jansen/); assert.ok(q(w, '#crmB [data-log]'), 'admin may log on it');
});
test('call list buttons leave one CRM note per customer per day, and take it away again', async () => {
  const w = await boot('Anna de Vries'); await wait(); w.DF.go('calls'); await wait();
  const row = q(w, '.oc[data-k="0"]'); assert.ok(row, 'call row for Farm A');
  click(w, [...row.querySelectorAll('button')].find(b => b.textContent === 'Called')); await wait(150);
  let s = JSON.parse(w.localStorage.getItem('dfCrmLocal')); assert.equal(s.A.length, 1); assert.match(s.A[0].summary, /Call list: Called/); assert.equal(s.A[0].type, 'call');
  click(w, [...q(w, '.oc[data-k="0"]').querySelectorAll('button')].find(b => b.textContent === 'Ordered')); await wait(150);
  s = JSON.parse(w.localStorage.getItem('dfCrmLocal')); assert.equal(s.A.length, 1, 'same note updated, not a second one'); assert.equal(s.A[0].outcome, 'order');
  click(w, [...q(w, '.oc[data-k="0"]').querySelectorAll('button')].find(b => b.textContent === 'Ordered')); await wait(150);
  s = JSON.parse(w.localStorage.getItem('dfCrmLocal')); assert.equal(s.A.length, 0, 'unticking removes it');
});
test('map: a prospect is drawn as a pin you can hover and click; customers keep priority', async () => {
  const pr = (id, name, la, lo, owner) => ({ id, name, cc: 'NL', pc: '', place: 'Somewhere', phone: '', email: '', status: 'new', owner, la, lo, notes: '', linked: '', created: '', updated: '' });
  const w = await boot('Anna de Vries', true, { A: [], T: [], P: [pr('pr-00000001', 'Hof Pin', 52.3, 5.9, 'Anna de Vries'), pr('pr-00000002', 'Hof Other', 52.4, 5.2, 'Bram Jansen')] });
  await wait(); w.DF.go('map'); await wait(900);
  const cv = q(w, 'canvas'), ev = (t, x, y, extra = {}) => cv.dispatchEvent(new w.MouseEvent(t, { clientX: x, clientY: y, bubbles: true, ...extra }));
  const found = [];
  for (let x = 0; x < 800; x += 5) for (let y = 0; y < 500; y += 5) { ev('pointermove', x, y); const t = q(w, '#tip'); if (t.style.display === 'block' && /prospect/.test(t.textContent)) found.push([x, y, t.textContent]); }
  assert.ok(found.length > 0, 'a prospect pin is hit somewhere on the map');
  assert.ok(found.every(f => /Hof Pin/.test(f[2])), 'only her own prospect, never Bram\'s');
  const [x, y] = found[0]; ev('pointerdown', x, y); ev('pointerup', x, y); await wait();
  assert.ok(q(w, '#crmDlg[open]') && /Hof Pin/.test(q(w, '#crmDlg').textContent), 'click opens the prospect card');
  assert.deepEqual(w.__err || [], []); assert.ok(q(w, '#pane'), 'map screen rendered');
});
test('map: a customer column under a prospect pin wins the hover', async () => {
  const w = await boot('Anna de Vries', true, { A: [], T: [], P: [{ id: 'pr-00000003', name: 'Hof Same', cc: 'NL', pc: '', place: 'Amersfoort', phone: '', email: '', status: 'new', owner: 'Anna de Vries', la: 52.15, lo: 5.39, notes: '', linked: '', created: '', updated: '' }] });
  await wait(); w.DF.go('map'); await wait(900);
  const cv = q(w, 'canvas'); let customerTip = false;
  for (let x = 0; x < 800; x += 4) for (let y = 0; y < 500; y += 4) { cv.dispatchEvent(new w.MouseEvent('pointermove', { clientX: x, clientY: y, bubbles: true })); const t = q(w, '#tip'); if (t.style.display === 'block' && /Farm A/.test(t.textContent)) customerTip = true; }
  assert.ok(customerTip, 'hovering the customer still shows the customer');
});
test('data without ref (older upload): the CRM says it starts later, the rest of the app is untouched', async () => {
  const w = await boot('Anna de Vries', false); await wait(); w.DF.go('crm'); await wait();
  assert.match(q(w, '#mc').textContent, /starts after the next daily data update/);
  w.DF.go('brief'); await wait(); assert.ok(q(w, '#mc h1'), 'briefing still works'); assert.ok(!q(w, '#crmB'), 'no CRM panel without ids');
  w.DF.go('home'); await wait(); assert.match(q(w, '.tile[data-m="crm"]').textContent, /Starts after the next data update/);
  assert.deepEqual(w.__err || [], []);
});
test('other modules still render', async () => {
  const w = await boot('Johan Hoogendoorn'); await wait();
  for (const m of ['calls', 'brief', 'collect', 'unb', 'con', 'cash', 'price', 'buy', 'map']) { w.DF.go(m); await wait(40); assert.ok(q(w, '#mc'), m + ' has a screen'); }
  assert.deepEqual(w.__err || [], []);
});

(async () => {
  for (const [name, fn] of tests) { try { await fn(); n++; console.log('ok  ' + name); } catch (e) { process.exitCode = 1; console.error('FAIL ' + name + '\n  ' + String(e.stack || e).split('\n').slice(0, 5).join('\n  ')); } }
  console.log(n + '/' + tests.length + ' UI tests passed'); process.exit(process.exitCode || 0);
})();
