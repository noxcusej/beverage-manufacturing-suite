"""
Tests for the arbitrage detection engine and fee calculations.
"""

from src.core.arbitrage import ArbitrageEngine
from src.core.config import Settings
from src.core.types import BinaryMarket, OrderBookLevel, OrderBookSnapshot


def _make_settings(**overrides) -> Settings:
    defaults = {
        "trading_mode": "paper",
        "min_spread_bps": 10,
        "max_position_usdc": 100.0,
        "taker_fee_bps": 200,  # 2% base fee rate for testing
        "maker_fee_bps": 0,
    }
    defaults.update(overrides)
    return Settings(**defaults)


def _make_market(
    yes_bids=None,
    yes_asks=None,
    no_bids=None,
    no_asks=None,
) -> BinaryMarket:
    market = BinaryMarket(
        condition_id="cond_test_123",
        question="Will it rain tomorrow?",
        slug="will-it-rain",
        yes_token_id="yes_token_abc",
        no_token_id="no_token_xyz",
    )
    if yes_bids is not None or yes_asks is not None:
        market.yes_book = OrderBookSnapshot(
            token_id="yes_token_abc",
            bids=[OrderBookLevel(p, s) for p, s in (yes_bids or [])],
            asks=[OrderBookLevel(p, s) for p, s in (yes_asks or [])],
        )
    if no_bids is not None or no_asks is not None:
        market.no_book = OrderBookSnapshot(
            token_id="no_token_xyz",
            bids=[OrderBookLevel(p, s) for p, s in (no_bids or [])],
            asks=[OrderBookLevel(p, s) for p, s in (no_asks or [])],
        )
    return market


class TestFeeCalculation:
    def test_fee_at_50_cents(self):
        engine = ArbitrageEngine(_make_settings(taker_fee_bps=200))
        # fee = 0.02 * 0.50 * 0.50 * 100 = 0.5
        fee = engine.calculate_fee(price=0.50, size=100, is_taker=True)
        assert fee == 0.5

    def test_fee_at_80_cents(self):
        engine = ArbitrageEngine(_make_settings(taker_fee_bps=200))
        # fee = 0.02 * 0.80 * 0.20 * 100 = 0.32
        fee = engine.calculate_fee(price=0.80, size=100, is_taker=True)
        assert fee == 0.32

    def test_fee_at_20_cents(self):
        engine = ArbitrageEngine(_make_settings(taker_fee_bps=200))
        # fee = 0.02 * 0.20 * 0.80 * 100 = 0.32
        fee = engine.calculate_fee(price=0.20, size=100, is_taker=True)
        assert fee == 0.32

    def test_fee_symmetry(self):
        """Fees at price p should equal fees at price (1-p)."""
        engine = ArbitrageEngine(_make_settings(taker_fee_bps=150))
        for p in [0.10, 0.25, 0.40, 0.60, 0.75, 0.90]:
            fee_p = engine.calculate_fee(price=p, size=50, is_taker=True)
            fee_comp = engine.calculate_fee(price=1 - p, size=50, is_taker=True)
            assert abs(fee_p - fee_comp) < 1e-9, f"Asymmetry at p={p}"

    def test_maker_fee_zero(self):
        engine = ArbitrageEngine(_make_settings(maker_fee_bps=0))
        fee = engine.calculate_fee(price=0.50, size=100, is_taker=False)
        assert fee == 0.0

    def test_minimum_fee(self):
        """Fee should be at least $0.001 when non-zero."""
        engine = ArbitrageEngine(_make_settings(taker_fee_bps=1))
        fee = engine.calculate_fee(price=0.99, size=1, is_taker=True)
        assert fee >= 0.001


class TestOrderBookSnapshot:
    def test_best_bid_ask(self):
        book = OrderBookSnapshot(
            token_id="test",
            bids=[OrderBookLevel(0.48, 100), OrderBookLevel(0.47, 200)],
            asks=[OrderBookLevel(0.52, 100), OrderBookLevel(0.53, 200)],
        )
        assert book.best_bid == 0.48
        assert book.best_ask == 0.52
        assert book.best_bid_size == 100
        assert book.best_ask_size == 100

    def test_empty_book(self):
        book = OrderBookSnapshot(token_id="test")
        assert book.best_bid is None
        assert book.best_ask is None


class TestArbitrageDetection:
    def test_buy_both_opportunity(self):
        """YES ask + NO ask < 1.0 → arbitrage."""
        engine = ArbitrageEngine(_make_settings(taker_fee_bps=0, min_spread_bps=1))
        market = _make_market(
            yes_asks=[(0.40, 100)],
            no_asks=[(0.50, 100)],
        )
        engine.register_market(market)
        opp = engine.scan_market(market)
        assert opp is not None
        assert opp.direction == "buy_both"
        assert opp.spread_bps > 0
        assert opp.expected_profit_per_unit > 0

    def test_no_opportunity_when_prices_sum_to_one(self):
        """YES ask + NO ask == 1.0 → no arbitrage."""
        engine = ArbitrageEngine(_make_settings(taker_fee_bps=0, min_spread_bps=1))
        market = _make_market(
            yes_asks=[(0.50, 100)],
            no_asks=[(0.50, 100)],
        )
        engine.register_market(market)
        opp = engine.scan_market(market)
        assert opp is None

    def test_no_opportunity_when_fees_eat_spread(self):
        """Spread exists but is consumed by fees."""
        engine = ArbitrageEngine(_make_settings(taker_fee_bps=500, min_spread_bps=1))
        market = _make_market(
            yes_asks=[(0.48, 100)],
            no_asks=[(0.48, 100)],
        )
        engine.register_market(market)
        opp = engine.scan_market(market)
        # 0.48 + 0.48 = 0.96, but 5% fees on each side should eat the spread
        assert opp is None

    def test_sell_both_opportunity(self):
        """YES bid + NO bid > 1.0 → sell both arbitrage."""
        engine = ArbitrageEngine(_make_settings(taker_fee_bps=0, min_spread_bps=1))
        market = _make_market(
            yes_bids=[(0.55, 100)],
            no_bids=[(0.55, 100)],
        )
        engine.register_market(market)
        opp = engine.scan_market(market)
        assert opp is not None
        assert opp.direction == "sell_both"
        assert opp.spread_bps > 0

    def test_min_spread_filter(self):
        """Opportunity below min_spread_bps is filtered out."""
        engine = ArbitrageEngine(_make_settings(taker_fee_bps=0, min_spread_bps=500))
        market = _make_market(
            yes_asks=[(0.49, 100)],
            no_asks=[(0.49, 100)],
        )
        engine.register_market(market)
        opp = engine.scan_market(market)
        # 2% spread = 200 bps, below 500 bps threshold
        assert opp is None

    def test_scan_all(self):
        engine = ArbitrageEngine(_make_settings(taker_fee_bps=0, min_spread_bps=1))

        # Market with opportunity
        m1 = _make_market(yes_asks=[(0.40, 50)], no_asks=[(0.40, 50)])
        m1.condition_id = "cond_1"
        m1.yes_token_id = "yes_1"
        m1.no_token_id = "no_1"

        # Market without opportunity
        m2 = _make_market(yes_asks=[(0.50, 50)], no_asks=[(0.50, 50)])
        m2.condition_id = "cond_2"
        m2.yes_token_id = "yes_2"
        m2.no_token_id = "no_2"

        engine.register_markets([m1, m2])
        opps = engine.scan_all()
        assert len(opps) == 1
        assert opps[0].market.condition_id == "cond_1"

    def test_missing_books_returns_none(self):
        engine = ArbitrageEngine(_make_settings())
        market = BinaryMarket(
            condition_id="cond",
            question="test",
            slug="test",
            yes_token_id="y",
            no_token_id="n",
        )
        engine.register_market(market)
        assert engine.scan_market(market) is None

    def test_max_size_limited_by_book_depth(self):
        """Trade size should be limited by the smaller side's depth."""
        engine = ArbitrageEngine(_make_settings(taker_fee_bps=0, min_spread_bps=1, max_position_usdc=10000))
        market = _make_market(
            yes_asks=[(0.30, 10)],   # Only 10 available
            no_asks=[(0.30, 500)],   # 500 available
        )
        engine.register_market(market)
        opp = engine.scan_market(market)
        assert opp is not None
        assert opp.max_size <= 10

    def test_update_book(self):
        engine = ArbitrageEngine(_make_settings())
        market = BinaryMarket(
            condition_id="cond",
            question="test",
            slug="test",
            yes_token_id="yes_t",
            no_token_id="no_t",
        )
        engine.register_market(market)

        book = OrderBookSnapshot(
            token_id="yes_t",
            bids=[OrderBookLevel(0.45, 100)],
            asks=[OrderBookLevel(0.55, 100)],
        )
        engine.update_book("yes_t", book)
        assert market.yes_book is not None
        assert market.yes_book.best_bid == 0.45


class TestMarketRegistration:
    def test_register_and_lookup(self):
        engine = ArbitrageEngine(_make_settings())
        market = _make_market()
        engine.register_market(market)

        assert engine.get_market_for_token("yes_token_abc") is market
        assert engine.get_market_for_token("no_token_xyz") is market
        assert engine.get_market_for_token("unknown") is None

    def test_all_token_ids(self):
        engine = ArbitrageEngine(_make_settings())
        m1 = _make_market()
        m1.condition_id = "c1"
        m1.yes_token_id = "y1"
        m1.no_token_id = "n1"

        m2 = _make_market()
        m2.condition_id = "c2"
        m2.yes_token_id = "y2"
        m2.no_token_id = "n2"

        engine.register_markets([m1, m2])
        ids = engine.all_token_ids
        assert set(ids) == {"y1", "n1", "y2", "n2"}
