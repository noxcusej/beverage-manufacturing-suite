"""
Dashboard HTTP + WebSocket server.

Runs alongside the bot on a configurable port and serves:
  - GET /              → dashboard HTML UI
  - GET /api/status    → full bot state snapshot (JSON)
  - GET /api/markets   → tracked markets with orderbook summaries
  - GET /api/trades    → trade history
  - GET /api/config    → current configuration
  - POST /api/config   → update runtime configuration
  - POST /api/control  → bot control actions (pause, resume, reset halt)
  - WS  /ws            → real-time push of state updates
"""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any

import structlog
from aiohttp import web, WSMsgType

if TYPE_CHECKING:
    from src.bot import ArbitrageBot

log = structlog.get_logger("dashboard")

STATIC_DIR = Path(__file__).parent / "static"


class DashboardServer:
    """Lightweight aiohttp server exposing bot state to the web UI."""

    def __init__(self, bot: ArbitrageBot, host: str = "0.0.0.0", port: int = 8899):
        self.bot = bot
        self.host = host
        self.port = port
        self._app = web.Application()
        self._runner: web.AppRunner | None = None
        self._ws_clients: list[web.WebSocketResponse] = []
        self._push_task: asyncio.Task[None] | None = None

        self._setup_routes()

    def _setup_routes(self) -> None:
        self._app.router.add_get("/", self._handle_index)
        self._app.router.add_get("/api/status", self._handle_status)
        self._app.router.add_get("/api/markets", self._handle_markets)
        self._app.router.add_get("/api/trades", self._handle_trades)
        self._app.router.add_get("/api/config", self._handle_get_config)
        self._app.router.add_post("/api/config", self._handle_set_config)
        self._app.router.add_post("/api/control", self._handle_control)
        self._app.router.add_get("/ws", self._handle_ws)

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def start(self) -> None:
        self._runner = web.AppRunner(self._app)
        await self._runner.setup()
        site = web.TCPSite(self._runner, self.host, self.port)
        await site.start()
        self._push_task = asyncio.create_task(self._push_loop())
        log.info("dashboard_started", url=f"http://localhost:{self.port}")

    async def stop(self) -> None:
        if self._push_task:
            self._push_task.cancel()
        for ws in self._ws_clients:
            await ws.close()
        self._ws_clients.clear()
        if self._runner:
            await self._runner.cleanup()
        log.info("dashboard_stopped")

    # ------------------------------------------------------------------
    # State snapshot helpers
    # ------------------------------------------------------------------

    def _build_status(self) -> dict[str, Any]:
        bot = self.bot
        uptime = round(time.time() - bot._start_time) if bot._start_time else 0

        return {
            "running": bot._running,
            "uptime_s": uptime,
            "mode": bot.settings.trading_mode.value,
            "ws": bot.ws_client.stats,
            "arb": bot.arb_engine.stats,
            "executor": bot.executor.stats,
            "timestamp": time.time(),
        }

    def _build_markets(self) -> list[dict[str, Any]]:
        markets = []
        for m in self.bot.arb_engine.tracked_markets:
            entry: dict[str, Any] = {
                "condition_id": m.condition_id,
                "question": m.question,
                "slug": m.slug,
                "active": m.active,
                "closed": m.closed,
            }

            if m.yes_book:
                entry["yes_best_bid"] = m.yes_book.best_bid
                entry["yes_best_ask"] = m.yes_book.best_ask
                entry["yes_bid_depth"] = sum(lv.size for lv in m.yes_book.bids)
                entry["yes_ask_depth"] = sum(lv.size for lv in m.yes_book.asks)
            else:
                entry["yes_best_bid"] = None
                entry["yes_best_ask"] = None

            if m.no_book:
                entry["no_best_bid"] = m.no_book.best_bid
                entry["no_best_ask"] = m.no_book.best_ask
                entry["no_bid_depth"] = sum(lv.size for lv in m.no_book.bids)
                entry["no_ask_depth"] = sum(lv.size for lv in m.no_book.asks)
            else:
                entry["no_best_bid"] = None
                entry["no_best_ask"] = None

            # Implied probability sum and spread
            yes_ask = entry.get("yes_best_ask")
            no_ask = entry.get("no_best_ask")
            if yes_ask is not None and no_ask is not None:
                entry["ask_sum"] = round(yes_ask + no_ask, 4)
                entry["buy_spread_bps"] = round((1.0 - yes_ask - no_ask) * 10000)
            else:
                entry["ask_sum"] = None
                entry["buy_spread_bps"] = None

            yes_bid = entry.get("yes_best_bid")
            no_bid = entry.get("no_best_bid")
            if yes_bid is not None and no_bid is not None:
                entry["bid_sum"] = round(yes_bid + no_bid, 4)
                entry["sell_spread_bps"] = round((yes_bid + no_bid - 1.0) * 10000)
            else:
                entry["bid_sum"] = None
                entry["sell_spread_bps"] = None

            markets.append(entry)

        # Sort by best spread opportunity
        markets.sort(
            key=lambda x: max(x.get("buy_spread_bps") or -9999, x.get("sell_spread_bps") or -9999),
            reverse=True,
        )
        return markets

    def _build_trades(self) -> list[dict[str, Any]]:
        return [
            {
                "id": t.trade_id,
                "market": t.market_condition_id[:16] + "...",
                "token_id": t.token_id[:16] + "...",
                "side": t.side.value,
                "outcome": t.outcome.value,
                "price": t.price,
                "size": round(t.size, 2),
                "fee": round(t.fee, 4),
                "total_cost": round(t.total_cost, 4),
                "status": t.status.value,
                "is_paper": t.is_paper,
                "timestamp": t.timestamp,
                "order_id": t.order_id[:16] + "..." if t.order_id else "",
                "error": t.error,
            }
            for t in reversed(self.bot.executor.trades[-100:])
        ]

    def _build_config(self) -> dict[str, Any]:
        s = self.bot.settings
        return {
            "trading_mode": s.trading_mode.value,
            "min_spread_bps": s.min_spread_bps,
            "max_position_usdc": s.max_position_usdc,
            "max_total_exposure_usdc": s.max_total_exposure_usdc,
            "max_open_positions": s.max_open_positions,
            "taker_fee_bps": s.taker_fee_bps,
            "maker_fee_bps": s.maker_fee_bps,
            "stop_loss_usdc": s.stop_loss_usdc,
            "max_slippage_bps": s.max_slippage_bps,
            "trade_cooldown_seconds": s.trade_cooldown_seconds,
            "tailscale_enabled": s.tailscale_enabled,
            "tailscale_exit_node": s.tailscale_exit_node,
        }

    # ------------------------------------------------------------------
    # HTTP handlers
    # ------------------------------------------------------------------

    async def _handle_index(self, request: web.Request) -> web.Response:
        html_path = STATIC_DIR / "index.html"
        return web.Response(
            text=html_path.read_text(),
            content_type="text/html",
        )

    async def _handle_status(self, request: web.Request) -> web.Response:
        return web.json_response(self._build_status())

    async def _handle_markets(self, request: web.Request) -> web.Response:
        return web.json_response(self._build_markets())

    async def _handle_trades(self, request: web.Request) -> web.Response:
        return web.json_response(self._build_trades())

    async def _handle_get_config(self, request: web.Request) -> web.Response:
        return web.json_response(self._build_config())

    async def _handle_set_config(self, request: web.Request) -> web.Response:
        """Hot-update runtime configuration values."""
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "Invalid JSON"}, status=400)

        s = self.bot.settings
        updated: list[str] = []

        safe_int_fields = {
            "min_spread_bps": ("min_spread_bps", 1, 10000),
            "max_open_positions": ("max_open_positions", 1, 100),
            "taker_fee_bps": ("taker_fee_bps", 0, 5000),
            "trade_cooldown_seconds": ("trade_cooldown_seconds", 0, 3600),
            "max_slippage_bps": ("max_slippage_bps", 0, 5000),
        }
        safe_float_fields = {
            "max_position_usdc": ("max_position_usdc", 1.0, 100000.0),
            "max_total_exposure_usdc": ("max_total_exposure_usdc", 1.0, 1000000.0),
            "stop_loss_usdc": ("stop_loss_usdc", 1.0, 1000000.0),
        }

        for key, (attr, lo, hi) in safe_int_fields.items():
            if key in body:
                val = int(body[key])
                if lo <= val <= hi:
                    setattr(s, attr, val)
                    updated.append(key)

        for key, (attr, lo, hi) in safe_float_fields.items():
            if key in body:
                val = float(body[key])
                if lo <= val <= hi:
                    setattr(s, attr, val)
                    updated.append(key)

        log.info("config_updated_via_dashboard", fields=updated)
        return web.json_response({"updated": updated, "config": self._build_config()})

    async def _handle_control(self, request: web.Request) -> web.Response:
        """Bot control actions."""
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "Invalid JSON"}, status=400)

        action = body.get("action", "")

        if action == "reset_halt":
            self.bot.executor.reset_halt()
            return web.json_response({"result": "Circuit breaker reset"})
        elif action == "cancel_all":
            if not self.bot.settings.is_paper:
                await self.bot.api.cancel_all_orders()
            return web.json_response({"result": "All orders cancelled"})
        elif action == "shutdown":
            await self.bot.shutdown()
            return web.json_response({"result": "Shutdown initiated"})
        else:
            return web.json_response({"error": f"Unknown action: {action}"}, status=400)

    # ------------------------------------------------------------------
    # WebSocket handler — pushes state to connected browsers
    # ------------------------------------------------------------------

    async def _handle_ws(self, request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        self._ws_clients.append(ws)
        log.debug("ws_dashboard_client_connected", clients=len(self._ws_clients))

        try:
            # Send initial state
            await ws.send_json({
                "type": "init",
                "status": self._build_status(),
                "markets": self._build_markets(),
                "trades": self._build_trades(),
                "config": self._build_config(),
            })

            async for msg in ws:
                if msg.type == WSMsgType.TEXT:
                    # Client can request specific data
                    try:
                        req = json.loads(msg.data)
                        req_type = req.get("type", "")
                        if req_type == "get_markets":
                            await ws.send_json({"type": "markets", "data": self._build_markets()})
                        elif req_type == "get_status":
                            await ws.send_json({"type": "status", "data": self._build_status()})
                    except json.JSONDecodeError:
                        pass
                elif msg.type in (WSMsgType.ERROR, WSMsgType.CLOSE):
                    break
        finally:
            self._ws_clients.remove(ws)
            log.debug("ws_dashboard_client_disconnected", clients=len(self._ws_clients))

        return ws

    async def _push_loop(self) -> None:
        """Push state to all connected WebSocket clients every second."""
        try:
            while True:
                await asyncio.sleep(1)
                if not self._ws_clients:
                    continue

                payload = json.dumps({
                    "type": "update",
                    "status": self._build_status(),
                    "markets": self._build_markets()[:20],  # Top 20 by spread
                    "trades": self._build_trades()[:10],     # Last 10 trades
                })

                dead: list[web.WebSocketResponse] = []
                for ws in self._ws_clients:
                    try:
                        await ws.send_str(payload)
                    except Exception:
                        dead.append(ws)

                for ws in dead:
                    self._ws_clients.remove(ws)
        except asyncio.CancelledError:
            pass
