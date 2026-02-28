"""
Polymarket CLOB REST API client.

Wraps the py-clob-client SDK with helpers for market discovery,
orderbook fetching, fee queries, and order execution.
"""

from __future__ import annotations

import asyncio
from functools import partial
from typing import Any

import aiohttp
import structlog

from src.core.config import CLOB_API_BASE, GAMMA_API_BASE, Settings
from src.core.types import (
    BinaryMarket,
    OrderBookLevel,
    OrderBookSnapshot,
    Outcome,
)

log = structlog.get_logger("clob-api")


class ClobApiClient:
    """Async wrapper around Polymarket CLOB + Gamma REST APIs."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self._clob_base = CLOB_API_BASE
        self._gamma_base = GAMMA_API_BASE
        self._session: aiohttp.ClientSession | None = None
        self._sdk_client: Any = None  # py_clob_client.ClobClient (lazy)

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def start(self) -> None:
        self._session = aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=15),
            headers={"Accept": "application/json"},
        )
        log.info("clob_api_started", base=self._clob_base)

    async def stop(self) -> None:
        if self._session:
            await self._session.close()
            self._session = None

    def _get_sdk_client(self) -> Any:
        """Lazy-init the py-clob-client SDK for order signing/posting."""
        if self._sdk_client is not None:
            return self._sdk_client

        from py_clob_client.client import ClobClient
        from py_clob_client.clob_types import ApiCreds

        s = self.settings
        self._sdk_client = ClobClient(
            host=self._clob_base,
            key=s.private_key.get_secret_value(),
            chain_id=s.chain_id,
            signature_type=0,  # EOA
        )
        creds = ApiCreds(
            api_key=s.poly_api_key.get_secret_value(),
            api_secret=s.poly_api_secret.get_secret_value(),
            api_passphrase=s.poly_api_passphrase.get_secret_value(),
        )
        self._sdk_client.set_api_creds(creds)
        log.info("sdk_client_initialized")
        return self._sdk_client

    # ------------------------------------------------------------------
    # HTTP helpers
    # ------------------------------------------------------------------

    async def _get(self, base: str, path: str, params: dict | None = None) -> Any:
        assert self._session is not None, "Call start() first"
        url = f"{base}{path}"
        async with self._session.get(url, params=params) as resp:
            resp.raise_for_status()
            return await resp.json()

    # ------------------------------------------------------------------
    # Market discovery (Gamma API — unauthenticated)
    # ------------------------------------------------------------------

    async def get_markets(
        self,
        *,
        active: bool = True,
        closed: bool = False,
        limit: int = 100,
        offset: int = 0,
        liquidity_min: float | None = None,
    ) -> list[BinaryMarket]:
        """Fetch markets from the Gamma API."""
        params: dict[str, Any] = {
            "active": str(active).lower(),
            "closed": str(closed).lower(),
            "limit": limit,
            "offset": offset,
        }
        if liquidity_min is not None:
            params["liquidity_num_min"] = liquidity_min

        data = await self._get(self._gamma_base, "/markets", params)

        markets: list[BinaryMarket] = []
        for m in data:
            tokens = m.get("tokens", [])
            if len(tokens) != 2:
                continue  # skip non-binary markets

            yes_tok = next((t for t in tokens if t.get("outcome") == "Yes"), None)
            no_tok = next((t for t in tokens if t.get("outcome") == "No"), None)
            if not yes_tok or not no_tok:
                continue

            markets.append(BinaryMarket(
                condition_id=m.get("condition_id", ""),
                question=m.get("question", ""),
                slug=m.get("slug", ""),
                yes_token_id=yes_tok["token_id"],
                no_token_id=no_tok["token_id"],
                active=m.get("active", True),
                closed=m.get("closed", False),
            ))

        log.info("markets_fetched", count=len(markets))
        return markets

    # ------------------------------------------------------------------
    # Orderbook (CLOB API — unauthenticated)
    # ------------------------------------------------------------------

    async def get_orderbook(self, token_id: str) -> OrderBookSnapshot:
        """Fetch the full orderbook for a single token."""
        data = await self._get(self._clob_base, "/orderbook", {"token_id": token_id})

        bids = [
            OrderBookLevel(price=float(b["price"]), size=float(b["size"]))
            for b in data.get("bids", [])
        ]
        asks = [
            OrderBookLevel(price=float(a["price"]), size=float(a["size"]))
            for a in data.get("asks", [])
        ]

        # Sort: bids descending, asks ascending
        bids.sort(key=lambda x: x.price, reverse=True)
        asks.sort(key=lambda x: x.price)

        return OrderBookSnapshot(token_id=token_id, bids=bids, asks=asks)

    async def get_orderbooks(
        self, token_ids: list[str]
    ) -> dict[str, OrderBookSnapshot]:
        """Fetch orderbooks for multiple tokens concurrently."""
        tasks = [self.get_orderbook(tid) for tid in token_ids]
        results = await asyncio.gather(*tasks, return_exceptions=True)
        books: dict[str, OrderBookSnapshot] = {}
        for tid, result in zip(token_ids, results):
            if isinstance(result, Exception):
                log.warning("orderbook_fetch_failed", token_id=tid, error=str(result))
            else:
                books[tid] = result
        return books

    # ------------------------------------------------------------------
    # Price / Fee queries (CLOB API — unauthenticated)
    # ------------------------------------------------------------------

    async def get_midpoint(self, token_id: str) -> float | None:
        """Get mid-market price for a token."""
        data = await self._get(self._clob_base, "/midpoint", {"token_id": token_id})
        mid = data.get("mid")
        return float(mid) if mid is not None else None

    async def get_spread(self, token_id: str) -> dict[str, float | None]:
        """Get bid-ask spread for a token."""
        data = await self._get(self._clob_base, "/spread", {"token_id": token_id})
        return {
            "spread": float(data["spread"]) if data.get("spread") else None,
            "bid": float(data["bid"]) if data.get("bid") else None,
            "ask": float(data["ask"]) if data.get("ask") else None,
        }

    async def get_fee_rate(self, token_id: str) -> int:
        """Get fee rate in basis points for a token. Most markets are 0%."""
        data = await self._get(self._clob_base, "/feerate", {"token_id": token_id})
        return int(data.get("fee_rate_bps", 0))

    async def get_tick_size(self, token_id: str) -> str:
        """Get tick size for a token (e.g. '0.01'). Can change dynamically."""
        data = await self._get(self._clob_base, "/ticksize", {"token_id": token_id})
        return str(data.get("minimum_tick_size", "0.01"))

    async def get_neg_risk(self, token_id: str) -> bool:
        """Check if a token uses the neg-risk CTF exchange."""
        data = await self._get(self._clob_base, "/negrisk", {"token_id": token_id})
        return bool(data.get("neg_risk", False))

    # ------------------------------------------------------------------
    # Order execution (CLOB API — authenticated, via SDK)
    # ------------------------------------------------------------------

    async def place_limit_order(
        self,
        token_id: str,
        side: str,
        price: float,
        size: float,
        fee_rate_bps: int = 0,
        tick_size: str = "0.01",
        neg_risk: bool = False,
    ) -> dict[str, Any]:
        """Place a GTC limit order via the py-clob-client SDK."""
        from py_clob_client.clob_types import OrderArgs, OrderType
        from py_clob_client.order_builder.constants import BUY, SELL

        client = self._get_sdk_client()

        order_args = OrderArgs(
            token_id=token_id,
            price=price,
            size=size,
            side=BUY if side.upper() == "BUY" else SELL,
            fee_rate_bps=fee_rate_bps,
        )

        # Run blocking SDK calls in executor to avoid blocking the event loop
        loop = asyncio.get_running_loop()

        signed_order = await loop.run_in_executor(
            None,
            partial(
                client.create_order,
                order_args,
                options={"tick_size": tick_size, "neg_risk": neg_risk},
            ),
        )

        response = await loop.run_in_executor(
            None,
            partial(client.post_order, signed_order, order_type=OrderType.GTC),
        )

        log.info(
            "order_placed",
            token_id=token_id[:16],
            side=side,
            price=price,
            size=size,
            response=str(response)[:200],
        )
        return response if isinstance(response, dict) else {"raw": str(response)}

    async def place_market_order(
        self,
        token_id: str,
        side: str,
        amount_usdc: float,
        fee_rate_bps: int = 0,
    ) -> dict[str, Any]:
        """Place a FOK market order via the SDK."""
        from py_clob_client.clob_types import MarketOrderArgs, OrderType

        client = self._get_sdk_client()
        loop = asyncio.get_running_loop()

        market_args = MarketOrderArgs(
            token_id=token_id,
            amount=amount_usdc,
            side=side.upper(),
            fee_rate_bps=fee_rate_bps,
        )

        signed_order = await loop.run_in_executor(
            None, partial(client.create_market_order, market_args)
        )

        response = await loop.run_in_executor(
            None, partial(client.post_order, signed_order, order_type=OrderType.FOK)
        )

        log.info(
            "market_order_placed",
            token_id=token_id[:16],
            side=side,
            amount=amount_usdc,
        )
        return response if isinstance(response, dict) else {"raw": str(response)}

    async def cancel_order(self, order_id: str) -> bool:
        """Cancel a single order."""
        client = self._get_sdk_client()
        loop = asyncio.get_running_loop()
        try:
            await loop.run_in_executor(None, partial(client.cancel, order_id))
            log.info("order_cancelled", order_id=order_id)
            return True
        except Exception as e:
            log.error("cancel_failed", order_id=order_id, error=str(e))
            return False

    async def cancel_all_orders(self) -> bool:
        """Cancel all open orders."""
        client = self._get_sdk_client()
        loop = asyncio.get_running_loop()
        try:
            await loop.run_in_executor(None, client.cancel_all)
            log.info("all_orders_cancelled")
            return True
        except Exception as e:
            log.error("cancel_all_failed", error=str(e))
            return False

    async def send_heartbeat(self, heartbeat_id: str = "arb-bot") -> bool:
        """Send heartbeat to keep orders alive (<10s interval)."""
        client = self._get_sdk_client()
        loop = asyncio.get_running_loop()
        try:
            await loop.run_in_executor(
                None, partial(client.post_heartbeat, heartbeat_id=heartbeat_id)
            )
            return True
        except Exception:
            log.warning("heartbeat_failed")
            return False

    async def get_balance_allowance(self) -> dict[str, Any]:
        """Fetch USDC balance and allowance status."""
        client = self._get_sdk_client()
        loop = asyncio.get_running_loop()
        try:
            result = await loop.run_in_executor(None, client.get_balance_allowance)
            return result if isinstance(result, dict) else {"raw": str(result)}
        except Exception as e:
            log.error("balance_check_failed", error=str(e))
            return {"error": str(e)}
