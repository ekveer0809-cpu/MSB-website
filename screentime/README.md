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
npm start
```

On first launch each account has no password. The home screen lists Parent, Child 1 and Child 2; tapping one that
isn't set up yet asks you to choose a password (typed twice), and from then on it shows a normal login. The adult
should set up first, since whoever taps an unclaimed account first gets it. The adult can later change any password
under **Settings** (e.g. if a child forgets theirs). You can still pre-set passwords with the env vars above.

**Remember me** (ticked by default): keeps you signed in on that device for 30 days. Unticked, you stay signed in
until the browser/app is closed (and at most 12 hours).

Other env vars: `PORT` (3000), `DATA_DIR` (`./data`), `VAPID_SUBJECT` (a `https://` URL for push).

## Deploying

Push notifications and installing as an app both require **HTTPS** (localhost is exempt), and the server needs a
persistent disk for `DATA_DIR` (accounts, logs, push subscriptions). Use a long-running host such as Render, Fly.io,
Railway or a VPS; serverless hosts (e.g. Vercel) are not suitable because they have no persistent filesystem.

## Using it

1. Open the site on each device, pick who you are, set your password, tap **Enable** on the notifications banner.
2. iPhone/iPad: Share → **Add to Home Screen** first, then open from the home screen (iOS only allows web push for installed apps).
3. Android/desktop Chrome: use the browser's Install option.

The adult's **Alerts** tab keeps a history of every notification, in case a push is missed.

`npm run icons` regenerates the app icons.
