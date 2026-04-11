# CLAUDE.md — y28 Polymarket Bot

## What This Is
A fully autonomous Polymarket trading bot. SuperScalp ONLY — no AI brain, no news, no whale tracking, no extras. Trades 5-minute and 15-minute "Up or Down" binary markets for BTC, ETH, SOL, XRP across 8 lanes.
Brand: "a year28 development"
Dashboard: shtatmay.zeabur.app

## Tech Stack
- **Runtime:** Node.js 20+ / Express.js / port 3000
- **Database:** SQLite via `better-sqlite3` (NOT sql.js)
- **Blockchain:** `ethers.js` v5 ONLY (v6 breaks @polymarket/clob-client)
- **Trading:** `@polymarket/clob-client` for CLOB orders
- **Prices (current):** Coinbase WebSocket (BTC-USD, ETH-USD, SOL-USD, XRP-USD)
- **Prices (open/oracle):** Chainlink on-chain price feeds on Polygon
- **HTTP:** `axios` everywhere — NEVER use `fetch`
- **Dashboard:** React + Vite + Tailwind
- **Deploy:** Docker → Zeabur Amsterdam (Linode Netherlands)
- **Persistent volume:** `/app/data`

## SACRED CODE — NEVER TOUCH THESE FILES
The following files are battle-tested and working correctly. Do NOT modify them under ANY circumstances unless Andi explicitly says "modify [filename]":

1. **server/chainlink.js** — Chainlink on-chain price feed reader. This is the #1 most critical file. It reads oracle prices that match Polymarket's resolution source. Changing this breaks all trade accuracy.
2. **server/claimer.js** — Claim/redeem system. Uses Data API as single source of truth. Has blacklist for ghost positions. Has balance-change detection for auto-blacklisting. Claim lock prevents concurrent redeems. This code was debugged across 3 chat sessions and cost $139+ in lessons.
3. **server/price-tracker.js** — Open/close price capture. Uses Chainlink for open prices (the resolution source), Coinbase for close prices. Window management is correct.

If a prompt would modify any of these files, REFUSE and explain why. The only exception is if Andi explicitly names the file and says to change it.

## Critical Rules — Never Break These
1. `ethers.js` v5 ONLY — never install v6
2. `axios` for all HTTP — never use `fetch`
3. `clobTokenIds` is a JSON string — always `JSON.parse()` before use
4. CLOB minimum: 5 shares per order
5. Tick size floor: $0.01
6. Pool balance = wallet USDC.e balance, synced every 60s via RPC
7. NEVER send on-chain tx (redeem/claim) without verifying oracle resolution via Data API first. Premature redeems permanently burn shares — this cost $139 on April 1, 2026.
8. No auto-claims on a timer — manual CLAIM ALL button only
9. Notifications are fire-and-forget — never let a notification failure crash the bot
10. No one-time migrations without guard flags
11. Claim lock: only one claim tx at a time (60s auto-release)
12. Delete `.env` before Zeabur upload — env vars set in Zeabur UI
13. Never include TELEGRAM_SESSION as env var
14. Open price comes from CHAINLINK, not Coinbase. This is non-negotiable.
15. Never DROP or DELETE FROM trades on startup
16. Never modify SACRED CODE files without explicit permission

## Chainlink Integration
Polymarket resolves 5M/15M Up/Down markets using Chainlink Data Streams. The bot reads Chainlink price feeds directly from Polygon on-chain contracts:

- BTC/USD: `0xc907E116054Ad103354f2D350FD2514433D57F6f`
- ETH/USD: `0xF9680D99D6C9589e2a93a78A04A279e509205945`
- SOL/USD: `0x10C8264C0935b3B9870013e057f330Ff3e9C56dC`
- XRP/USD: `0x785ba89291f676b5386652eB12b30cF361020694`

ABI: `['function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)']`
Answer divided by 1e8 = USD price.

**The edge:** Coinbase sees price moves 4-12 seconds before Chainlink updates. The bot uses Chainlink open + Coinbase current to detect when price has moved irreversibly — matching the exact resolution source Polymarket uses.

## Claimer System
- Uses Polymarket Data API as single source of truth
- Filters: `redeemable === true && curPrice === 1 && size > 0`
- Has hardcoded blacklist (CLAIMED_BLACKLIST Set) for ghost positions
- Has dynamic blacklist: if redeem succeeds but USDC.e balance doesn't change, conditionId is auto-blacklisted and persisted to settings DB
- Claim lock prevents concurrent redeems (60s auto-release)
- NEVER redeems before oracle resolution — the Data API gatekeeper ensures this

## Design System
- Background: `#0C0C0C`, Cards: `#0A0A0A` with `1px #1A1A1A` borders
- Green: `#00D341`, Red: `#FF3B3B`
- Font: JetBrains Mono
- Terminal aesthetic, minimal, no clutter
- Footer: "a year28 development"

## Wallet
- Address: `0x140311be486530231450118D417c6015FF7df491`
- Chain: Polygon (137)
- USDC.e: `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174`

## Env Vars
PORT=3000
PMB_PASSWORD=<set in Zeabur>
DATABASE_PATH=/app/data/pmb.db
POLYGON_PRIVATE_KEY=<set in Zeabur>
POLYGON_RPC_URL=https://polygon-bor-rpc.publicnode.com
POLYMARKET_CLOB_URL=https://clob.polymarket.com
CHAIN_ID=137
TELEGRAM_BOT_TOKEN=<optional>
TELEGRAM_CHAT_ID=<optional>

## Project Structure
year28polymarketbot/
├── CLAUDE.md
├── Dockerfile
├── docker-compose.yml
├── package.json
├── server/
│   ├── index.js              # Express server, API routes, main scalp loop, boot sequence
│   ├── config.js             # All constants, thresholds, env loading
│   ├── db.js                 # SQLite init, pool balance, trade CRUD, settings
│   ├── auth.js               # JWT login, middleware
│   ├── coinbase-ws.js        # Coinbase WebSocket (real-time BTC/ETH/SOL/XRP)
│   ├── chainlink.js          # [SACRED] Chainlink on-chain price feeds for open prices
│   ├── price-tracker.js      # [SACRED] Window/open price tracking via Chainlink
│   ├── market-discovery.js   # Gamma API market lookup, deterministic slug, cache
│   ├── superscalp.js         # Core engine: irrev calc, gate checks, midpoint entries
│   ├── spread-scalp.js       # Spread scalp path (last 60s, irrev >= 3.0)
│   ├── order-executor.js     # CLOB limit orders + FOK fallback, orderbook fetching
│   ├── resolver.js           # Window close detection, win/loss, auto-pause on 3 losses
│   ├── claimer.js            # [SACRED] Data API claiming, blacklist, redeem
│   ├── volatility.js         # Volatility tracking for irrev formula
│   ├── notifications.js      # Telegram fire-and-forget
│   └── recover.js            # Recovery utilities
├── dashboard/
│   ├── src/
│   │   ├── App.jsx           # Main app shell, login, dashboard layout
│   │   ├── components/       # Header, StatsRow, LanesGrid, TradesTable, LogsPanel, etc.
│   │   └── utils/api.js      # API client functions
│   └── dist/                 # Built dashboard (served by Express)
└── data/
└── pmb.db                # SQLite database (persistent volume on Zeabur)

## 8 Lanes
BTC-5M, BTC-15M, ETH-5M, ETH-15M, SOL-5M, SOL-15M, XRP-5M, XRP-15M

## SuperScalp Logic

### Two Entry Paths
1. **Midpoint path** (primary): Irrev passes threshold → entry at $0.20–$0.55 → limit order, FOK fallback
2. **Spread scalp path** (secondary): Last 60s of window → irrev >= 3.0 → buys at real ask → circuit breaker (3 losses/hr = 2hr pause)

### Stacking
- Max 3 entries per lane per window
- Escalating irrev thresholds: 1.9, 2.5, 3.5
- Each stack requires $0.02 better market price than previous

### Compounding Tiers
| Pool Balance | Allocation % |
|---|---|
| < $75 | 8% |
| $75–$150 | 10% |
| $150–$300 | 12% |
| $300+ | 15% |
- Irrev multiplier: 1.25x at >= 5.0, 1.5x at >= 10.0
- Max $20/trade, max $5 loss/trade, min 5 shares
- Pool floor: $10 minimum to trade

### Resolution
- Resolver compares Coinbase close price vs Chainlink open price
- If close price missing, trade stays pending (expires after 15 min)
- Auto-pause after 3 consecutive losses

### Claiming
- MANUAL ONLY — dashboard CLAIM ALL button
- Data API checks `redeemable === true && curPrice === 1` first
- If not redeemable: does nothing
- If redeemable: fires `redeemPositions()` on-chain
- Ghost positions filtered by blacklist (hardcoded + dynamic)

## Bug History — Lessons Learned
1. **Chainlink vs Coinbase mismatch (Chat 03):** Bot used Coinbase for open price, Polymarket uses Chainlink. 9 "wins" were actually losses. ~$40 lost. Fixed by reading Chainlink on-chain feeds.
2. **Auto-claim burn (old PMB bot):** Premature redeems before oracle resolution permanently burned $139 in shares. Current bot uses Data API as gatekeeper — never redeems without `redeemable === true`.
3. **Ghost positions (Chat 03):** 3 already-claimed positions kept showing as redeemable in Data API. Fixed with hardcoded blacklist + dynamic balance-change detection blacklist.
4. **DB wipe (Chat 02):** Persistent volume wasn't mounted. All trades lost on redeploy. Fixed by mounting /app/data on Zeabur.
5. **Claimer filters (Chat 02):** Added CLAIM_CUTOFF_DATE and DB matching that blocked ALL claims. Removed both. Claimer uses Data API only.
6. **Empty orderbooks (Chat 04):** Market makers pull asks in last 60-90s of windows with strong directional moves. Not a bug — market structure. Bot can only enter when liquidity exists.

## Working Model
- Andi never writes code
- Claude Chat = architect, writes plain-English prompts
- Claude Code = programmer, executes prompts
- Prompts are boxed for copy-paste
- No code snippets in prompts
- "PROMPT FOR ALL CHANGES" for batched prompts
- Deploy: delete .env, drag-and-drop to Zeabur, Docker provider
- Always check boot logs after deploy for confirmation