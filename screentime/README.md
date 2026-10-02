# Screen Time PWA

Installable web app with one **Adult** and two **Child** accounts (password login, no email).

- A child taps **Start** / **End**; the date and time are logged and the adult gets a push notification.
- The adult sees both children's logs, each child's total for today and the combined total.
- Daily allowance is **90 minutes per child** (changeable in Settings). The adult is notified when a child
  reaches the limit while still logged in (checked every 5 seconds), and when a session ends over the limit.
  The child is also told when time is up. The adult can end a running session with **End now**.
- Days reset at midnight in the timezone set in Settings (auto-set from the adult's device on first login).

## Run

```bash
cd screentime
npm install
ADULT_PASSWORD=... CHILD1_PASSWORD=... CHILD2_PASSWORD=... npm start
```

Without the env vars, random passwords are generated on first run and printed to the console. They are only
read on first run (when `data/data.json` is created); afterwards change them under **Settings** as the adult.

Other env vars: `PORT` (3000), `DATA_DIR` (`./data`), `VAPID_SUBJECT` (a `https://` URL for push).

## Deploying

Push notifications and installing as an app both require **HTTPS** (localhost is exempt), and the server needs a
persistent disk for `DATA_DIR` (accounts, logs, push subscriptions). Use a long-running host such as Render, Fly.io,
Railway or a VPS; serverless hosts (e.g. Vercel) are not suitable because they have no persistent filesystem.

## Using it

1. Open the site on each device, log in, tap **Enable** on the notifications banner.
2. iPhone/iPad: Share → **Add to Home Screen** first, then open from the home screen (iOS only allows web push for installed apps).
3. Android/desktop Chrome: use the browser's Install option.

The adult's **Alerts** tab keeps a history of every notification, in case a push is missed.

`npm run icons` regenerates the app icons.
