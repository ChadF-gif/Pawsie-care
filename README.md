# Pawsie

Photo of vet paperwork -> dose-by-dose plan -> real push alerts when a dose is due.

- `public/` the app (single page), service worker `sw.js`, manifest, icons
- `netlify/functions/api.mts` households, plan sync, push subscriptions, check-in alerts
- `netlify/functions/read.mts` reads paperwork photos with Claude (via Netlify AI Gateway)
- `netlify/functions/dispatch.mts` runs every minute and sends due-dose / still-not-given / check-in alerts
- Env vars (Functions scope): `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`
- Optional text alerts: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`

Deploy: `npm install && npx netlify deploy --prod --site 5448da4a-72a7-4fd6-97ef-cce187791819`
