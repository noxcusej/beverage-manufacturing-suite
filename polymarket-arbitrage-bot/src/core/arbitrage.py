"""
Arbitrage detection engine for Polymarket binary markets.

In a binary market, YES + NO tokens always resolve to $1.00.
Arbitrage exists when:

  BUY BOTH: best_ask(YES) + best_ask(NO) < 1.00  (after fees)
    → Buy both sides, guaranteed $1.00 on resolution, profit = 1 - cost

  SELL BOTH: best_bid(YES) + best_bid(NO) > 1.00  (after fees)
    → Sell both sides, collect > $1.00, pay $1.00 on resolution

Fee formula from Polymarket docs:
  fee = base_fee_rate * min(price, 1 - price) * size

The engine scans all tracked markets and emits ArbitrageOpportunity
objects when spread exceeds the configured minimum.
"""

from __future__ import annotations

import time

import structlog

from src.core.config import Settings
from src.core.types import (
    ArbitrageOpportunity,
    BinaryMarket,
    OrderBookSnapshot,
)

log = structlog.get_logger("arbitrage")


class ArbitrageEngine:
    """Detects arbitrage opportunities across binary markets."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self._markets: dict[str, BinaryMarket] = {}  # condition_id → market
        self._token_to_market: dict[str, str] = {}    # token_id → condition_id

        # Tracking
        self.opportunities_found = 0
        self.scans_performed = 0

    # ------------------------------------------------------------------
    # Market registration
    # ------------------------------------------------------------------

    def register_market(self, market: BinaryMarket) -> None:
        """Register a market for arbitrage scanning."""
        self._markets[market.condition_id] = market
        self._token_to_market[market.yes_token_id] = market.condition_id
        self._token_to_market[market.no_token_id] = market.condition_id

    def register_markets(self, markets: list[BinaryMarket]) -> None:
        for m in markets:
            self.register_market(m)

    def get_market_for_token(self, token_id: str) -> BinaryMarket | None:
        cid = self._token_to_market.get(token_id)
        return self._markets.get(cid) if cid else None

    @property
    def tracked_markets(self) -> list[BinaryMarket]:
        return list(self._markets.values())

    @property
    def all_token_ids(self) -> list[str]:
        """All YES and NO token IDs for subscription."""
        ids: list[str] = []
        for m in self._markets.values():
            ids.extend([m.yes_token_id, m.no_token_id])
        return ids

    # ------------------------------------------------------------------
    # Book updates
    # ------------------------------------------------------------------

    def update_book(self, token_id: str, book: OrderBookSnapshot) -> None:
        """Update the orderbook snapshot for a token."""
        market = self.get_market_for_token(token_id)
        if not market:
            return

        if token_id == market.yes_token_id:
            market.yes_book = book
        elif token_id == market.no_token_id:
            market.no_book = book

    # ------------------------------------------------------------------
    # Fee calculation
    # ------------------------------------------------------------------

    def calculate_fee(self, price: float, size: float, is_taker: bool = True) -> float:
        """
        Calculate trading fee per Polymarket's formula:
          fee = base_fee_rate * min(price, 1 - price) * size

        Maker fee is typically 0; taker fee varies.
        """
        fee_rate = self.settings.taker_fee_rate if is_taker else self.settings.maker_fee_rate
        fee = fee_rate * min(price, 1.0 - price) * size
        # Round to nearest $0.001 (Polymarket minimum)
        return max(round(fee, 3), 0.001) if fee > 0 else 0.0

    def cost_with_fee(self, price: float, size: float, is_taker: bool = True) -> float:
        """Total cost to buy `size` shares at `price` including fees."""
        return price * size + self.calculate_fee(price, size, is_taker)

    def revenue_after_fee(self, price: float, size: float, is_taker: bool = True) -> float:
        """Revenue from selling `size` shares at `price` after fees."""
        return price * size - self.calculate_fee(price, size, is_taker)

    # ------------------------------------------------------------------
    # Arbitrage detection
    # ------------------------------------------------------------------

    def scan_market(self, market: BinaryMarket) -> ArbitrageOpportunity | None:
        """
        Check a single market for arbitrage.
        Returns an opportunity if spread after fees exceeds minimum threshold.
        """
        if not market.yes_book or not market.no_book:
            return None

        yes_book = market.yes_book
        no_book = market.no_book

        # --- BUY BOTH: buy YES at ask + buy NO at ask < $1.00 ---
        opp = self._check_buy_both(market, yes_book, no_book)
        if opp:
            return opp

        # --- SELL BOTH: sell YES at bid + sell NO at bid > $1.00 ---
        opp = self._check_sell_both(market, yes_book, no_book)
        if opp:
            return opp

        return None

    def _check_buy_both(
        self,
        market: BinaryMarket,
        yes_book: OrderBookSnapshot,
        no_book: OrderBookSnapshot,
    ) -> ArbitrageOpportunity | None:
        """Check if buying both YES and NO tokens costs < $1.00 after fees."""
        yes_ask = yes_book.best_ask
        no_ask = no_book.best_ask

        if yes_ask is None or no_ask is None:
            return None

        yes_ask_size = yes_book.best_ask_size or 0
        no_ask_size = no_book.best_ask_size or 0

        # Max size is the minimum available on both sides
        max_size = min(yes_ask_size, no_ask_size)
        if max_size <= 0:
            return None

        # Cap by configured max position
        max_size = min(max_size, self.settings.max_position_usdc / max(yes_ask + no_ask, 0.01))

        # Total cost to buy both sides (including taker fees)
        total_cost = (
            self.cost_with_fee(yes_ask, max_size, is_taker=True)
            + self.cost_with_fee(no_ask, max_size, is_taker=True)
        )

        # Revenue on resolution is always $1.00 per share
        revenue = max_size * 1.0

        profit = revenue - total_cost
        if profit <= 0:
            return None

        # Spread in basis points
        spread_bps = int((profit / revenue) * 10_000)

        if spread_bps < self.settings.min_spread_bps:
            return None

        self.opportunities_found += 1
        opp = ArbitrageOpportunity(
            market=market,
            yes_price=yes_ask,
            no_price=no_ask,
            spread_bps=spread_bps,
            max_size=max_size,
            direction="buy_both",
        )

        log.info(
            "arbitrage_detected",
            direction="buy_both",
            market=market.question[:60],
            yes_ask=yes_ask,
            no_ask=no_ask,
            spread_bps=spread_bps,
            max_size=round(max_size, 2),
            profit_per_unit=round(opp.expected_profit_per_unit, 4),
        )
        return opp

    def _check_sell_both(
        self,
        market: BinaryMarket,
        yes_book: OrderBookSnapshot,
        no_book: OrderBookSnapshot,
    ) -> ArbitrageOpportunity | None:
        """Check if selling both YES and NO tokens earns > $1.00 after fees."""
        yes_bid = yes_book.best_bid
        no_bid = no_book.best_bid

        if yes_bid is None or no_bid is None:
            return None

        yes_bid_size = yes_book.best_bid_size or 0
        no_bid_size = no_book.best_bid_size or 0

        max_size = min(yes_bid_size, no_bid_size)
        if max_size <= 0:
            return None

        max_size = min(max_size, self.settings.max_position_usdc / max(yes_bid + no_bid, 0.01))

        # Revenue from selling both sides (minus taker fees)
        total_revenue = (
            self.revenue_after_fee(yes_bid, max_size, is_taker=True)
            + self.revenue_after_fee(no_bid, max_size, is_taker=True)
        )

        # Cost to acquire both tokens (mint at $1.00 per pair)
        cost = max_size * 1.0

        profit = total_revenue - cost
        if profit <= 0:
            return None

        spread_bps = int((profit / cost) * 10_000)

        if spread_bps < self.settings.min_spread_bps:
            return None

        self.opportunities_found += 1
        opp = ArbitrageOpportunity(
            market=market,
            yes_price=yes_bid,
            no_price=no_bid,
            spread_bps=spread_bps,
            max_size=max_size,
            direction="sell_both",
        )

        log.info(
            "arbitrage_detected",
            direction="sell_both",
            market=market.question[:60],
            yes_bid=yes_bid,
            no_bid=no_bid,
            spread_bps=spread_bps,
            max_size=round(max_size, 2),
            profit_per_unit=round(opp.expected_profit_per_unit, 4),
        )
        return opp

    def scan_all(self) -> list[ArbitrageOpportunity]:
        """Scan all registered markets for arbitrage opportunities."""
        self.scans_performed += 1
        opportunities: list[ArbitrageOpportunity] = []

        for market in self._markets.values():
            if not market.active or market.closed:
                continue
            opp = self.scan_market(market)
            if opp:
                opportunities.append(opp)

        if opportunities:
            log.info(
                "scan_complete",
                markets_scanned=len(self._markets),
                opportunities=len(opportunities),
                best_spread_bps=max(o.spread_bps for o in opportunities),
            )

        return opportunities

    @property
    def stats(self) -> dict[str, int]:
        return {
            "tracked_markets": len(self._markets),
            "scans_performed": self.scans_performed,
            "opportunities_found": self.opportunities_found,
        }
