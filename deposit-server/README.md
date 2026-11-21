# CrystalDrop deposit server

Zero-dependency Node 22+ server. Creates crypto payments via **NOWPayments**, verifies their signed webhooks, and credits each deposit **exactly once** in SQLite.

## Run it locally (mock provider, no money)
    cd deposit-server
    node --no-warnings server.js          # mock provider on :8788
    node --no-warnings test.js            # 51 checks
In the casino page open Deposit -> paste `http://localhost:8788` -> Connect. In mock mode, simulate a payment with
`curl -X POST localhost:8788/dev/pay/<deposit id>` (add `?status=confirming` first to see the progress bar).

## Go live with NOWPayments
1. Create a NOWPayments account, API key and IPN secret (Store settings). Check their terms allow your business.
2. `cp .env.example .env` and fill in `NOWPAYMENTS_API_KEY`, `NOWPAYMENTS_IPN_SECRET`, `PUBLIC_URL` (https URL where this server is reachable), `ALLOWED_ORIGIN` (your site), `ADMIN_TOKEN`.
3. Try `NOWPAYMENTS_SANDBOX=1` first.
4. Run behind HTTPS (Caddy / nginx / your host's TLS). Keep the `.env` and `deposits.db` private and back the db up.
5. Check the coin codes in `COINS` (server.js) against `GET https://api.nowpayments.io/v1/currencies` for your account.

## Accounts
Email + password (scrypt-hashed, 8+ chars, 18+ confirmation) and Steam login (OpenID, verified with Steam). Sessions are random bearer tokens stored hashed. Deposits always go to the signed-in account.
Set `SITE_URL` (where players land after Steam) and `PUBLIC_URL` (this server's https address). `STEAM_API_KEY` is optional and only adds the Steam profile name.
Email verification (needed before depositing; Steam accounts count as verified) and password reset (1-hour single-use link, signs out all devices) are built in. Emails go through Resend: set `RESEND_API_KEY` and `EMAIL_FROM` (a sender on a domain you verified with Resend). Without a key, emails are only printed in the server log. Not included: 2FA.

## API
- `POST /deposits` `{coin, network, amountCR, userId}` -> `{id, address, memo, cryptoAmount, rate, expiresAt, confirmationsRequired}`  (2-10000 CR)
- `GET /deposits/:id` -> `{status: pending|confirming|credited|expired|partial, confirmations, txid}`
- `POST /auth/signup` `POST /auth/login` `GET /auth/me` `POST /auth/logout` `POST /auth/change-password` `POST /auth/logout-others` `POST /auth/profile` `POST /auth/verify` `POST /auth/resend-verification` `POST /auth/forgot` `POST /auth/reset` `GET /auth/steam` (+ `/auth/steam/callback`, `POST /auth/exchange`)
- `POST /webhook/nowpayments` (HMAC-SHA512 verified)   `GET /balance/:userId` (admin token)   `GET /health`

## Important
- This is **not yet your game balance.** Credits are recorded in the server ledger (`ledger` table). The casino page still keeps its own balance in the browser, so a player could edit it. For real money, balances and every bet must live on the server with real accounts and logins; that is a separate, larger build.
- `partial` payments (customer sent too little) are NOT credited and are logged in `events` for manual review.
- Payment processors and law often restrict gambling. Check both before taking real money.

## Captcha (Cloudflare Turnstile)

1. In the Cloudflare dashboard open Turnstile and add your domain. You get a site key and a secret.
2. Server: set `TURNSTILE_SECRET=<secret>` in `.env`. `POST /captcha/verify {token}` checks the token with Cloudflare and returns a 24 h signed pass.
   Sign up, log in and `POST /deposits` then need that pass in the `X-Human` header (the page sends it); without it they answer 403.
3. Page: set `window.CD_TURNSTILE_KEY = '<site key>'` before the app script, or `localStorage.cd_turnstile_key`. The entry screen then shows the Turnstile widget.
Without a secret the server skips the check; without a site key the page uses the built-in picture check (not real bot protection).
Cloudflare's test key `1x00000000000000000000AA` (always passes) is for development only.

## Live chat and tips

- `GET /chat?after=<id>` (public) returns the latest 60 messages, or the ones after an id. `POST /chat {text}` needs a signed-in, email-confirmed account.
  Limits: one message per user every 5 seconds (`CHAT_GAP_MS`), 200 characters, no links, no repeating the same message within a minute, muted users blocked. The newest 500 messages are kept.
- `POST /tips {to, amount}` sends CR to another player by display name (display names are now unique, ignoring case). 1 to `TIP_MAX` (1000) per tip, `TIP_DAY` (5000) per 24 hours, one tip every 5 seconds.
  The receiver's page polls `GET /tips/incoming` and claims each tip once with `POST /tips/claim {ids}`.
- Admin (Bearer `ADMIN_TOKEN`): `POST /admin/chat/delete {id}` and `POST /admin/mute {name, minutes}`.
- The wager lock (1x of every CR bought before tipping) is enforced in the page, because balances and wagers are still kept in the browser. Move balances to the server before relying on it.
