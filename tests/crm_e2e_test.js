/* End to end: the real front end (index.html in LIVE mode) talks to the real Code.gs (in the in-memory fake of Apps Script).
   Needs jsdom:  npm install jsdom --prefix /tmp/jt
   Run:  NODE_PATH=/tmp/jt/node_modules node tests/crm_e2e_test.js                                                      */
const fs = require('fs'), path = require('path'), assert = require('assert');
const { JSDOM } = require('jsdom');
const fixture = require('./fixture');
const srv = require('./appsscript_fake')();
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8').replace('__DAIRYFLOW_API__', 'https://api.test/exec');

/* the server: Users/Sessions tabs, CRM tabs, the fixture uploaded as the nightly job would */
srv.run('setup()'); srv.run('setupCrm()'); srv.store.props.UPLOAD_KEY = 'k';
const up = srv.API('upload', { key: 'k', data: JSON.stringify(fixture(true)) }); assert.equal(up.ok, true);
const token = n => srv.run(`(function(){return session_(user_(${JSON.stringify(n)})).token})()`);

let online = true, hits = [];
async function boot(user) {
  const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously', pretendToBeVisual: true, beforeParse(w) {
    w.localStorage.setItem('dfToken', JSON.stringify(token(user)));
    w.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
    w.ResizeObserver = class { observe() {} disconnect() {} };
    w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
    w.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new w.Event('close')); };
    w.confirm = () => true; w.scrollTo = () => {};
    w.fetch = async (url, o) => {
      if (!online) throw new TypeError('network down');
      const body = JSON.parse(o.body); hits.push(body.a);
      const text = srv.run('doPost')({ postData: { contents: o.body } }).getContent();
      return { ok: true, json: async () => JSON.parse(text) };
    };
    w.addEventListener('error', e => { w.__err = (w.__err || []).concat(e.message); });
  } });
  const w = dom.window;
  for (let i = 0; i < 80 && !(w.DF && w.DF.D); i++) await new Promise(r => setTimeout(r, 20));
  assert.ok(w.DF && w.DF.D, user + ': app did not load data from the server');
  return w;
}
const wait = (ms = 80) => new Promise(r => setTimeout(r, ms));
const q = (w, s) => w.document.querySelector(s), qa = (w, s) => [...w.document.querySelectorAll(s)];
const click = (w, el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const set = (w, s, v) => { const e = q(w, s); e.value = v; e.dispatchEvent(new w.Event('input', { bubbles: true })); e.dispatchEvent(new w.Event('change', { bubbles: true })); };
const submit = (w, s) => q(w, s).dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
const rows = n => srv.run(`crmRows_(${JSON.stringify(n)})`);
let n = 0; const tests = [], test = (a, b) => tests.push([a, b]);
let anna, bram, johan;

test('three people sign in; each gets only what the server allows (own Microfas ids, no rep lists for verkopers)', async () => {
  anna = await boot('Anna de Vries'); bram = await boot('Bram Jansen'); johan = await boot('Johan Hoogendoorn'); await wait(200);
  assert.deepEqual(anna.DF.D.ref, ['r0', '', '', '']); assert.deepEqual(anna.DF.D.reps, {});
  assert.deepEqual(johan.DF.D.ref, ['r0', 'r1', 'r2', 'r3']); assert.deepEqual(johan.DF.D.reps, { 2: ['Anna de Vries', 'Bram Jansen'] });
  assert.ok(hits.includes('crmList'), 'the CRM asked the server for its notes');
});
test('Anna logs a contact with a follow-up; the server has it, and Johan sees it on his next refresh', async () => {
  anna.DF.go('crm'); await wait();
  click(anna, q(anna, '#cLog')); await wait(); set(anna, '#fT', 'Farm A · Amersfoort'); set(anna, '#fS', 'Wants a new price list'); set(anna, '#fO', 'followup');
  set(anna, '#fFd', '2026-12-20'); set(anna, '#fFt', 'Send price list'); q(anna, '#fP').checked = false; submit(anna, '#fF'); await wait(300);
  assert.equal(rows('Activities').length, 1); assert.equal(rows('Activities')[0].By, 'Anna de Vries'); assert.equal(rows('Activities')[0].Ref, 'r0'); assert.equal(rows('Tasks').length, 1);
  assert.ok(!/sending/.test(q(anna, '#mc').textContent) && !anna.document.querySelector('.alert.s'), 'nothing left waiting');
  johan.DF.go('crm'); await wait(100); click(johan, qa(johan, '#cTabs button').find(b => b.dataset.t === 'act')); await wait();
  assert.ok(!/Wants a new price list/.test(q(johan, '#cBody').textContent), 'a screen that was synced a moment ago is not refreshed again');
  const real = johan.Date.now; johan.Date.now = () => real() + 5 * 60000;           // five minutes later: opening a CRM screen refreshes
  johan.DF.go('home'); johan.DF.go('crm'); await wait(300); johan.Date.now = real;
  click(johan, qa(johan, '#cTabs button').find(b => b.dataset.t === 'act')); await wait();
  assert.match(q(johan, '#cBody').textContent, /Wants a new price list/);
  assert.ok(srv.API('crmList', { token: token('Bram Jansen') }).activities.length === 0, 'Bram sees nothing of Anna\'s');
});
test('a private note never reaches Johan, not even after he reloads', async () => {
  click(anna, q(anna, '#cLog')); await wait(); set(anna, '#fT', 'Farm A · Amersfoort'); set(anna, '#fS', 'SECRET about the owner'); q(anna, '#fP').checked = true; submit(anna, '#fF'); await wait(300);
  assert.equal(rows('Activities').length, 2);
  const j2 = await boot('Johan Hoogendoorn'); j2.DF.go('crm'); await wait(150); click(j2, qa(j2, '#cTabs button').find(b => b.dataset.t === 'act')); await wait();
  assert.ok(!/SECRET/.test(j2.document.body.textContent), 'not on the screen');
  assert.ok(!/SECRET/.test(JSON.stringify(srv.API('crmList', { token: token('Johan Hoogendoorn') }))), 'not in the server answer');
  anna.DF.go('crm'); await wait(100); click(anna, qa(anna, '#cTabs button').find(b => b.dataset.t === 'act')); await wait(); assert.match(q(anna, '#cBody').textContent, /SECRET/);
});
test('Johan logs on a multi-rep customer; Anna never sees it', async () => {
  johan.DF.go('crm'); await wait(100); click(johan, q(johan, '#cLog')); await wait();
  assert.deepEqual(qa(johan, '#fTs option').map(o => o.value).sort(), ['Farm C · Zwolle', 'Farm D · Assen']);
  set(johan, '#fT', 'Farm C · Zwolle'); set(johan, '#fS', 'Spoke to both reps'); submit(johan, '#fF'); await wait(300);
  assert.ok(rows('Activities').some(r => r.Ref === 'r2' && r.By === 'Johan Hoogendoorn'));
  assert.ok(!srv.API('crmList', { token: token('Anna de Vries') }).activities.some(a => a.ref === 'r2'));
});
test('offline: the note waits in the queue and goes out when the phone is back online', async () => {
  online = false; anna.DF.go('crm'); await wait(100);
  click(anna, q(anna, '#cLog')); await wait(); set(anna, '#fT', 'Farm A · Amersfoort'); set(anna, '#fS', 'Logged in the barn, no signal'); submit(anna, '#fF'); await wait(200);
  const before = rows('Activities').length; assert.ok(!rows('Activities').some(r => /barn/.test(r.Summary)), 'not on the server yet');
  assert.match(q(anna, '#mc').textContent, /1 change waiting to be sent/);
  online = true; anna.dispatchEvent(new anna.Event('online')); await wait(400);
  assert.equal(rows('Activities').length, before + 1); assert.ok(rows('Activities').some(r => /barn/.test(r.Summary)));
  assert.ok(!/waiting to be sent/.test(q(anna, '#mc').textContent));
});
test('a change the server refuses is dropped with a message, not retried forever', async () => {
  // Bram\'s customer changes owner on the server while Anna is logging on it: her queued note is refused
  online = false; click(anna, q(anna, '#cLog')); await wait(); set(anna, '#fT', 'Farm A · Amersfoort'); set(anna, '#fS', 'queued, then refused'); submit(anna, '#fF'); await wait(150);
  const d = fixture(true); d.vkOfCust[0] = 'Bram Jansen'; assert.equal(srv.API('upload', { key: 'k', data: JSON.stringify(d) }).ok, true);
  online = true; anna.dispatchEvent(new anna.Event('online')); await wait(500);
  assert.ok(!rows('Activities').some(r => /queued, then refused/.test(r.Summary)), 'the server refused it');
  assert.match(anna.document.getElementById('toast').textContent, /Not saved/); assert.ok(!/waiting to be sent/.test(q(anna, '#mc').textContent), 'the queue is empty again');
});
test('a verkoper cannot reach a customer that is not theirs even by calling the server directly', async () => {
  const r = srv.API('crmSave', { token: token('Bram Jansen'), kind: 'activity', rec: { id: 'hack-000001', ref: 'r2', type: 'note', date: '2026-11-25', summary: 'x' } });
  assert.equal(r.ok, false);
});
(async () => {
  for (const [name, fn] of tests) { try { await fn(); n++; console.log('ok  ' + name); } catch (e) { process.exitCode = 1; console.error('FAIL ' + name + '\n  ' + String(e.stack || e).split('\n').slice(0, 6).join('\n  ')); } }
  for (const [u, w] of [['anna', anna], ['bram', bram], ['johan', johan]]) if (w && w.__err) { console.error('page errors in ' + u + ': ' + w.__err); process.exitCode = 1; }
  console.log(n + '/' + tests.length + ' end-to-end tests passed'); process.exit(process.exitCode || 0);
})();
