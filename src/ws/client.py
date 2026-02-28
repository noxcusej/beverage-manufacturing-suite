"""
Real-time WebSocket client for Polymarket CLOB orderbook data.

Subscribes to the market channel for live orderbook updates,
trade events, and price changes. Implements automatic reconnection
with exponential backoff.

Endpoint: wss://ws-subscriptions-clob.polymarket.com/ws/market
Protocol: JSON messages over WebSocket
Keepalive: PING every 10 seconds (server drops idle connections)
Max instruments: 500 per connection
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Callable, Coroutine
from typing import Any

import structlog
import websockets
from websockets.asyncio.client import ClientConnection

from src.core.config import Settings
from src.core.types import OrderBookLevel, OrderBookSnapshot

log = structlog.get_logger("ws-client")

# Type alias for the callback that receives orderbook updates
BookUpdateCallback = Callable[[str, OrderBookSnapshot], Coroutine[Any, Any, None]]


class PolymarketWSClient:
    """
    WebSocket client that maintains live orderbook state for subscribed tokens.

    Usage:
        ws = PolymarketWSClient(settings)
        ws.on_book_update = my_callback
        await ws.start(token_ids=["abc...", "def..."])
        # ... later ...
        await ws.stop()
    """

    PING_INTERVAL = 10  # seconds
    MAX_INSTRUMENTS_PER_CONNECTION = 500

    def __init__(self, settings: Settings):
        self.settings = settings
        self._ws: ClientConnection | None = None
        self._running = False
        self._subscribed_tokens: list[str] = []
        self._reconnect_attempts = 0
        self._tasks: list[asyncio.Task[None]] = []

        # Live orderbook state — updated by incoming messages
        self.books: dict[str, OrderBookSnapshot] = {}

        # Callback fired on every book update
        self.on_book_update: BookUpdateCallback | None = None

        # Metrics
        self.messages_received = 0
        self.last_message_time: float = 0

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def start(self, token_ids: list[str]) -> None:
        """Connect and subscribe to orderbook updates for the given tokens."""
        if len(token_ids) > self.MAX_INSTRUMENTS_PER_CONNECTION:
            log.warning(
                "too_many_instruments",
                count=len(token_ids),
                max=self.MAX_INSTRUMENTS_PER_CONNECTION,
                hint="Splitting not implemented — only first 500 will get snapshots",
            )

        self._subscribed_tokens = token_ids[:self.MAX_INSTRUMENTS_PER_CONNECTION]
        self._running = True
        self._reconnect_attempts = 0

        self._tasks.append(asyncio.create_task(self._connection_loop()))
        log.info("ws_client_starting", tokens=len(self._subscribed_tokens))

    async def stop(self) -> None:
        """Gracefully disconnect."""
        self._running = False
        for task in self._tasks:
            task.cancel()
        self._tasks.clear()
        if self._ws:
            await self._ws.close()
            self._ws = None
        log.info("ws_client_stopped")

    async def subscribe_tokens(self, token_ids: list[str]) -> None:
        """Add tokens to the subscription (hot-add)."""
        new_tokens = [t for t in token_ids if t not in self._subscribed_tokens]
        if not new_tokens:
            return
        self._subscribed_tokens.extend(new_tokens)

        if self._ws:
            await self._send_subscription(new_tokens)
            log.info("tokens_added", count=len(new_tokens))

    @property
    def is_connected(self) -> bool:
        return self._ws is not None and self._running

    @property
    def stats(self) -> dict[str, Any]:
        return {
            "connected": self.is_connected,
            "subscribed_tokens": len(self._subscribed_tokens),
            "messages_received": self.messages_received,
            "books_tracked": len(self.books),
            "last_message_age_s": (
                round(time.time() - self.last_message_time, 1)
                if self.last_message_time
                else None
            ),
            "reconnect_attempts": self._reconnect_attempts,
        }

    # ------------------------------------------------------------------
    # Connection management
    # ------------------------------------------------------------------

    async def _connection_loop(self) -> None:
        """Main loop: connect, subscribe, read messages, reconnect on failure."""
        while self._running:
            try:
                await self._connect_and_listen()
            except (
                websockets.exceptions.ConnectionClosed,
                websockets.exceptions.ConnectionClosedError,
                ConnectionError,
                OSError,
            ) as e:
                if not self._running:
                    break
                self._reconnect_attempts += 1
                if self._reconnect_attempts > self.settings.ws_max_reconnect_attempts:
                    log.error("ws_max_reconnects_exceeded", attempts=self._reconnect_attempts)
                    self._running = False
                    break

                backoff = min(2 ** self._reconnect_attempts, 60)
                log.warning(
                    "ws_reconnecting",
                    attempt=self._reconnect_attempts,
                    backoff_s=backoff,
                    error=str(e),
                )
                await asyncio.sleep(backoff)
            except asyncio.CancelledError:
                break
            except Exception as e:
                log.error("ws_unexpected_error", error=str(e), type=type(e).__name__)
                if self._running:
                    await asyncio.sleep(5)

    async def _connect_and_listen(self) -> None:
        """Single connection lifecycle."""
        endpoint = self.settings.ws_endpoint
        log.info("ws_connecting", endpoint=endpoint)

        async with websockets.connect(
            endpoint,
            ping_interval=None,  # We handle pings ourselves
            close_timeout=5,
            max_size=10 * 1024 * 1024,  # 10 MB
        ) as ws:
            self._ws = ws
            self._reconnect_attempts = 0
            log.info("ws_connected")

            # Subscribe immediately — server drops idle connections
            await self._send_subscription(self._subscribed_tokens)

            # Start ping task
            ping_task = asyncio.create_task(self._ping_loop())

            try:
                async for raw_msg in ws:
                    self.messages_received += 1
                    self.last_message_time = time.time()
                    await self._handle_message(raw_msg)
            finally:
                ping_task.cancel()
                self._ws = None

    async def _send_subscription(self, token_ids: list[str]) -> None:
        """Send subscription message for the market channel."""
        if not self._ws or not token_ids:
            return

        msg = json.dumps({
            "assets_ids": token_ids,
            "type": "market",
        })
        await self._ws.send(msg)
        log.debug("ws_subscribed", tokens=len(token_ids))

    async def _ping_loop(self) -> None:
        """Send periodic pings to keep the connection alive."""
        try:
            while self._running and self._ws:
                await asyncio.sleep(self.PING_INTERVAL)
                if self._ws:
                    try:
                        pong = await self._ws.ping()
                        await asyncio.wait_for(pong, timeout=5)
                    except Exception:
                        log.debug("ping_failed")
        except asyncio.CancelledError:
            pass

    # ------------------------------------------------------------------
    # Message handling
    # ------------------------------------------------------------------

    async def _handle_message(self, raw: str | bytes) -> None:
        """Parse and route incoming WebSocket messages."""
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            log.warning("ws_invalid_json", data=str(raw)[:100])
            return

        # The market channel sends a list of events
        events = data if isinstance(data, list) else [data]

        for event in events:
            event_type = event.get("event_type", "")

            if event_type == "book":
                await self._handle_book_event(event)
            elif event_type == "price_change":
                await self._handle_price_change(event)
            elif event_type == "last_trade_price":
                self._handle_trade_event(event)
            elif event_type == "tick_size_change":
                log.debug("tick_size_change", data=event)
            else:
                log.debug("ws_unknown_event", event_type=event_type)

    async def _handle_book_event(self, event: dict[str, Any]) -> None:
        """Process an orderbook update (full or incremental)."""
        asset_id = event.get("asset_id", "")
        if not asset_id:
            return

        bids_raw = event.get("bids", [])
        asks_raw = event.get("asks", [])

        bids = [
            OrderBookLevel(price=float(b["price"]), size=float(b["size"]))
            for b in bids_raw
            if float(b.get("size", 0)) > 0
        ]
        asks = [
            OrderBookLevel(price=float(a["price"]), size=float(a["size"]))
            for a in asks_raw
            if float(a.get("size", 0)) > 0
        ]

        bids.sort(key=lambda x: x.price, reverse=True)
        asks.sort(key=lambda x: x.price)

        snapshot = OrderBookSnapshot(
            token_id=asset_id,
            bids=bids,
            asks=asks,
        )

        self.books[asset_id] = snapshot

        if self.on_book_update:
            try:
                await self.on_book_update(asset_id, snapshot)
            except Exception as e:
                log.error("book_callback_error", error=str(e))

    async def _handle_price_change(self, event: dict[str, Any]) -> None:
        """Handle incremental price change events by updating the book."""
        asset_id = event.get("asset_id", "")
        if not asset_id or asset_id not in self.books:
            return

        # Price change events contain updated bids/asks — merge into existing book
        existing = self.books[asset_id]

        for change in event.get("changes", []):
            side = change.get("side", "")
            price = float(change.get("price", 0))
            size = float(change.get("size", 0))

            levels = existing.bids if side == "BUY" else existing.asks

            # Remove existing level at this price
            levels[:] = [lv for lv in levels if abs(lv.price - price) > 1e-9]

            # Add new level if size > 0
            if size > 0:
                levels.append(OrderBookLevel(price=price, size=size))

        # Re-sort
        existing.bids.sort(key=lambda x: x.price, reverse=True)
        existing.asks.sort(key=lambda x: x.price)
        existing.timestamp = time.time()

        if self.on_book_update:
            try:
                await self.on_book_update(asset_id, existing)
            except Exception as e:
                log.error("price_change_callback_error", error=str(e))

    def _handle_trade_event(self, event: dict[str, Any]) -> None:
        """Log trade events (used for monitoring, not direct arb logic)."""
        log.debug(
            "trade",
            asset=event.get("asset_id", "")[:16],
            price=event.get("price"),
            size=event.get("size"),
            side=event.get("side"),
        )
