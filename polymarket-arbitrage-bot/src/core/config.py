"""
Central configuration for the Polymarket arbitrage bot.
All settings are loaded from environment variables with sensible defaults.
"""

from __future__ import annotations

from enum import Enum
from pathlib import Path

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class TradingMode(str, Enum):
    PAPER = "paper"
    LIVE = "live"


class LogLevel(str, Enum):
    DEBUG = "DEBUG"
    INFO = "INFO"
    WARNING = "WARNING"
    ERROR = "ERROR"


# ---------------------------------------------------------------------------
# Polymarket CLOB API endpoints (Polygon mainnet)
# ---------------------------------------------------------------------------
CLOB_API_BASE = "https://clob.polymarket.com"
GAMMA_API_BASE = "https://gamma-api.polymarket.com"
WS_DEFAULT_ENDPOINT = "wss://ws-subscriptions-clob.polymarket.com/ws/market"


class Settings(BaseSettings):
    """Bot configuration – sourced from .env / environment variables."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # --- API credentials ---
    poly_api_key: SecretStr = Field(default=SecretStr(""))
    poly_api_secret: SecretStr = Field(default=SecretStr(""))
    poly_api_passphrase: SecretStr = Field(default=SecretStr(""))
    private_key: SecretStr = Field(default=SecretStr(""))
    chain_id: int = Field(default=137)

    # --- Trading mode ---
    trading_mode: TradingMode = Field(default=TradingMode.PAPER)

    # --- Arbitrage parameters ---
    min_spread_bps: int = Field(default=50, ge=1, description="Min spread in basis points")
    max_position_usdc: float = Field(default=50.0, gt=0)
    max_total_exposure_usdc: float = Field(default=500.0, gt=0)
    max_open_positions: int = Field(default=10, ge=1)

    # --- Fee configuration ---
    maker_fee_bps: int = Field(default=0, ge=0)
    taker_fee_bps: int = Field(default=150, ge=0)

    # --- Risk controls ---
    stop_loss_usdc: float = Field(default=100.0, gt=0)
    max_slippage_bps: int = Field(default=100, ge=0)
    trade_cooldown_seconds: int = Field(default=30, ge=0)

    # --- WebSocket ---
    ws_endpoint: str = Field(default=WS_DEFAULT_ENDPOINT)
    ws_max_reconnect_attempts: int = Field(default=10, ge=1)

    # --- Tailscale ---
    tailscale_enabled: bool = Field(default=False)
    tailscale_exit_node: str = Field(default="")

    # --- Logging ---
    log_level: LogLevel = Field(default=LogLevel.INFO)
    log_file: str = Field(default="logs/arb-bot.log")

    # --- Derived helpers ---

    @property
    def is_paper(self) -> bool:
        return self.trading_mode == TradingMode.PAPER

    @property
    def maker_fee_rate(self) -> float:
        return self.maker_fee_bps / 10_000

    @property
    def taker_fee_rate(self) -> float:
        return self.taker_fee_bps / 10_000

    @field_validator("trading_mode", mode="before")
    @classmethod
    def normalize_trading_mode(cls, v: str) -> str:
        if isinstance(v, str):
            return v.lower().strip()
        return v

    def validate_live_credentials(self) -> list[str]:
        """Return list of missing credentials needed for live trading."""
        missing: list[str] = []
        if not self.poly_api_key.get_secret_value():
            missing.append("POLY_API_KEY")
        if not self.poly_api_secret.get_secret_value():
            missing.append("POLY_API_SECRET")
        if not self.poly_api_passphrase.get_secret_value():
            missing.append("POLY_API_PASSPHRASE")
        if not self.private_key.get_secret_value():
            missing.append("PRIVATE_KEY")
        return missing

    def ensure_log_dir(self) -> None:
        if self.log_file:
            Path(self.log_file).parent.mkdir(parents=True, exist_ok=True)
