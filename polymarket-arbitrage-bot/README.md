# Polymarket Arbitrage Bot

Real-time arbitrage bot for Polymarket's CLOB (Central Limit Order Book) binary prediction markets. Detects mispricing between YES and NO outcome tokens via WebSocket feeds and executes trades when the spread after fees exceeds a configurable threshold.

## How Arbitrage Works

In a binary market, YES + NO tokens always resolve to **$1.00**. If you can:

- **Buy both** YES and NO for less than $1.00 total → guaranteed profit on resolution
- **Sell both** YES and NO for more than $1.00 total → guaranteed profit after minting

This bot monitors orderbooks in real-time via WebSocket and acts on these opportunities.

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│  Gamma API  │────▶│  Market      │────▶│  WebSocket      │
│  (discover) │     │  Registry    │     │  Client         │
└─────────────┘     └──────────────┘     │  (real-time     │
                                         │   orderbooks)   │
                                         └────────┬────────┘
                                                  │
                                         ┌────────▼────────┐
                                         │  Arbitrage      │
                                         │  Engine         │
                                         │  (detect spread │
                                         │   after fees)   │
                                         └────────┬────────┘
                                                  │
                                         ┌────────▼────────┐
                                         │  Trade          │
                                         │  Executor       │
                                         │  (paper / live) │
                                         └─────────────────┘
```

## Quick Start

### 1. Install

```bash
cd polymarket-arbitrage-bot
python -m venv venv
source venv/bin/activate
pip install -e ".[dev]"
```

### 2. Configure

```bash
cp .env.example .env
# Edit .env with your settings
```

### 3. Run (Paper Mode)

```bash
# Paper trading — no real money, simulated execution
arb-bot run --mode paper

# With debug logging
arb-bot run --mode paper --log-level DEBUG

# Custom spread threshold (basis points)
arb-bot run --mode paper --min-spread 100
```

### 4. Pre-flight Check

```bash
arb-bot check
```

### 5. Show Config

```bash
arb-bot config
```

## Live Trading

```bash
# Requires API credentials in .env
arb-bot run --mode live
```

**Required `.env` variables for live mode:**
- `POLY_API_KEY` — from Polymarket Settings > API Keys
- `POLY_API_SECRET`
- `POLY_API_PASSPHRASE`
- `PRIVATE_KEY` — wallet private key (use a dedicated wallet)

## Configuration Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `TRADING_MODE` | `paper` | `paper` or `live` |
| `MIN_SPREAD_BPS` | `50` | Min spread after fees (basis points, 100=1%) |
| `MAX_POSITION_USDC` | `50.0` | Max USDC per single trade |
| `MAX_TOTAL_EXPOSURE_USDC` | `500.0` | Max total open exposure |
| `MAX_OPEN_POSITIONS` | `10` | Max concurrent positions |
| `TAKER_FEE_BPS` | `150` | Taker fee rate (basis points) |
| `STOP_LOSS_USDC` | `100.0` | Halt trading if PnL drops below this |
| `TRADE_COOLDOWN_SECONDS` | `30` | Cooldown per market between trades |
| `MAX_SLIPPAGE_BPS` | `100` | Max acceptable slippage |
| `TAILSCALE_ENABLED` | `false` | Route through Tailscale VPN |
| `TAILSCALE_EXIT_NODE` | _(empty)_ | Tailscale exit node hostname |

## Fee Model

Polymarket fees follow: `fee = base_rate × min(price, 1-price) × size`

- **Maker fee:** 0% (orders resting on the book)
- **Taker fee:** ~1-2% base rate (consuming liquidity)
- Fees are symmetric: buying at $0.80 costs the same fee as buying at $0.20

## Safety Controls

- **Circuit breaker** — halts all trading if PnL drops below stop-loss
- **Position limits** — configurable max positions and total exposure
- **Per-market cooldown** — prevents overtrading the same market
- **Slippage protection** — rejects trades exceeding slippage tolerance
- **Live mode confirmation** — requires interactive confirmation before live trading
- **Heartbeat** — automatic heartbeat to prevent order auto-cancellation

## Tailscale VPN

Route bot traffic through a Tailscale exit node:

```bash
# In .env
TAILSCALE_ENABLED=true
TAILSCALE_EXIT_NODE=us-east-1

# Or via CLI
arb-bot run --tailscale --mode paper
```

Requires the `tailscale` CLI to be installed and the daemon running.

## Project Structure

```
polymarket-arbitrage-bot/
├── src/
│   ├── cli.py              # CLI entry point (click)
│   ├── bot.py              # Main orchestrator
│   ├── core/
│   │   ├── config.py       # Settings (pydantic-settings)
│   │   ├── types.py        # Domain types
│   │   ├── clob_api.py     # REST API client (py-clob-client)
│   │   └── arbitrage.py    # Arbitrage detection engine
│   ├── ws/
│   │   └── client.py       # WebSocket client (real-time books)
│   ├── trading/
│   │   └── executor.py     # Trade execution (paper + live)
│   └── utils/
│       ├── logging.py      # Structured logging (structlog + rich)
│       └── tailscale.py    # Tailscale VPN management
├── tests/
│   ├── test_arbitrage.py   # Arb engine + fee tests
│   └── test_executor.py    # Paper trading tests
├── config/
├── .env.example
├── .gitignore
└── pyproject.toml
```

## Running Tests

```bash
pytest -v
```

## API Reference

This bot uses three Polymarket API layers:

| API | Base URL | Auth | Purpose |
|-----|----------|------|---------|
| **Gamma** | `https://gamma-api.polymarket.com` | None | Market discovery |
| **CLOB** | `https://clob.polymarket.com` | L0/L2 | Orderbook, orders, fees |
| **WebSocket** | `wss://ws-subscriptions-clob.polymarket.com/ws/market` | None | Real-time book updates |
