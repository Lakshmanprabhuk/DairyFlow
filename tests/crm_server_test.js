/* Runs apps-script/Code.gs against an in-memory fake of the Apps Script services and checks the CRM rules.
   Run:  node tests/crm_server_test.js                                                                   */
const assert = require('assert');

const { ctx, store, run, API, sheets } = require('./appsscript_fake')();
/* ---------- fixture: five customers ---------- */
const N = 5;
const blank = (f) => Array.from({ length: N }, f);
const data = (withRef) => ({
  meta: { lt: '2026-11-24', generated: '2026-11-25T03:30Z' },
  customers: [[0], [1], [4]], unmapped: [], verkopers: ['Anna de Vries', 'Bram Jansen', 'Johan Hoogendoorn', 'Leon'],
  vkOfCust: ['Anna de Vries', 'Bram Jansen', 'Multiple representatives', 'Kantoor', 'Anna de Vries'],
  names: ['Farm A', 'Farm B', 'Farm C', 'Farm D', 'Farm E'], terms: blank(() => 14), market: blank(() => 'NL'),
  contacts: {}, lateness: {}, vatRatio: {}, quiet: [], collections: [], orders: [], contracts: [], cm: [], cp: [], margin: [1], costs: [1], dayGroup: [1], monthGroup: [1],
  staff: {}, ...(withRef ? { ref: ['r0', 'r1', 'r2', 'r3', 'r4'], reps: { 2: ['Anna de Vries', 'Bram Jansen'] } } : {}),
});
const upload = d => { store.props.UPLOAD_KEY = 'k'; return API('upload', { key: 'k', data: JSON.stringify(d) }); };

let n = 0; const test = (name, fn) => { try { fn(); n++; console.log('ok  ' + name); } catch (e) { console.error('FAIL ' + name + '\n  ' + (e.stack || e).split('\n').slice(0, 4).join('\n  ')); process.exitCode = 1; } };
const tok = {};
const id = (() => { let i = 0; return () => 'id-' + String(++i).padStart(8, '0'); })();
const act = (t, ref, extra = {}) => API('crmSave', { token: tok[t], kind: 'activity', rec: { id: extra.id || id(), ref, type: 'visit', date: '2026-11-25', outcome: 'spoke', summary: 'Talked about feed', ...extra } });
const task = (t, ref, extra = {}) => API('crmSave', { token: tok[t], kind: 'task', rec: { id: extra.id || id(), ref, text: 'Call back', due: '2026-12-01', ...extra } });
const list = (t, since) => API('crmList', { token: tok[t], since });
const A = 'Anna de Vries', B = 'Bram Jansen', J = 'Johan Hoogendoorn', L = 'Leon';

/* ---------- tests ---------- */
test('not ready until the data carries ref', () => {
  run('setup()');          // the existing set-up: Users and Sessions tabs
  assert.equal(upload(data(false)).ok, true);
  run('setupCrm()');
  [A, B, J, L].forEach(n => { tok[n] = run(`(function(){const u=user_(${JSON.stringify(n)});return session_(u).token})()`); });
  assert.equal(list(A).notReady, true);
  assert.equal(act(A, 'r0').notReady, true);
});
test('upload with ref makes the CRM ready (cached ownership map is refreshed)', () => {
  assert.equal(upload(data(true)).ok, true);
  assert.equal(list(A).ok, true);
});
test('users: Johan and Leon are admins, the others verkopers', () => {
  assert.equal(run('user_("Leon").Role'), 'admin'); assert.equal(run('user_("Anna de Vries").Role'), 'verkoper');
});
test('verkoper payload: only own Microfas ids, no rep lists; admin gets everything', () => {
  const a = API('data', { token: tok[A] }).data, j = API('data', { token: tok[J] }).data;
  assert.deepEqual(a.ref, ['r0', '', '', '', 'r4']); assert.deepEqual(a.reps, {});
  assert.deepEqual(j.ref, ['r0', 'r1', 'r2', 'r3', 'r4']); assert.deepEqual(j.reps, { 2: ['Anna de Vries', 'Bram Jansen'] });
});
test('who may write: owner only; multi-rep and channel customers are admin-only', () => {
  assert.equal(act(A, 'r0').ok, true);
  assert.equal(act(A, 'r4').ok, true);
  assert.equal(act(A, 'r1').ok, false, 'not her customer');
  assert.equal(act(A, 'r2').ok, false, 'multi-rep: verkoper may not write');
  assert.equal(act(B, 'r2').ok, false);
  assert.equal(act(A, 'r3').ok, false, 'channel customer: verkoper may not write');
  assert.equal(act(J, 'r2').ok, true); assert.equal(act(L, 'r3').ok, true);
  assert.equal(act(J, 'r0').ok, false, 'admins do not write on a verkoper\'s customer');
  assert.equal(act(A, 'r9').ok, false, 'unknown customer');
});
test('who may read: owner and admins; private notes only by the author', () => {
  const pr = act(A, 'r0', { priv: 1, summary: 'secret' }); assert.equal(pr.ok, true);
  const a = list(A), b = list(B), j = list(J), l = list(L);
  const text = x => x.activities.map(r => r.summary);
  assert.ok(text(a).includes('secret'));
  assert.ok(!text(j).includes('secret') && !text(l).includes('secret'), 'admins never get a private note');
  assert.ok(text(j).includes('Talked about feed'), 'admins read normal notes');
  assert.equal(b.activities.length, 0, 'Bram sees nothing of Anna\'s');
  assert.ok(a.activities.every(r => r.ref === 'r0' || r.ref === 'r4'), 'Anna sees nothing on multi-rep/channel customers');
  assert.ok(j.activities.some(r => r.ref === 'r2') && j.activities.some(r => r.ref === 'r3'));
  assert.ok(!JSON.stringify(j).includes('secret'));
});
test('edit: only the author; ref and privacy never change', () => {
  const c = act(A, 'r0', { priv: 1, summary: 'v1' }).rec;
  assert.equal(act(B, 'r0', { id: c.id, summary: 'hijack' }).ok, false);
  assert.equal(act(J, 'r0', { id: c.id, summary: 'hijack' }).ok, false);
  const e = act(A, 'r1', { id: c.id, summary: 'v2', priv: 0 });
  assert.equal(e.ok, true); assert.equal(e.rec.ref, 'r0'); assert.equal(e.rec.priv, 1); assert.equal(e.rec.summary, 'v2');
  assert.equal(act(A, 'r0', { id: c.id, summary: 'v2' }).rec.created, c.created, 'a repeated send is an idempotent edit');
});
test('validation', () => {
  assert.equal(act(A, 'r0', { id: 'x' }).ok, false, 'bad id');
  assert.equal(act(A, 'r0', { type: 'fax' }).ok, false);
  assert.equal(act(A, 'r0', { date: '2026-13-45' }).ok, false);
  assert.equal(act(A, 'r0', { date: '2030-01-01' }).ok, false, 'far future');
  assert.equal(act(A, 'r0', { summary: '   ' }).ok, false);
  assert.equal(act(A, 'r0', { outcome: 'hacked' }).ok, false);
  assert.equal(act(A, 'r0', { summary: 'x'.repeat(5000) }).rec.summary.length, 2000, 'long text is cut');
  assert.equal(act(A, 'r0', { summary: '=HYPERLINK("http://x")' }).rec.summary, '=HYPERLINK("http://x")', 'stored as text, never evaluated');
  assert.equal(task(A, 'r0', { text: '' }).ok, false);
  assert.equal(task(A, 'r0', { due: 'tomorrow' }).ok, false);
  assert.equal(API('crmSave', { token: tok[A], kind: 'weird', rec: { id: id() } }).ok, false);
});
test('dates and ids survive the sheet unchanged (text format)', () => {
  const r = act(A, 'r0', { date: '2026-11-20' }).rec; const row = run('crmRows_("Activities")').find(x => x.Id === r.id);
  assert.equal(row.Date, '2026-11-20'); assert.ok(/^\d{4}-\d\d-\d\dT/.test(row.Created));
});
test('tasks: create, complete, delete; admins see them, other verkopers do not', () => {
  const t = task(A, 'r0').rec; assert.equal(t.status, 'open'); assert.equal(t.owner, A);
  assert.equal(task(B, 'r0', { id: t.id, status: 'done' }).ok, false);
  const d = task(A, 'r0', { id: t.id, status: 'done' }); assert.equal(d.ok, true); assert.ok(d.rec.done);
  assert.ok(list(J).tasks.some(x => x.id === t.id)); assert.equal(list(B).tasks.length, 0);
  assert.equal(API('crmDelete', { token: tok[B], kind: 'task', id: t.id }).ok, false);
  assert.equal(API('crmDelete', { token: tok[A], kind: 'task', id: t.id }).ok, true);
  assert.ok(!list(A).tasks.some(x => x.id === t.id));
});
test('delta list: since returns changes and deletions only', () => {
  const first = list(A), c = act(A, 'r0', { summary: 'delta' }).rec;
  const d1 = list(A, new Date(Date.now() - 1000).toISOString());
  assert.ok(d1.activities.some(x => x.id === c.id));
  const mid = new Date(Date.now() + 2000).toISOString();
  assert.equal(list(A, mid).activities.length, 0);
  API('crmDelete', { token: tok[A], kind: 'activity', id: c.id });
  const d2 = list(A, new Date(Date.now() - 1000).toISOString());
  assert.ok(d2.activities.some(x => x.id === c.id && x.del === 1), 'tombstone');
  assert.ok(!list(A).activities.some(x => x.id === c.id), 'full list omits deleted');
  assert.ok(first.full === true && d1.full === false);
});
test('a stranger\'s tombstone is not sent (private notes leave no trace)', () => {
  const p = act(A, 'r0', { priv: 1, summary: 'hush' }).rec; API('crmDelete', { token: tok[A], kind: 'activity', id: p.id });
  const since = new Date(Date.now() - 1000).toISOString();
  assert.ok(!JSON.stringify(list(J, since)).includes(p.id), 'admin gets no id of a private note');
});
test('prospects: owner writes, admins read, others see nothing; geocoded from postcode', () => {
  const pid = id(), r = API('crmSave', { token: tok[A], kind: 'prospect', rec: { id: pid, name: 'Hof Nieuw', cc: 'NL', pc: '3811 AB', place: 'Amersfoort', phone: '+31 6 12345678', email: 'a@b.nl', status: 'new', notes: 'Met at fair' } });
  assert.equal(r.ok, true); assert.equal(r.rec.owner, A); assert.equal(r.rec.la, 52.1235); assert.equal(r.rec.lo, 5.1235);
  assert.ok(list(J).prospects.some(p => p.id === pid)); assert.ok(!list(B).prospects.some(p => p.id === pid));
  assert.equal(API('crmSave', { token: tok[B], kind: 'prospect', rec: { id: pid, name: 'x', cc: 'NL' } }).ok, false, 'not the owner');
  const nowhere = API('crmSave', { token: tok[A], kind: 'prospect', rec: { id: id(), name: 'Hof Nergens', cc: 'NL', place: 'nowhere' } });
  assert.equal(nowhere.ok, true); assert.equal(nowhere.rec.la, null, 'no pin when the address is not found');
  assert.equal(API('crmSave', { token: tok[A], kind: 'prospect', rec: { id: id(), name: '', cc: 'NL' } }).ok, false);
  assert.equal(API('crmSave', { token: tok[A], kind: 'prospect', rec: { id: id(), name: 'x', cc: 'XX' } }).ok, false);
  assert.equal(API('crmSave', { token: tok[A], kind: 'prospect', rec: { id: id(), name: 'x', cc: 'NL', email: 'nope' } }).ok, false);
  assert.equal(API('crmSave', { token: tok[A], kind: 'prospect', rec: { id: id(), name: 'x', cc: 'NL', phone: '12' } }).ok, false);
  const before = store.geocodes; API('crmSave', { token: tok[A], kind: 'prospect', rec: { id: pid, name: 'Hof Nieuw 2', cc: 'NL', pc: '3811 AB', place: 'Amersfoort', status: 'contacted' } });
  assert.equal(store.geocodes, before, 'unchanged address is not geocoded again');
});
test('notes on a prospect: only its owner writes; admins read', () => {
  const pid = list(A).prospects[0].id, ref = 'p:' + pid;
  assert.equal(act(A, ref).ok, true); assert.equal(act(B, ref).ok, false); assert.equal(act(J, ref).ok, false, 'admins read, they do not write');
  assert.ok(list(J).activities.some(x => x.ref === ref)); assert.ok(!list(B).activities.some(x => x.ref === ref));
});
test('link: admin only; notes move to the customer; Bram (new owner) reads normal notes only', () => {
  const pid = id(); API('crmSave', { token: tok[A], kind: 'prospect', rec: { id: pid, name: 'Hof Link', cc: 'NL', place: 'Ede' } });
  act(A, 'p:' + pid, { summary: 'public one' }); act(A, 'p:' + pid, { summary: 'private one', priv: 1 }); task(A, 'p:' + pid, { text: 'prospect task' });
  assert.equal(API('crmLink', { token: tok[A], id: pid, ref: 'r1' }).ok, false, 'verkoper may not link');
  assert.equal(API('crmLink', { token: tok[J], id: pid, ref: 'nope' }).ok, false);
  assert.equal(API('crmLink', { token: tok[J], id: pid, ref: 'r1' }).ok, true);
  const b = list(B).activities.map(x => x.summary);
  assert.ok(b.includes('public one') && !b.includes('private one'));
  assert.ok(list(B).tasks.some(t => t.text === 'prospect task'));
  assert.equal(act(A, 'p:' + pid).ok, false, 'linked prospect takes no more notes');
  assert.equal(API('crmLink', { token: tok[J], id: pid, ref: 'r1' }).ok, false, 'already linked');
});
test('deleted prospect hides its notes', () => {
  const pid = id(); API('crmSave', { token: tok[B], kind: 'prospect', rec: { id: pid, name: 'Weg', cc: 'DE' } });
  act(B, 'p:' + pid, { summary: 'gone soon' });
  assert.equal(API('crmDelete', { token: tok[A], kind: 'prospect', id: pid }).ok, false);
  assert.equal(API('crmDelete', { token: tok[B], kind: 'prospect', id: pid }).ok, true);
  assert.ok(!list(J).activities.some(x => x.summary === 'gone soon'));
});
test('sign-in is required; expired or wrong tokens are refused', () => {
  assert.equal(API('crmList', {}).signin, true); assert.equal(API('crmList', { token: 'bogus' }).signin, true);
  assert.equal(API('crmSave', { kind: 'activity', rec: { id: id() } }).signin, true);
});
test('writes are throttled', () => {
  let blocked = false; for (let i = 0; i < 70; i++) if (/Too many/.test(act(B, 'r1').error || '')) blocked = true;
  assert.ok(blocked);
});
test('existing actions still behave: unknown action, people list', () => {
  assert.equal(API('nonsense', {}).error, 'Unknown action'); assert.equal(API('people', {}).ok, true);
});
test('a new upload with changed owners takes effect at once', () => {
  Object.keys(store.cache).filter(k => k.startsWith('crm:w:')).forEach(k => delete store.cache[k]);   // the throttle test used up Bram's minute
  const d = data(true); d.vkOfCust[0] = 'Bram Jansen'; upload(d);
  assert.equal(act(A, 'r0').ok, false); assert.equal(act(B, 'r0').ok, true);
});
console.log(n + ' tests passed' + (process.exitCode ? ' (with failures)' : ''));
