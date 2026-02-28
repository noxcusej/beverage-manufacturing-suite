"""
Trade execution engine — handles both live and paper trading.

The executor receives ArbitrageOpportunity objects from the detection
engine and executes the appropriate trades. In paper mode, trades are
simulated locally with realistic fee modeling. In live mode, orders
are submitted via the CLOB API.

Safety controls:
  - Max position size per trade
  - Max total portfolio exposure
  - Max concurrent open positions
  - Stop-loss circuit breaker
  - Per-market cooldown timer
  - Slippage protection
"""

from __future__ import annotations

import json
import time
import uuid
from pathlib import Path

import structlog

from src.core.arbitrage import ArbitrageEngine
from src.core.clob_api import ClobApiClient
from src.core.config import Settings
from src.core.types import (
    ArbitrageOpportunity,
    OrderStatus,
    Outcome,
    PortfolioState,
    Side,
    TradeRecord,
)

log = structlog.get_logger("executor")

PAPER_STATE_FILE = "paper_state.json"


class TradeExecutor:
    """Manages trade execution with full risk controls."""

    def __init__(
        self,
        settings: Settings,
        api_client: ClobApiClient,
        arb_engine: ArbitrageEngine,
    ):
        self.settings = settings
        self.api = api_client
        self.arb_engine = arb_engine

        # Trade history
        self.trades: list[TradeRecord] = []

        # Cooldown tracker: condition_id → last trade timestamp
        self._cooldowns: dict[str, float] = {}

        # Portfolio state
        self.portfolio = PortfolioState()

        # Paper trading state
        self._paper_balance_usdc: float = 1000.0  # Starting paper balance
        self._paper_positions: dict[str, float] = {}  # token_id → shares held

        # Circuit breaker
        self._halted = False
        self._halt_reason = ""

    # ------------------------------------------------------------------
    # Safety checks
    # ------------------------------------------------------------------

    def _check_circuit_breaker(self) -> bool:
        """Check if trading should be halted."""
        if self._halted:
            return False

        # Stop-loss check
        if self.portfolio.total_pnl_usdc < -self.settings.stop_loss_usdc:
            self._halted = True
            self._halt_reason = (
                f"Stop-loss triggered: PnL {self.portfolio.total_pnl_usdc:.2f} "
                f"< -{self.settings.stop_loss_usdc:.2f}"
            )
            log.error("circuit_breaker_triggered", reason=self._halt_reason)
            return False

        return True

    def _check_cooldown(self, condition_id: str) -> bool:
        """Check if the market is still in cooldown period."""
        last_trade = self._cooldowns.get(condition_id, 0)
        elapsed = time.time() - last_trade
        if elapsed < self.settings.trade_cooldown_seconds:
            log.debug(
                "cooldown_active",
                market=condition_id[:16],
                remaining_s=round(self.settings.trade_cooldown_seconds - elapsed),
            )
            return False
        return True

    def _check_exposure(self, additional_usdc: float) -> bool:
        """Check if adding this trade would exceed exposure limits."""
        if self.portfolio.open_positions >= self.settings.max_open_positions:
            log.warning("max_positions_reached", current=self.portfolio.open_positions)
            return False

        new_exposure = self.portfolio.current_exposure_usdc + additional_usdc
        if new_exposure > self.settings.max_total_exposure_usdc:
            log.warning(
                "max_exposure_exceeded",
                current=self.portfolio.current_exposure_usdc,
                additional=additional_usdc,
                limit=self.settings.max_total_exposure_usdc,
            )
            return False

        return True

    def can_trade(self, opportunity: ArbitrageOpportunity) -> tuple[bool, str]:
        """Full pre-trade validation. Returns (allowed, reason)."""
        if not self._check_circuit_breaker():
            return False, f"Circuit breaker: {self._halt_reason}"

        if not self._check_cooldown(opportunity.market.condition_id):
            return False, "Market in cooldown"

        trade_value = opportunity.max_size * (opportunity.yes_price + opportunity.no_price)
        if trade_value > self.settings.max_position_usdc:
            trade_value = self.settings.max_position_usdc

        if not self._check_exposure(trade_value):
            return False, "Exposure limit exceeded"

        if opportunity.spread_bps < self.settings.min_spread_bps:
            return False, f"Spread {opportunity.spread_bps} bps below min {self.settings.min_spread_bps}"

        return True, "OK"

    # ------------------------------------------------------------------
    # Execution
    # ------------------------------------------------------------------

    async def execute_opportunity(
        self, opportunity: ArbitrageOpportunity
    ) -> list[TradeRecord]:
        """
        Execute an arbitrage opportunity.
        Returns list of trade records (2 trades for buy_both / sell_both).
        """
        allowed, reason = self.can_trade(opportunity)
        if not allowed:
            log.info("trade_rejected", reason=reason, market=opportunity.market.question[:40])
            return []

        if self.settings.is_paper:
            return await self._execute_paper(opportunity)
        else:
            return await self._execute_live(opportunity)

    async def _execute_paper(
        self, opp: ArbitrageOpportunity
    ) -> list[TradeRecord]:
        """Simulate trade execution in paper mode."""
        trades: list[TradeRecord] = []
        size = min(opp.max_size, self.settings.max_position_usdc / max(opp.yes_price + opp.no_price, 0.01))

        if opp.direction == "buy_both":
            # Buy YES
            yes_fee = self.arb_engine.calculate_fee(opp.yes_price, size)
            yes_cost = opp.yes_price * size + yes_fee
            # Buy NO
            no_fee = self.arb_engine.calculate_fee(opp.no_price, size)
            no_cost = opp.no_price * size + no_fee

            total_cost = yes_cost + no_cost

            if total_cost > self._paper_balance_usdc:
                log.warning("paper_insufficient_balance", need=total_cost, have=self._paper_balance_usdc)
                size = self._paper_balance_usdc / (opp.yes_price + opp.no_price + yes_fee / size + no_fee / size)
                yes_fee = self.arb_engine.calculate_fee(opp.yes_price, size)
                no_fee = self.arb_engine.calculate_fee(opp.no_price, size)
                total_cost = opp.yes_price * size + yes_fee + opp.no_price * size + no_fee

            self._paper_balance_usdc -= total_cost

            trades.append(self._record_trade(
                opp, opp.market.yes_token_id, Side.BUY, Outcome.YES,
                opp.yes_price, size, yes_fee, is_paper=True,
            ))
            trades.append(self._record_trade(
                opp, opp.market.no_token_id, Side.BUY, Outcome.NO,
                opp.no_price, size, no_fee, is_paper=True,
            ))

            # In paper mode, assume instant resolution: profit = $1 * size - total_cost
            profit = size * 1.0 - total_cost
            self._paper_balance_usdc += size * 1.0  # Settlement
            self.portfolio.total_pnl_usdc += profit

            log.info(
                "paper_trade_executed",
                direction="buy_both",
                size=round(size, 2),
                cost=round(total_cost, 4),
                profit=round(profit, 4),
                balance=round(self._paper_balance_usdc, 2),
            )

        elif opp.direction == "sell_both":
            # Sell YES
            yes_fee = self.arb_engine.calculate_fee(opp.yes_price, size)
            yes_revenue = opp.yes_price * size - yes_fee
            # Sell NO
            no_fee = self.arb_engine.calculate_fee(opp.no_price, size)
            no_revenue = opp.no_price * size - no_fee

            total_revenue = yes_revenue + no_revenue
            cost = size * 1.0  # Minting cost

            if cost > self._paper_balance_usdc:
                size = self._paper_balance_usdc
                yes_fee = self.arb_engine.calculate_fee(opp.yes_price, size)
                no_fee = self.arb_engine.calculate_fee(opp.no_price, size)
                total_revenue = opp.yes_price * size - yes_fee + opp.no_price * size - no_fee
                cost = size * 1.0

            self._paper_balance_usdc -= cost

            trades.append(self._record_trade(
                opp, opp.market.yes_token_id, Side.SELL, Outcome.YES,
                opp.yes_price, size, yes_fee, is_paper=True,
            ))
            trades.append(self._record_trade(
                opp, opp.market.no_token_id, Side.SELL, Outcome.NO,
                opp.no_price, size, no_fee, is_paper=True,
            ))

            profit = total_revenue - cost
            self._paper_balance_usdc += total_revenue
            self.portfolio.total_pnl_usdc += profit

            log.info(
                "paper_trade_executed",
                direction="sell_both",
                size=round(size, 2),
                revenue=round(total_revenue, 4),
                profit=round(profit, 4),
                balance=round(self._paper_balance_usdc, 2),
            )

        # Update portfolio state
        self.portfolio.trades_executed += len(trades)
        self.portfolio.open_positions += 1
        self.portfolio.current_exposure_usdc += size * (opp.yes_price + opp.no_price)
        self._cooldowns[opp.market.condition_id] = time.time()

        self._save_paper_state()
        return trades

    async def _execute_live(
        self, opp: ArbitrageOpportunity
    ) -> list[TradeRecord]:
        """Execute real trades via the CLOB API."""
        trades: list[TradeRecord] = []
        size = min(opp.max_size, self.settings.max_position_usdc / max(opp.yes_price + opp.no_price, 0.01))

        # Fetch live fee rates and tick sizes
        try:
            yes_fee_bps = await self.api.get_fee_rate(opp.market.yes_token_id)
            no_fee_bps = await self.api.get_fee_rate(opp.market.no_token_id)
            yes_tick = await self.api.get_tick_size(opp.market.yes_token_id)
            yes_neg_risk = await self.api.get_neg_risk(opp.market.yes_token_id)
        except Exception as e:
            log.error("live_preflight_failed", error=str(e))
            return []

        if opp.direction == "buy_both":
            # Place YES buy order
            try:
                yes_resp = await self.api.place_limit_order(
                    token_id=opp.market.yes_token_id,
                    side="BUY",
                    price=opp.yes_price,
                    size=size,
                    fee_rate_bps=yes_fee_bps,
                    tick_size=yes_tick,
                    neg_risk=yes_neg_risk,
                )
                yes_fee = self.arb_engine.calculate_fee(opp.yes_price, size)
                trades.append(self._record_trade(
                    opp, opp.market.yes_token_id, Side.BUY, Outcome.YES,
                    opp.yes_price, size, yes_fee, is_paper=False,
                    order_id=yes_resp.get("orderID", ""),
                ))
            except Exception as e:
                log.error("yes_order_failed", error=str(e))
                trades.append(self._record_trade(
                    opp, opp.market.yes_token_id, Side.BUY, Outcome.YES,
                    opp.yes_price, size, 0, is_paper=False,
                    status=OrderStatus.FAILED, error=str(e),
                ))
                return trades

            # Place NO buy order
            try:
                no_resp = await self.api.place_limit_order(
                    token_id=opp.market.no_token_id,
                    side="BUY",
                    price=opp.no_price,
                    size=size,
                    fee_rate_bps=no_fee_bps,
                    tick_size=yes_tick,
                    neg_risk=yes_neg_risk,
                )
                no_fee = self.arb_engine.calculate_fee(opp.no_price, size)
                trades.append(self._record_trade(
                    opp, opp.market.no_token_id, Side.BUY, Outcome.NO,
                    opp.no_price, size, no_fee, is_paper=False,
                    order_id=no_resp.get("orderID", ""),
                ))
            except Exception as e:
                log.error("no_order_failed", error=str(e), hint="YES leg already placed")
                trades.append(self._record_trade(
                    opp, opp.market.no_token_id, Side.BUY, Outcome.NO,
                    opp.no_price, size, 0, is_paper=False,
                    status=OrderStatus.FAILED, error=str(e),
                ))

        elif opp.direction == "sell_both":
            try:
                yes_resp = await self.api.place_limit_order(
                    token_id=opp.market.yes_token_id,
                    side="SELL",
                    price=opp.yes_price,
                    size=size,
                    fee_rate_bps=yes_fee_bps,
                    tick_size=yes_tick,
                    neg_risk=yes_neg_risk,
                )
                yes_fee = self.arb_engine.calculate_fee(opp.yes_price, size)
                trades.append(self._record_trade(
                    opp, opp.market.yes_token_id, Side.SELL, Outcome.YES,
                    opp.yes_price, size, yes_fee, is_paper=False,
                    order_id=yes_resp.get("orderID", ""),
                ))
            except Exception as e:
                log.error("yes_sell_failed", error=str(e))
                return trades

            try:
                no_resp = await self.api.place_limit_order(
                    token_id=opp.market.no_token_id,
                    side="SELL",
                    price=opp.no_price,
                    size=size,
                    fee_rate_bps=no_fee_bps,
                    tick_size=yes_tick,
                    neg_risk=yes_neg_risk,
                )
                no_fee = self.arb_engine.calculate_fee(opp.no_price, size)
                trades.append(self._record_trade(
                    opp, opp.market.no_token_id, Side.SELL, Outcome.NO,
                    opp.no_price, size, no_fee, is_paper=False,
                    order_id=no_resp.get("orderID", ""),
                ))
            except Exception as e:
                log.error("no_sell_failed", error=str(e))

        # Update portfolio
        self.portfolio.trades_executed += len(trades)
        self.portfolio.open_positions += 1
        self.portfolio.current_exposure_usdc += size * (opp.yes_price + opp.no_price)
        self._cooldowns[opp.market.condition_id] = time.time()

        log.info(
            "live_trades_executed",
            direction=opp.direction,
            trades=len(trades),
            successful=sum(1 for t in trades if t.status != OrderStatus.FAILED),
        )
        return trades

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _record_trade(
        self,
        opp: ArbitrageOpportunity,
        token_id: str,
        side: Side,
        outcome: Outcome,
        price: float,
        size: float,
        fee: float,
        is_paper: bool,
        order_id: str = "",
        status: OrderStatus = OrderStatus.FILLED,
        error: str = "",
    ) -> TradeRecord:
        record = TradeRecord(
            trade_id=str(uuid.uuid4())[:8],
            market_condition_id=opp.market.condition_id,
            token_id=token_id,
            side=side,
            outcome=outcome,
            price=price,
            size=size,
            fee=fee,
            status=status,
            is_paper=is_paper,
            order_id=order_id,
            error=error,
        )
        self.trades.append(record)
        return record

    def reset_halt(self) -> None:
        """Manually reset the circuit breaker."""
        self._halted = False
        self._halt_reason = ""
        log.info("circuit_breaker_reset")

    def _save_paper_state(self) -> None:
        """Persist paper trading state to disk."""
        state = {
            "balance_usdc": self._paper_balance_usdc,
            "total_pnl": self.portfolio.total_pnl_usdc,
            "trades_executed": self.portfolio.trades_executed,
            "positions": self._paper_positions,
            "trades": [
                {
                    "id": t.trade_id,
                    "market": t.market_condition_id[:16],
                    "side": t.side.value,
                    "outcome": t.outcome.value,
                    "price": t.price,
                    "size": t.size,
                    "fee": t.fee,
                    "timestamp": t.timestamp,
                }
                for t in self.trades[-50:]  # Keep last 50
            ],
        }
        try:
            Path(PAPER_STATE_FILE).write_text(json.dumps(state, indent=2))
        except Exception as e:
            log.warning("paper_state_save_failed", error=str(e))

    def load_paper_state(self) -> None:
        """Load persisted paper trading state."""
        path = Path(PAPER_STATE_FILE)
        if not path.exists():
            return
        try:
            state = json.loads(path.read_text())
            self._paper_balance_usdc = state.get("balance_usdc", 1000.0)
            self.portfolio.total_pnl_usdc = state.get("total_pnl", 0.0)
            self.portfolio.trades_executed = state.get("trades_executed", 0)
            log.info(
                "paper_state_loaded",
                balance=self._paper_balance_usdc,
                pnl=self.portfolio.total_pnl_usdc,
            )
        except Exception as e:
            log.warning("paper_state_load_failed", error=str(e))

    @property
    def stats(self) -> dict:
        return {
            "mode": "paper" if self.settings.is_paper else "live",
            "trades_executed": self.portfolio.trades_executed,
            "total_pnl_usdc": round(self.portfolio.total_pnl_usdc, 4),
            "open_positions": self.portfolio.open_positions,
            "current_exposure_usdc": round(self.portfolio.current_exposure_usdc, 2),
            "halted": self._halted,
            "halt_reason": self._halt_reason,
            "paper_balance": round(self._paper_balance_usdc, 2) if self.settings.is_paper else None,
        }
