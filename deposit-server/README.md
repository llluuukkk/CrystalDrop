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

## CS2 skin deposits

The "Buy CR with CS2 skins" tab talks to `POST /skin-deposits` (create an offer), `GET /deposits/:id` (status) and, in demo mode only, `POST /skin-deposits/:id/simulate`.

| Variable | Default | Meaning |
|---|---|---|
| `SKIN_PROVIDER` | `mock` while the payment provider is `mock`, otherwise `off` | `mock` = simulated trades (demo). `off` = the tab says "coming soon". Real Steam trade bots plug in behind the same routes. |
| `SKIN_RATE` | `0.9` | CR credited per $1 of skin market value (0.5 to 1). |
| `SKIN_TTL_MIN` | `15` | Minutes a trade offer stays valid. |
| `SKIN_MAX_ITEMS` | `30` | Skins per offer. |
| `SKIN_BOT_NAME` | `CrystalDropBot` | Name shown to players. |

In `mock` mode the server trusts the skin prices the page sends, so it must never be used with real money. Real mode has to price skins on the server.

## Admin panel
Open `https://YOUR-SERVER/admin` and sign in with the `ADMIN_TOKEN` environment variable (set a long random value on Render, 32+ characters). Overview (what you owe players, house result, deposits), Players (search, balances, adjust CR with a mandatory reason, mute, ban), Rounds (per-game RTP), Deposits, Chat (delete), Prices (live feed status, refresh now) and an audit Log of every admin action. Ten wrong tokens from one IP lock that IP out for 15 minutes. Banning a player ends their sessions and blocks log-in.

## Bot protection (Cloudflare Turnstile)
1. Cloudflare dashboard, Turnstile, Add site: hostname `crystaldropgg.win`, widget type Managed. Copy the Site key and the Secret key.
2. Render, Environment: `TURNSTILE_SECRET` = the secret key.
3. Site: set the site key in index.html as `window.CD_TURNSTILE_KEY` (one line near the top), or run `localStorage.setItem('cd_turnstile_key','SITEKEY')` once to test.
Sign-up, log-in and deposits then require a passed check (24 h pass per browser). Without the secret the server skips the check.

## Sportsbook (soccer + CS2)
Pre-match betting, singles and combos, markets: match result (1X2 for soccer, winner for CS2), total goals, both teams to score. The server settles from the final score (90 minutes for soccer, maps won for CS2); admin can settle or void any match by hand (Admin, Sports tab).
- `ODDS_API_KEY` : your odds-api.io key. Without it a clearly labelled demo feed (made-up teams) runs, and only while payments are in mock mode.
- `SPORTS_BOOK` : which bookmaker's prices to use (default Bet365, must be one selected on your odds-api.io plan).
- `SPORTS_CUT` : share removed from every price above 1.00 (default 0.04).
- `SPORTS_EXPOSURE` : most the house can owe on one match, in CR (default 20000).
- `SPORTS_LIVE=on` : not used yet, live betting stays off.

### Sports feed: The Odds API (default) or odds-api.io
`ODDS_API_KEY` = your key. By default it is a key from the-odds-api.com (football only: 1X2 + totals; no CS2). Set `ODDS_PROVIDER=odds-api.io` to use odds-api.io instead (football + CS2).
The Odds API free plan is 500 credits a month, so the server refreshes every `SPORTS_SYNC_MIN` minutes (default 360) for the leagues in `SPORTS_LEAGUES` (default `soccer_epl,soccer_spain_la_liga,soccer_uefa_champs_league`). Each league refresh costs 1 credit per market (`SPORTS_MARKETS`, default `h2h,totals`). Results use a scores call (2 credits) at most every `SPORTS_SCORES_MIN` minutes (default 180), and only while a bet is waiting for a result.


## Keeping the database safe (do this on Render)

The whole site (balances, rounds, withdrawals, users) lives in one SQLite file. On Render the app folder is wiped on every deploy and restart, so the file must sit on a **persistent disk**:

1. Render, your service, **Disks**, **Add Disk**: name `data`, mount path `/var/data`, 1 GB. (Disks need a paid instance type.)
2. Environment: add `DB_FILE` = `/var/data/crystaldrop.db`. Backups then go to `/var/data/backups` automatically.
3. Deploy. The admin page, **Backups** tab, should now say "Saved on a persistent disk: yes".

The server writes a backup every 24 hours (`BACKUP_HOURS`), keeps the newest 14 (`BACKUP_KEEP`), and you can press **Back up now** or **Download** any backup in the admin page. Download one now and then and keep it somewhere other than the server.

To restore: stop the service, put the downloaded file on the disk as `/var/data/crystaldrop.db`, start the service.

## Using PayGate.to instead of NOWPayments
Set these on Render (Environment): `PROVIDER=paygate`, `PUBLIC_URL`, `PAYGATE_SECRET` (any long random text; it signs the callback links), and your own wallets:
`PAYGATE_ADDR_BTC` (Bitcoin), `PAYGATE_ADDR_SOL` (Solana), `PAYGATE_ADDR_EVM` (one 0x address, used for ETH, USDT and USDC on Ethereum).
PayGate forwards every payment straight to those wallets and then calls `/webhook/paygate`. The crypto callback is not signed by PayGate, so each callback link contains a secret key made from `PAYGATE_SECRET`; callbacks without it are rejected. Prices come from CoinGecko (Binance as backup). A coin whose wallet is not set cannot be deposited. Tests: `node --no-warnings test_paygate.js`.

## Your own Steam trade bot (real CS2 skin deposits)

How it works: `server.js` (web service) never talks to Steam. A second process, `bot.js` (a Render **Background Worker**), logs in to a Steam account that belongs only to the bot and polls the web server over HTTPS with `BOT_TOKEN`.

1. The player pastes their trade URL and presses **Load my CS2 inventory**. The server queues an `inventory` job, the bot reads the (public) inventory, and the server prices every item from **Skinport** (cheapest listing, capped at the median; items nobody lists are hidden). The browser's prices are never used.
2. The player picks skins and presses **Create trade offer**. The server queues a `trade` job; the bot sends an offer asking for those items with the message `CrystalDrop deposit CD-XXXX`.
3. When the player accepts, the bot reports what it really received. The server values it again and credits: **instantly** while the player's skin deposits in the last 7 days stay at or below `SKIN_INSTANT_MAX` (100 CR), otherwise the deposit is **held** for `SKIN_HOLD_DAYS` (7) and credited automatically when the hold ends.
4. The bot re-checks every accepted offer about every 10 minutes during the window. If Steam no longer reports it as accepted, the server takes the credit back (or cancels the hold). You can also do it by hand: Admin > Deposits > Reverse.

Web service variables (on top of the existing ones):

| Variable | Default | Meaning |
|---|---|---|
| `BOT_TOKEN` | none | Long random secret shared with the worker. Setting it turns real skin deposits on (`SKIN_PROVIDER` becomes `bot`). |
| `SKIN_INSTANT_MAX` | `100` | CR a player can receive instantly per hold window. Above it the deposit is held. `0` holds everything. |
| `SKIN_HOLD_DAYS` | `7` | Hold length. `0` credits everything instantly (not recommended). |
| `SKIN_RATE` | `0.9` | CR per $1 of market value. |

Worker (Render > New > Background Worker, same repo, root directory `deposit-server`, build command `npm install`, start command `node bot.js`):

| Variable | Meaning |
|---|---|
| `API_URL` | `https://crystaldrop.onrender.com` |
| `BOT_TOKEN` | exactly the same value as on the web service |
| `STEAM_BOT_USER`, `STEAM_BOT_PASS` | login of the bot's Steam account |
| `STEAM_SHARED_SECRET`, `STEAM_IDENTITY_SECRET` | from the bot account's mobile authenticator |
| `OFFER_TTL_MIN` | minutes before an unaccepted offer is cancelled (default 20) |

The bot account:
- Use a **new Steam account made only for this**, never your own. It needs Steam Guard **mobile authenticator** enabled and must have spent at least $5 so trading is unlocked.
- `shared_secret` and `identity_secret` come from the authenticator when it is set up (for example with the SteamDesktopAuthenticator tool). They are as sensitive as the password: put them only in Render's environment screen, **never paste them in a chat, an issue or a commit**.
- Keep the account's own inventory for the bot only. Anyone who has these secrets can take every skin the bot holds, so move deposited skins out to a cold account on a schedule you set.

What is and is not verified:
- The server half (jobs, pricing, instant vs held credit, release after the hold, reversals, retries) and the bot loop are covered by `test_skinbot.js` and `test_bot.js` with a **fake Steam**. They cannot prove anything about real Steam.
- The Steam adapter in `bot.js` (`steamAdapter`) has **not been run against real Steam** from here. The package calls follow the documented API of `steam-user` / `steam-tradeoffer-manager`, but expect to fix small things on the first real login. Watch the worker log on first start: it prints `steam: logged in`, `trade manager ready`, then one line per inventory read and offer.
- Rollback detection is best effort: the bot treats any later state other than "accepted" as a reversal and logs the raw Steam state number (`REVERSED? ... raw=`). Check the first real one before trusting it, and use Admin > Reverse whenever you learn of a reversal some other way.
- Steam's rules do not allow running a service that pays out money for items, and Valve has banned trading bots before. Expect that the bot account can be restricted or banned at any time.
- A player who gets hijacked-account trades reversed after the hold is still your loss if the CR was already spent. The hold and the per-player instant limit only shrink that risk.
