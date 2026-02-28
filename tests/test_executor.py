"""
Tests for the trade executor — paper trading mode.
"""

import pytest

from src.core.arbitrage import ArbitrageEngine
from src.core.clob_api import ClobApiClient
from src.core.config import Settings
from src.core.types import (
    ArbitrageOpportunity,
    BinaryMarket,
    OrderBookLevel,
    OrderBookSnapshot,
    OrderStatus,
)
from src.trading.executor import TradeExecutor


def _make_settings(**overrides) -> Settings:
    defaults = {
        "trading_mode": "paper",
        "min_spread_bps": 10,
        "max_position_usdc": 100.0,
        "max_total_exposure_usdc": 500.0,
        "max_open_positions": 5,
        "taker_fee_bps": 0,
        "stop_loss_usdc": 50.0,
        "trade_cooldown_seconds": 0,
    }
    defaults.update(overrides)
    return Settings(**defaults)


def _make_opportunity(
    yes_price=0.40,
    no_price=0.40,
    max_size=50,
    direction="buy_both",
) -> ArbitrageOpportunity:
    market = BinaryMarket(
        condition_id="cond_test",
        question="Test market",
        slug="test",
        yes_token_id="yes_tok",
        no_token_id="no_tok",
    )
    return ArbitrageOpportunity(
        market=market,
        yes_price=yes_price,
        no_price=no_price,
        spread_bps=int((1.0 - yes_price - no_price) * 10000),
        max_size=max_size,
        direction=direction,
    )


class TestTradeExecutor:
    def _make_executor(self, **settings_overrides) -> TradeExecutor:
        settings = _make_settings(**settings_overrides)
        api = ClobApiClient(settings)
        engine = ArbitrageEngine(settings)
        return TradeExecutor(settings, api, engine)

    def test_can_trade_passes(self):
        executor = self._make_executor()
        opp = _make_opportunity()
        allowed, reason = executor.can_trade(opp)
        assert allowed
        assert reason == "OK"

    def test_can_trade_rejects_low_spread(self):
        executor = self._make_executor(min_spread_bps=5000)
        opp = _make_opportunity(spread_bps=100)
        opp.spread_bps = 100
        allowed, reason = executor.can_trade(opp)
        assert not allowed
        assert "Spread" in reason

    def test_can_trade_respects_circuit_breaker(self):
        executor = self._make_executor()
        executor._halted = True
        executor._halt_reason = "Test halt"
        opp = _make_opportunity()
        allowed, reason = executor.can_trade(opp)
        assert not allowed
        assert "Circuit breaker" in reason

    def test_can_trade_respects_max_positions(self):
        executor = self._make_executor(max_open_positions=1)
        executor.portfolio.open_positions = 1
        opp = _make_opportunity()
        allowed, reason = executor.can_trade(opp)
        assert not allowed
        assert "Exposure" in reason or "position" in reason.lower()

    def test_can_trade_respects_max_exposure(self):
        executor = self._make_executor(max_total_exposure_usdc=10.0)
        executor.portfolio.current_exposure_usdc = 9.0
        opp = _make_opportunity(max_size=100)
        allowed, reason = executor.can_trade(opp)
        assert not allowed

    @pytest.mark.asyncio
    async def test_paper_trade_buy_both(self):
        executor = self._make_executor(taker_fee_bps=0)
        opp = _make_opportunity(yes_price=0.40, no_price=0.40, max_size=50)
        trades = await executor.execute_opportunity(opp)
        assert len(trades) == 2
        assert all(t.is_paper for t in trades)
        assert all(t.status == OrderStatus.FILLED for t in trades)
        assert executor.portfolio.trades_executed == 2
        assert executor.portfolio.total_pnl_usdc > 0

    @pytest.mark.asyncio
    async def test_paper_trade_updates_balance(self):
        executor = self._make_executor(taker_fee_bps=0)
        initial_balance = executor._paper_balance_usdc
        opp = _make_opportunity(yes_price=0.40, no_price=0.40, max_size=10)
        await executor.execute_opportunity(opp)
        # Bought at 0.80 total, settled at 1.0 → profit of 0.20 per unit
        # 10 units → profit = 2.0
        assert executor._paper_balance_usdc > initial_balance

    @pytest.mark.asyncio
    async def test_cooldown_prevents_repeat_trade(self):
        executor = self._make_executor(trade_cooldown_seconds=9999)
        opp = _make_opportunity()
        trades1 = await executor.execute_opportunity(opp)
        assert len(trades1) == 2

        # Same market should be blocked by cooldown
        trades2 = await executor.execute_opportunity(opp)
        assert len(trades2) == 0

    def test_reset_halt(self):
        executor = self._make_executor()
        executor._halted = True
        executor._halt_reason = "test"
        executor.reset_halt()
        assert not executor._halted
        assert executor._halt_reason == ""

    def test_stats(self):
        executor = self._make_executor()
        stats = executor.stats
        assert stats["mode"] == "paper"
        assert "paper_balance" in stats
        assert stats["halted"] is False
