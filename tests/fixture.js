/* Small data set shaped like the app's data.json (4 customers: two single-rep, one multi-rep, one channel). */
const months = []; for (let y = 2025; y <= 2026; y++) for (let m = 1; m <= 12; m++) if (y < 2026 || m <= 11) months.push(`${y}-${String(m).padStart(2, '0')}`);
const cust = (i, n, vk, pl, la, lo) => [i, n, vk, 14, 'NL', '3811AB', pl, la, lo, -1, 100000 * (i + 1), 5000, [0, 0, 0, 0, 0, 0], 0, 0, '2026-11-01', '2025-01-01'];
const fixture = withRef => ({
  meta: { lt: '2026-11-24', snap: '2026-11-25', lostCut: '2026-05-28', months, qScale: 100, arStart: '2026-04-07', portal: [], schema: '5.0.0', ytd: '2026-01/2026-10', generated: 'g1' },
  cols: ['i', 'n', 'v', 't', 'cc', 'pc', 'pl', 'la', 'lo', 'rg', 'r12', 'k12', 'g', 'y', 'py', 'ls', 'fs'],
  customers: [cust(0, 'Farm A', 'Anna de Vries', 'Amersfoort', 52.15, 5.39), cust(1, 'Farm B', 'Bram Jansen', 'Ede', 52.04, 5.67), cust(2, 'Farm C', 'Multiple representatives', 'Zwolle', 52.5, 6.09), cust(3, 'Farm D', 'Kantoor', 'Assen', 53.0, 6.56)],
  unmapped: [], names: ['Farm A', 'Farm B', 'Farm C', 'Farm D'], vkOfCust: ['Anna de Vries', 'Bram Jansen', 'Multiple representatives', 'Kantoor'],
  verkopers: ['Anna de Vries', 'Bram Jansen', 'Johan Hoogendoorn', 'Leon'], terms: [14, 14, 14, 14], market: ['NL', 'NL', 'NL', 'NL'], contacts: {},
  regions: [], countries: [], groups: ['Milk powder', 'Feed', 'Calf housing', 'Calf supplies', 'Perfect Udder', 'Other'],
  quiet: [{ c: 2, last: '2026-08-01', rev: 9000, items: ['Feed'], orders: 2, since: 115 }, { c: 0, last: '2026-09-01', rev: 5000, items: ['Pro Elite'], orders: 3, since: 84 }],
  calls: [], cadence: [], collections: [], orders: [], products: [], cp: [], dayGroup: [], monthGroup: [], cm: [], vatRatio: {}, lateness: {}, prodTot: {}, pen: {},
  margin: [], costs: [], contracts: [], ...(withRef ? { ref: ['r0', 'r1', 'r2', 'r3'], reps: { 2: ['Anna de Vries', 'Bram Jansen'] } } : {}),
});

module.exports = fixture;
