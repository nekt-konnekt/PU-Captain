# PU Captain

Offline-first polling unit field app. Static frontend + Vercel serverless API + Neon Postgres (row-level security).

## Layout
- `index.html`, `styles.css`, `app.js` : the app (no inline scripts, strict CSP)
- `sw.js`, `manifest.webmanifest`, `icons/`, `fonts/` : offline shell, installable PWA, self-hosted fonts
- `api/` : serverless functions (auth, sync, voters, incidents, warroom)
- `scripts/` : tests (`npm install && npm test`)

## Deploy
1. Push this folder to the repo root and import the repo in Vercel (Framework preset: Other).
2. Set environment variables: `DATABASE_URL`, `JWT_SECRET`, `PHONE_KEY`, `OTP_MODE` (+ `TERMII_API_KEY`, `TERMII_SENDER` when not mock).
   Secrets: `openssl rand -base64 48`
3. `OTP_MODE=mock` returns the OTP in the response. Development and synthetic data only.
4. After changing cached files, bump `VERSION` in `sw.js`.

## Test logins (synthetic seed, mock OTP only)
0000000001 admin, 0000000002 coordinator (Surulere), 0000000003 captain (PU 003), 0000000004 captain (Ikeja).
Delete these users before any real use.

## API
| Method | Path | Who |
|---|---|---|
| GET | /api/health | public |
| POST | /api/auth/request-otp, /api/auth/verify-otp | public |
| POST | /api/sync | captain |
| GET, DELETE | /api/voters | all roles (delete: captain) |
| GET, PATCH | /api/incidents | all / coordinator, admin resolve |
| GET | /api/warroom | coordinator, admin (aggregates only) |

## Behaviour
- Entries are written to IndexedDB first, then synced in batches (idempotent by client-generated ID).
- A queued entry only syncs for the user who created it.
- SOS is an incident with severity `sos`, with GPS if available. Set `SOS_SMS_NUMBER` in `app.js` to also open the SMS app when offline.
- Voice notes were removed: the API doesn't support them yet.
- Tokens last 12h; role and active status are re-checked in the database on every request.
