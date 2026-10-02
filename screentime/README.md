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

## Deploy to Vercel (recommended)

The same code runs as a Vercel serverless function (`api/[...route].js`) with state stored in **Upstash Redis**.

1. Vercel → **Add New → Project** → import this repo. Set **Root Directory** to `screentime`. No build settings needed.
2. In the project: **Storage → Create / Connect Database → Upstash Redis** (free plan is fine). This adds the
   `KV_REST_API_URL` / `KV_REST_API_TOKEN` env vars automatically.
3. **Settings → Environment Variables**, add:
   - `CRON_SECRET` = any long random string
   - `VAPID_SUBJECT` = your site URL, e.g. `https://your-app.vercel.app`
4. Redeploy so the env vars take effect.
5. **The 90-minute check needs a timer.** Vercel's free (Hobby) cron only runs daily, so use a free external
   scheduler such as [cron-job.org](https://cron-job.org): create a job that calls
   `https://your-app.vercel.app/api/cron?key=YOUR_CRON_SECRET` **every 1 minute**. (On Vercel Pro you can instead add a
   `crons` entry in `vercel.json` for `/api/cron`; Vercel sends `CRON_SECRET` automatically.)
   Without it the limit alert still fires, but only when someone has the app open (it re-checks every 15s).

## Run elsewhere (VPS / home server)

`npm start` runs the same code with a JSON file in `DATA_DIR` (`./data`) instead of Redis, and set
`CRON_SECRET` to enable the built-in 10s timer. Needs HTTPS in front for phones (e.g. Caddy or a Cloudflare Tunnel).

## Using it

1. Open the site on each device, pick who you are, set your password, tap **Enable** on the notifications banner.
2. iPhone/iPad: Share → **Add to Home Screen** first, then open from the home screen (iOS only allows web push for installed apps).
3. Android/desktop Chrome: use the browser's Install option.

The adult's **Alerts** tab keeps a history of every notification, in case a push is missed.

`npm run icons` regenerates the app icons.
