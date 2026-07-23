# Deploying moggers.in

Target is a **Worker with static assets** — not Pages. Pages Functions cannot
carry a cron trigger, and this needs one for the 6-hourly ATS sweep. So it is
`wrangler deploy`, **never** `wrangler pages deploy`.

## Already wired (done 2026-07-23)

- D1 database `moggers` created in region **APAC**, id
  `3c752a55-9a67-45a1-9db6-019597c6c2fd`, already in `wrangler.toml`.
- Remote schema applied — 6 tables: `jobs`, `users`, `sessions`, `oauth_state`,
  `saved_jobs`, `sync_log`.
- Account: `rahullrvithal@gmail.com` / `ade9aefc26d013bf4ac5b29dc447e997`.

## 0. Move moggers.in onto Cloudflare (BLOCKING — do this first)

As of 2026-07-23 the domain is **not** on Cloudflare. Checked:

- Nameservers: `ns63.domaincontrol.com`, `ns64.domaincontrol.com` → **GoDaddy**
- Web: a GoDaddy parking page (redirects to `/lander`) — nothing real to preserve
- **MX: `mailstore1.secureserver.net`, `smtp.secureserver.net` → GoDaddy email**

A Worker custom domain requires the zone to live on your Cloudflare account, so
`wrangler deploy` will fail until this is done. That failure is deliberate:
`workers_dev = false` means there is no fallback URL, so the site cannot go live
anywhere you did not choose.

1. Cloudflare dashboard → **Add a site** → `moggers.in` → Free plan.
2. Let it scan the existing DNS, then **check the imported records before
   continuing** — especially the two MX records above.
   **If the MX records are missing, add them manually.** Moving nameservers
   without them silently breaks email to that domain, and nothing will warn you.
3. At GoDaddy, change the nameservers to the two Cloudflare gives you.
4. Wait for the zone to show **Active** (usually minutes, up to 24h).
5. Confirm: `nslookup -type=NS moggers.in` should return `*.ns.cloudflare.com`.

The parking-page A records (`3.33.130.190`, `15.197.148.33`) can be deleted —
the Worker custom domain manages the apex record itself.

## 1. Register the OAuth apps (you, not the tooling)

Callback URLs must match exactly, including scheme and trailing path.

| Provider | Where | Callback |
|---|---|---|
| GitHub | Settings → Developer settings → OAuth Apps → New | `https://moggers.in/auth/callback/github` |
| Google | Cloud Console → APIs & Services → Credentials → OAuth client ID (Web) | `https://moggers.in/auth/callback/google` |

`workers_dev = false` means moggers.in is the only origin that will ever serve
this Worker, so these two callbacks are the only ones you need — there is no
second URL to keep in sync.

## 2. Set the secrets

Run these yourself — the values are credentials and must not be pasted into a
chat, a file, or `wrangler.toml`. Each command prompts for the value.

```bash
npx wrangler secret put SYNC_TOKEN
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

`SYNC_TOKEN` is your own invention — generate a long random string. Without it,
`/api/sync` returns 401 for everyone, which is the safe default.

`.dev.vars` holds fake values for local dev only and is gitignored. It is never
uploaded.

## 3. Deploy

```bash
npm run deploy
```

That runs `npm run build` first — deploying a stale `dist/` is the single
easiest mistake to make here.

## 4. Seed the job index

The cron fires every 6 hours, so a fresh deploy has an empty jobs table until it
does. Trigger the first sweep by hand:

```bash
curl -X POST -H "x-sync-token: YOUR_TOKEN" https://moggers.in/api/sync
```

POST with a header, not a GET with a query param — a token in a URL leaks into
browser history, proxy logs and `Referer`. Expect ~5,600 postings from 19 boards
and `errors: []`. A renamed board token shows up here as a per-board error
without failing the sweep.

## 5. Custom domain

Nothing to do — `routes` in `wrangler.toml` provisions `moggers.in` and its
certificate during step 3. Confirm with `npx wrangler deployments list` and by
loading the domain over HTTPS. Certificate issuance can lag the deploy by a few
minutes on first publish.

## Post-deploy verification

These cannot be checked locally and must be done against production.

1. **Rate limiting.** The `[[ratelimits]]` binding is a **no-op in
   `wrangler dev`** — 80 rapid local requests all return 200. Confirm it works
   for real:
   ```bash
   for i in $(seq 1 80); do curl -s -o /dev/null -w "%{http_code} " https://moggers.in/api/facets; done
   ```
   Expect 429s after ~60. If every response is 200, the binding is not active.

2. **Security headers.** `curl -sI https://moggers.in/ | grep -i content-security`
   should show the full policy, and `curl -sI https://moggers.in/api/facets`
   should show the tighter `default-src 'none'` one. Two different policies is
   correct — `_headers` covers assets only, Worker code sets its own.

3. **Sign-in round trip.** Sign in with both providers, save a role, sign out,
   sign back in, confirm the star persisted. Then delete the account and confirm
   `/api/saved` returns 401.

4. **The privacy claim.** Load the site with devtools open, run a resume scan,
   and confirm **zero non-same-origin requests**. This is the claim the whole
   product rests on; check it on every deploy that touches the front end.

5. **Cron.** After ~6 hours confirm a new `sync_log` row:
   ```bash
   npx wrangler d1 execute moggers --remote --command "SELECT * FROM sync_log ORDER BY ran_at DESC LIMIT 3"
   ```
   The site shows "synced Nh ago", and switches to a warning past 14h — so a
   dead cron is visible on the page rather than only in the database.

## Gotcha: changing `database_id` wipes your LOCAL database

Wrangler keys local D1 storage by `database_id`. Swapping the placeholder for the
real id pointed `wrangler dev` at a brand-new empty local DB, and every request
failed with `no such table: jobs`. Nothing was lost remotely — but if local dev
suddenly 500s after a config change, this is why:

```bash
npx wrangler d1 execute moggers --local --file=schema.sql
curl -X POST -H "x-sync-token: local-dev-only" http://127.0.0.1:4341/api/sync
```

## Rollback

```bash
npx wrangler deployments list
npx wrangler rollback [deployment-id]
```

Rollback reverts code only. It does **not** revert D1 schema changes, so any
migration must be additive and backwards-compatible with the previous version.

## Not yet done

- **Turnstile** on the future agent endpoint. Your wrangler token is currently
  missing the `challenge-widgets.write` scope — run `wrangler login` again
  before setting that up.
- Workers AI + Vectorize bindings (the matching agent).
- Per-role pages for SEO.
