"""
Main bot orchestrator — ties together all components:
  1. Tailscale VPN setup
  2. Market discovery via Gamma API
  3. WebSocket subscription for real-time orderbooks
  4. Arbitrage detection on every book update
  5. Trade execution (paper or live)
  6. Heartbeat loop for live trading
  7. Periodic stats reporting
"""

from __future__ import annotations

import asyncio
import signal
import time

import structlog

from src.core.arbitrage import ArbitrageEngine
from src.core.clob_api import ClobApiClient
from src.core.config import Settings, TradingMode
from src.core.types import BinaryMarket, OrderBookSnapshot
from src.dashboard.server import DashboardServer
from src.trading.executor import TradeExecutor
from src.utils.tailscale import TailscaleManager
from src.ws.client import PolymarketWSClient

log = structlog.get_logger("bot")


class ArbitrageBot:
    """
    Top-level bot that coordinates all subsystems.

    Lifecycle:
        bot = ArbitrageBot(settings)
        await bot.run()    # blocks until shutdown signal
    """

    # How often to log stats (seconds)
    STATS_INTERVAL = 60
    # How often to send heartbeats in live mode (seconds)
    HEARTBEAT_INTERVAL = 8
    # How often to refresh the market list (seconds)
    MARKET_REFRESH_INTERVAL = 300

    def __init__(self, settings: Settings, dashboard_port: int = 8899):
        self.settings = settings
        self.api = ClobApiClient(settings)
        self.arb_engine = ArbitrageEngine(settings)
        self.executor = TradeExecutor(settings, self.api, self.arb_engine)
        self.ws_client = PolymarketWSClient(settings)
        self.tailscale = TailscaleManager(
            exit_node=settings.tailscale_exit_node,
            enabled=settings.tailscale_enabled,
        )
        self.dashboard = DashboardServer(self, port=dashboard_port)

        self._running = False
        self._start_time: float = 0
        self._tasks: list[asyncio.Task[None]] = []

    # ------------------------------------------------------------------
    # Main entry point
    # ------------------------------------------------------------------

    async def run(self) -> None:
        """Start the bot and run until interrupted."""
        self._start_time = time.time()
        self._running = True

        # Register signal handlers for graceful shutdown
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, lambda: asyncio.create_task(self.shutdown()))

        log.info(
            "bot_starting",
            mode=self.settings.trading_mode.value,
            min_spread_bps=self.settings.min_spread_bps,
            max_position=self.settings.max_position_usdc,
        )

        try:
            # --- Phase 0: Start dashboard ---
            await self.dashboard.start()

            # --- Phase 1: Pre-flight checks ---
            await self._preflight()

            # --- Phase 2: Market discovery ---
            markets = await self._discover_markets()
            if not markets:
                log.error("no_markets_found")
                return

            # --- Phase 3: WebSocket subscription ---
            self.ws_client.on_book_update = self._on_book_update
            token_ids = self.arb_engine.all_token_ids
            await self.ws_client.start(token_ids)

            # --- Phase 4: Background tasks ---
            self._tasks.append(asyncio.create_task(self._stats_loop()))

            if not self.settings.is_paper:
                self._tasks.append(asyncio.create_task(self._heartbeat_loop()))

            self._tasks.append(asyncio.create_task(self._market_refresh_loop()))

            log.info(
                "bot_running",
                markets=len(markets),
                tokens=len(token_ids),
                ws_endpoint=self.settings.ws_endpoint,
            )

            # Block until shutdown
            while self._running:
                await asyncio.sleep(1)

        except Exception as e:
            log.error("bot_fatal_error", error=str(e), type=type(e).__name__)
            raise
        finally:
            await self._cleanup()

    async def shutdown(self) -> None:
        """Graceful shutdown."""
        if not self._running:
            return
        log.info("bot_shutting_down")
        self._running = False

    # ------------------------------------------------------------------
    # Pre-flight
    # ------------------------------------------------------------------

    async def _preflight(self) -> None:
        """Run all pre-flight checks before trading."""
        # Tailscale VPN
        if self.settings.tailscale_enabled:
            ok = await self.tailscale.setup()
            if not ok:
                raise RuntimeError("Tailscale VPN setup failed")

        # Credential validation for live mode
        if self.settings.trading_mode == TradingMode.LIVE:
            missing = self.settings.validate_live_credentials()
            if missing:
                raise RuntimeError(
                    f"Live trading requires credentials: {', '.join(missing)}. "
                    "Set them in .env or switch to TRADING_MODE=paper"
                )

        # Start API client
        await self.api.start()

        # Load paper state if applicable
        if self.settings.is_paper:
            self.executor.load_paper_state()

        log.info("preflight_complete")

    # ------------------------------------------------------------------
    # Market discovery
    # ------------------------------------------------------------------

    async def _discover_markets(self) -> list[BinaryMarket]:
        """Fetch active binary markets and register them."""
        log.info("discovering_markets")

        try:
            markets = await self.api.get_markets(
                active=True,
                closed=False,
                limit=100,
                liquidity_min=1000,  # Only markets with meaningful liquidity
            )
        except Exception as e:
            log.error("market_discovery_failed", error=str(e))
            return []

        # Register with the arbitrage engine
        self.arb_engine.register_markets(markets)

        log.info(
            "markets_registered",
            count=len(markets),
            sample=[m.question[:50] for m in markets[:3]],
        )
        return markets

    # ------------------------------------------------------------------
    # Real-time callbacks
    # ------------------------------------------------------------------

    async def _on_book_update(self, token_id: str, book: OrderBookSnapshot) -> None:
        """
        Called on every WebSocket orderbook update.
        Updates the arb engine and checks for opportunities.
        """
        # Update the engine's book state
        self.arb_engine.update_book(token_id, book)

        # Find the market this token belongs to
        market = self.arb_engine.get_market_for_token(token_id)
        if not market:
            return

        # Only scan when we have both sides of the book
        if market.yes_book is None or market.no_book is None:
            return

        # Check for arbitrage on this specific market
        opportunity = self.arb_engine.scan_market(market)
        if opportunity:
            await self.executor.execute_opportunity(opportunity)

    # ------------------------------------------------------------------
    # Background tasks
    # ------------------------------------------------------------------

    async def _heartbeat_loop(self) -> None:
        """Send heartbeats to keep live orders alive."""
        try:
            while self._running:
                await asyncio.sleep(self.HEARTBEAT_INTERVAL)
                if self._running:
                    await self.api.send_heartbeat()
        except asyncio.CancelledError:
            pass

    async def _stats_loop(self) -> None:
        """Periodically log bot statistics."""
        try:
            while self._running:
                await asyncio.sleep(self.STATS_INTERVAL)
                if self._running:
                    uptime = round(time.time() - self._start_time)
                    log.info(
                        "bot_stats",
                        uptime_s=uptime,
                        ws=self.ws_client.stats,
                        arb=self.arb_engine.stats,
                        executor=self.executor.stats,
                    )
        except asyncio.CancelledError:
            pass

    async def _market_refresh_loop(self) -> None:
        """Periodically refresh the market list to pick up new markets."""
        try:
            while self._running:
                await asyncio.sleep(self.MARKET_REFRESH_INTERVAL)
                if self._running:
                    new_markets = await self._discover_markets()
                    if new_markets:
                        # Subscribe to any new tokens
                        new_token_ids = [
                            tid
                            for tid in self.arb_engine.all_token_ids
                            if tid not in self.ws_client._subscribed_tokens
                        ]
                        if new_token_ids:
                            await self.ws_client.subscribe_tokens(new_token_ids)
                            log.info("new_tokens_subscribed", count=len(new_token_ids))
        except asyncio.CancelledError:
            pass

    # ------------------------------------------------------------------
    # Cleanup
    # ------------------------------------------------------------------

    async def _cleanup(self) -> None:
        """Clean up all resources."""
        log.info("cleaning_up")

        # Cancel background tasks
        for task in self._tasks:
            task.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks.clear()

        # Stop WebSocket
        await self.ws_client.stop()

        # Cancel all live orders
        if not self.settings.is_paper:
            try:
                await self.api.cancel_all_orders()
            except Exception as e:
                log.warning("cancel_orders_on_shutdown_failed", error=str(e))

        # Stop API client
        await self.api.stop()

        # Stop dashboard
        await self.dashboard.stop()

        # Restore Tailscale
        await self.tailscale.teardown()

        # Final stats
        log.info(
            "bot_stopped",
            uptime_s=round(time.time() - self._start_time),
            total_trades=self.executor.portfolio.trades_executed,
            total_pnl=round(self.executor.portfolio.total_pnl_usdc, 4),
        )
