# DairyFlow

The DairyTop field and office app: map and visit planning, call list, visit briefing, collections, not invoiced, contracts, and for management the cash forecast, price & margin and buying plan. Installable as an app (PWA) on phones and computers.

## How it works

```
Microfas export (Drive, ~06:30 IST) ──► GitHub Actions 09:00 IST: scripts/dairyflow_data.py ──► DairyFlow API (Apps Script + Google Sheet + Drive)
                                                                                                        ▲
                                     website (GitHub Pages: app only, no data) ── sign in ─────────────┘
```

- **Data** is never stored in this repository or on the website. Every morning at 09:00 India time the workflow downloads the newest Microfas export from Drive, builds the data with `scripts/dairyflow_data.py` (on top of `scripts/generate_data.py`, the same generator as the DairyTop dashboard), checks every total, and uploads it to the DairyFlow API. If one check fails, nothing is uploaded and yesterday's data stays.
- **Sign-in**: everyone picks their name. The first time they create a password with a 6-digit code emailed to them (or a setup code Johan or Leon types in the sheet). Passwords are stored only as salted hashes. Five wrong tries lock the name for 15 minutes; a session lasts 30 days.
- **Who sees what** is decided by the API, not the browser: Johan and Leon (Role = admin in the sheet) get everything; a verkoper's phone only ever receives their own customers.

## Set-up (once)

1. **Apps Script**: create a Google Sheet "DairyFlow users" → Extensions → Apps Script → paste `apps-script/Code.gs`. Script properties: `UPLOAD_KEY` = a long random text. Run `setup()` once. Deploy → Web app, execute as Me, access Anyone. Fill in the Email column per verkoper.
2. **Repository secrets** (Settings → Secrets and variables → Actions):
   - `GDRIVE_CREDENTIALS`, `DRIVE_FOLDER_ID`: the same as in the Dairytop repo
   - `DAIRYFLOW_API_URL`: the web-app URL from step 1
   - `DAIRYFLOW_UPLOAD_KEY`: the same text as `UPLOAD_KEY`
3. **Pages**: Settings → Pages → Source: GitHub Actions. Then Actions → "DairyFlow data and site" → Run workflow.

Reset someone's password: clear their Salt and Hash cells in the sheet. Add a person: add a row (Name, Role, Email).

## Run locally (test mode, no sign-in)

```bash
pip install -r scripts/requirements.txt
python scripts/dairyflow_data.py --zip path/to/export.zip      # writes data/data.json (git-ignored)
python -m http.server 8000                                       # open http://localhost:8000
```

## Files

| Path | What it is |
|---|---|
| `index.html` | The whole app |
| `manifest.webmanifest`, `sw.js`, `icons/` | Install as an app, offline start |
| `apps-script/Code.gs` | DairyFlow API: users, passwords, sessions, data per user |
| `scripts/dairyflow_data.py` | DairyFlow data generator |
| `scripts/generate_data.py` | DairyTop data generator (schema 5.x) used underneath |
| `scripts/static/` | Postcode centres (GeoNames, CC BY 4.0) and borders (Natural Earth), built once by `build_static.py` |
| `scripts/static_data/` | Portal history Jan 2025 – Mar 2026 |

Powered by Knitworks.
