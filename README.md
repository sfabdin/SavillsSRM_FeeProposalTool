# Savills SRM · Fee System
Clean instance of the PPM fee suite for Savills Relocation Management (separate P&L).

## What's different from PPM
- Box folder: https://savillsamericas.app.box.com/folder/402841290685 — file ids are NOT hardcoded; on first login the app finds projects.json / rates.json / studio.json / staff.json by NAME in that folder and creates the living JSON files if missing. rates.json must be UPLOADED (rate gate shows until it is).
- Zero data: no projects, no staffing allocations, no small-works records (Import Small Works removed entirely), no benchmark samples, no mappings.
- Time actuals: Paylocity (drop paylocity-actuals.csv in the Box folder / manual CSV drop). No Clockify API.
- Local storage namespaced (srm_*, savills-srm-fee-db:v1) — safe to run beside PPM in the same browser.
- Accent: teal (#2FA3B4 / press #238291) replaces Savills yellow across the UI so the two instances are unmistakable. No cover page — Projects Index is the front page (index.html redirects); PPM docs (roadmap, guides, runbook) removed.

## Deploy checklist
1. New Vercel project from this folder (e.g. srm-fee-generator.vercel.app). Set env BOX_CLIENT_SECRET (same Box app).
2. Box Developer Console → the existing app → add redirect URI: https://<srm-domain>/oauth-callback.html
3. Upload rates.json (SRM rate grid, same structure as PPM's) to the SRM Box folder.
4. Log in — projects.json / staff.json / studio.json are created automatically.

## Open items
- Admin allowlist in universal-fee-calc/store.js is copied from PPM — trim/extend for SRM.
- Revenue leaders start EMPTY: free-entered via "＋ Add revenue leader…" in the lead dropdowns; entries persist in the shared projects.json and join the selection list for everyone.
- Paylocity CSV column mapping: parser still expects the Clockify export shape; send a sample Paylocity export to wire it up.
