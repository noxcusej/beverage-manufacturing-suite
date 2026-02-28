"""
Domain types for the arbitrage bot.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum


class Side(str, Enum):
    BUY = "BUY"
    SELL = "SELL"


class Outcome(str, Enum):
    YES = "YES"
    NO = "NO"


class OrderStatus(str, Enum):
    PENDING = "PENDING"
    LIVE = "LIVE"
    FILLED = "FILLED"
    PARTIALLY_FILLED = "PARTIALLY_FILLED"
    CANCELLED = "CANCELLED"
    FAILED = "FAILED"


@dataclass(frozen=True)
class MarketToken:
    """A single outcome token for a binary market."""
    token_id: str
    outcome: Outcome
    price: float  # 0.0 – 1.0 (in USDC)


@dataclass
class OrderBookLevel:
    """A single price level in an order book."""
    price: float
    size: float


@dataclass
class OrderBookSnapshot:
    """Point-in-time snapshot of one side (YES or NO) of a market's book."""
    token_id: str
    bids: list[OrderBookLevel] = field(default_factory=list)
    asks: list[OrderBookLevel] = field(default_factory=list)
    timestamp: float = field(default_factory=time.time)

    @property
    def best_bid(self) -> float | None:
        return self.bids[0].price if self.bids else None

    @property
    def best_ask(self) -> float | None:
        return self.asks[0].price if self.asks else None

    @property
    def best_bid_size(self) -> float | None:
        return self.bids[0].size if self.bids else None

    @property
    def best_ask_size(self) -> float | None:
        return self.asks[0].size if self.asks else None


@dataclass
class BinaryMarket:
    """A Polymarket binary (YES/NO) market."""
    condition_id: str
    question: str
    slug: str
    yes_token_id: str
    no_token_id: str
    active: bool = True
    closed: bool = False
    # Latest orderbook snapshots
    yes_book: OrderBookSnapshot | None = None
    no_book: OrderBookSnapshot | None = None

    @property
    def market_id(self) -> str:
        return self.condition_id


@dataclass
class ArbitrageOpportunity:
    """
    Detected arbitrage where YES_ask + NO_ask < 1.0 (after fees).

    In a binary market, YES + NO should sum to $1.00.
    If you can buy YES at ask_yes and NO at ask_no where
    ask_yes + ask_no + fees < 1.0, there's a guaranteed profit.

    Alternatively, if best_bid_yes + best_bid_no > 1.0 (after fees),
    you can sell both sides for guaranteed profit.
    """
    market: BinaryMarket
    yes_price: float  # price we'd pay/receive for YES
    no_price: float   # price we'd pay/receive for NO
    spread_bps: int   # spread in basis points after fees
    max_size: float   # max trade size limited by book depth
    direction: str    # "buy_both" or "sell_both"
    timestamp: float = field(default_factory=time.time)

    @property
    def spread_pct(self) -> float:
        return self.spread_bps / 100

    @property
    def expected_profit_per_unit(self) -> float:
        if self.direction == "buy_both":
            return 1.0 - self.yes_price - self.no_price
        else:  # sell_both
            return self.yes_price + self.no_price - 1.0


@dataclass
class TradeRecord:
    """Record of an executed (or paper) trade."""
    trade_id: str
    market_condition_id: str
    token_id: str
    side: Side
    outcome: Outcome
    price: float
    size: float
    fee: float
    status: OrderStatus
    is_paper: bool
    timestamp: float = field(default_factory=time.time)
    order_id: str = ""
    error: str = ""

    @property
    def total_cost(self) -> float:
        return self.price * self.size + self.fee


@dataclass
class PortfolioState:
    """Current portfolio snapshot for risk management."""
    total_value_usdc: float = 0.0
    open_positions: int = 0
    total_pnl_usdc: float = 0.0
    trades_executed: int = 0
    current_exposure_usdc: float = 0.0
