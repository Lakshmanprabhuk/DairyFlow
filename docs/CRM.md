# DairyFlow CRM

Visit notes, follow-up tasks and prospects, inside DairyFlow. Not published with the site (only `index.html`, the manifest, `sw.js` and `icons/` are).

## What it does

- **Contacts**: log a visit, call, email or note on a customer (kind, date, outcome, text). Tick **Private** and only the author can ever read it.
- **Follow-ups**: set a date and a task when logging a contact, or add a task on its own. The home tile shows how many are due; the CRM screen lists overdue, today, next 7 days.
- **Prospects**: farms that are not in Microfas yet (name, country, postcode, place, phone, email, status). They get a diamond pin on the map from country + postcode (the postcode area, like customers). When Microfas has the customer, Johan or Leon links the prospect and its notes move across.
- **Team** (Johan and Leon): contacts per verkoper, and the customers with several verkopers or none, with the rep names.
- **Where it appears**: new CRM module; a "Contacts and follow-ups" panel at the bottom of the visit briefing; a "Contact" block in the map's customer pane; prospect pins on the map; the call list's Called / Ordered / Lost buttons also leave one note per customer per day.

## Who can do what (decided on the server, in `Code.gs`)

| Customer | Writes | Reads |
|---|---|---|
| One verkoper | that verkoper | that verkoper, Johan, Leon |
| Several verkopers | Johan, Leon | Johan, Leon |
| Kantoor / Webshop / Unassigned | Johan, Leon | Johan, Leon |
| Prospect | its creator | its creator, Johan, Leon |

Private notes (and tasks): author only, for everyone including Johan and Leon. Johan and Leon do not write on a verkoper's own customers. Only admins link prospects.

## How it works

- Notes live in three new tabs of the **DairyFlow users** sheet: `Activities`, `Tasks`, `Prospects`. The nightly data upload does not touch them.
- Customers are addressed by their **Microfas id**. `dairyflow_data.py` adds `ref` (position to id) and `reps` (rep names of multi-rep customers) to the data. A verkoper's copy of the data only carries the ids of their own customers and no rep lists.
- API actions added to the web app: `crmList` (everything readable, or only changes since a time), `crmSave`, `crmDelete` (soft), `crmLink`. All need the sign-in token. Writes are limited to 60 a minute per person.
- The app keeps a copy in IndexedDB and a queue of unsent changes. Offline notes are sent when the phone is online again or the app is opened. Opening a CRM screen refreshes if the last sync is more than 2 minutes old.
- Prospect pins use Apps Script's built-in geocoder, once when a prospect is saved or its address changes. No pin if the address is not found.

## Putting it live (any order is safe)

1. **Apps Script**: paste the new `apps-script/Code.gs`, run `setupCrm()` once, then Deploy → Manage deployments → edit → New version (the web app URL stays the same).
2. **Site**: push to `main`. Until the data carries ids, the CRM screen says it starts after the next daily update.
3. **Data**: run the workflow "DairyFlow data and site" (or wait for the daily run). The first upload with `ref` switches the CRM on.

Rollback: deploy the previous Apps Script version and revert the commit. The three tabs stay in the sheet.

## Things to know

- **Sheet access = access to private notes.** Keep the sheet shared with as few people as possible.
- Deleting is a soft delete (`Deleted = Y`); erase the row in the sheet for a real removal. There is no automatic retention rule.
- Prospects are personal data of people who are not customers: keep them to what is needed.
- No email or push reminders yet (in-app only). A prospect cannot be handed to another verkoper yet.
- A Sheet is fine for a team this size; if notes reach tens of thousands of rows, move the three tabs to a database behind the same actions.

## Tests (nothing here is published)

```
python3 tests/test_crm_pipeline.py                                   # ref and reps
node tests/crm_server_test.js                                        # Code.gs rules, with a fake of the Apps Script services
npm install jsdom --prefix /tmp/jt
NODE_PATH=/tmp/jt/node_modules node tests/crm_ui_test.js             # index.html screens, test mode
NODE_PATH=/tmp/jt/node_modules node tests/crm_e2e_test.js            # index.html in live mode against Code.gs
```

These use fakes. They have not been run against a real Apps Script project or a real Microfas export.

## Changes to existing files

All additive; four existing lines were extended, none removed.

- `apps-script/Code.gs`: the CRM section at the end, plus three hooks: unknown actions go to `crmRoute_`, an upload clears the cached ownership map, and `restrict_` calls `crmRestrict_`.
- `scripts/dairyflow_data.py`: `crm_refs()`, `ref` and `reps` in the data, and two checks that cannot fail unless the code is wrong.
- `index.html`: a `crm` entry in the module list, its icon and its home-tile figure, and the CRM code block before the start section. It wraps `V2.brief`, `V2.calls`, `V2.map`, `renderMap` and `side` to add to them.
- Not touched: `.github/workflows/dairyflow.yml`, `sw.js`, `manifest.webmanifest`, `README.md`, `generate_data.py`, `build_static.py`, the static data.
