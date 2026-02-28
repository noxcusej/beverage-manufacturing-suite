"""
CLI entry point for the Polymarket arbitrage bot.

Usage:
    arb-bot run                  # Run with settings from .env
    arb-bot run --mode paper     # Force paper trading mode
    arb-bot run --mode live      # Force live trading mode
    arb-bot config               # Show current configuration
    arb-bot check                # Run pre-flight checks only
"""

from __future__ import annotations

import asyncio
import sys

import click
import structlog
from rich.console import Console
from rich.panel import Panel
from rich.table import Table

from src.bot import ArbitrageBot
from src.core.config import LogLevel, Settings, TradingMode
from src.utils.logging import setup_logging
from src.utils.tailscale import TailscaleManager

console = Console()


def _banner(settings: Settings) -> None:
    mode_color = "red bold" if settings.trading_mode == TradingMode.LIVE else "green bold"
    mode_label = settings.trading_mode.value.upper()

    console.print()
    console.print(
        Panel.fit(
            f"[bold]Polymarket Arbitrage Bot[/bold]\n"
            f"Mode: [{mode_color}]{mode_label}[/{mode_color}]  |  "
            f"Min Spread: {settings.min_spread_bps} bps  |  "
            f"Max Position: ${settings.max_position_usdc}",
            border_style="blue",
        )
    )
    console.print()


@click.group()
def cli() -> None:
    """Polymarket CLOB arbitrage bot with real-time WebSocket feeds."""
    pass


@cli.command()
@click.option(
    "--mode",
    type=click.Choice(["paper", "live"], case_sensitive=False),
    default=None,
    help="Override trading mode (default: from .env)",
)
@click.option(
    "--min-spread",
    type=int,
    default=None,
    help="Override minimum spread in basis points",
)
@click.option(
    "--max-position",
    type=float,
    default=None,
    help="Override max position size in USDC",
)
@click.option(
    "--log-level",
    type=click.Choice(["DEBUG", "INFO", "WARNING", "ERROR"], case_sensitive=False),
    default=None,
    help="Override log level",
)
@click.option(
    "--tailscale/--no-tailscale",
    default=None,
    help="Override Tailscale VPN usage",
)
@click.option(
    "--port",
    type=int,
    default=8899,
    help="Dashboard web UI port (default: 8899)",
)
def run(
    mode: str | None,
    min_spread: int | None,
    max_position: float | None,
    log_level: str | None,
    tailscale: bool | None,
    port: int,
) -> None:
    """Start the arbitrage bot."""
    # Load base settings from .env
    settings = Settings()

    # Apply CLI overrides
    if mode:
        settings.trading_mode = TradingMode(mode.lower())
    if min_spread is not None:
        settings.min_spread_bps = min_spread
    if max_position is not None:
        settings.max_position_usdc = max_position
    if log_level:
        settings.log_level = LogLevel(log_level.upper())
    if tailscale is not None:
        settings.tailscale_enabled = tailscale

    # Setup logging
    setup_logging(settings)
    _banner(settings)

    # Live mode safety confirmation
    if settings.trading_mode == TradingMode.LIVE:
        missing = settings.validate_live_credentials()
        if missing:
            console.print(
                f"[red]Missing credentials for live trading: {', '.join(missing)}[/red]"
            )
            console.print("Set them in .env or use --mode paper")
            sys.exit(1)

        console.print("[red bold]WARNING: LIVE TRADING MODE[/red bold]")
        console.print(f"  Max position: ${settings.max_position_usdc}")
        console.print(f"  Max exposure: ${settings.max_total_exposure_usdc}")
        console.print(f"  Stop-loss: ${settings.stop_loss_usdc}")
        console.print()
        if not click.confirm("Proceed with live trading?"):
            console.print("Aborted.")
            sys.exit(0)

    # Run the bot with dashboard
    bot = ArbitrageBot(settings, dashboard_port=port)
    console.print(f"Dashboard: [cyan]http://localhost:{port}[/cyan]")
    console.print()
    try:
        asyncio.run(bot.run())
    except KeyboardInterrupt:
        console.print("\n[yellow]Interrupted — shutting down...[/yellow]")


@cli.command()
def config() -> None:
    """Show current bot configuration."""
    settings = Settings()

    table = Table(title="Bot Configuration", show_header=True)
    table.add_column("Setting", style="cyan")
    table.add_column("Value", style="white")

    table.add_row("Trading Mode", settings.trading_mode.value.upper())
    table.add_row("Min Spread", f"{settings.min_spread_bps} bps")
    table.add_row("Max Position", f"${settings.max_position_usdc}")
    table.add_row("Max Exposure", f"${settings.max_total_exposure_usdc}")
    table.add_row("Max Open Positions", str(settings.max_open_positions))
    table.add_row("Stop-Loss", f"${settings.stop_loss_usdc}")
    table.add_row("Maker Fee", f"{settings.maker_fee_bps} bps")
    table.add_row("Taker Fee", f"{settings.taker_fee_bps} bps")
    table.add_row("Trade Cooldown", f"{settings.trade_cooldown_seconds}s")
    table.add_row("Max Slippage", f"{settings.max_slippage_bps} bps")
    table.add_row("WebSocket Endpoint", settings.ws_endpoint)
    table.add_row("Tailscale Enabled", str(settings.tailscale_enabled))
    table.add_row("Tailscale Exit Node", settings.tailscale_exit_node or "(none)")
    table.add_row("Log Level", settings.log_level.value)
    table.add_row("Log File", settings.log_file)
    table.add_row(
        "API Key",
        "***" + settings.poly_api_key.get_secret_value()[-4:]
        if settings.poly_api_key.get_secret_value()
        else "(not set)",
    )
    table.add_row(
        "Private Key",
        "***configured" if settings.private_key.get_secret_value() else "(not set)",
    )

    console.print(table)


@cli.command()
def check() -> None:
    """Run pre-flight checks without starting the bot."""
    settings = Settings()
    setup_logging(settings)
    _banner(settings)

    checks_passed = True

    # Credential check
    console.print("[bold]Credential Check[/bold]")
    if settings.trading_mode == TradingMode.LIVE:
        missing = settings.validate_live_credentials()
        if missing:
            console.print(f"  [red]FAIL[/red] Missing: {', '.join(missing)}")
            checks_passed = False
        else:
            console.print("  [green]PASS[/green] All credentials configured")
    else:
        console.print("  [yellow]SKIP[/yellow] Paper mode — no credentials needed")

    # Tailscale check
    console.print("[bold]Tailscale Check[/bold]")
    if settings.tailscale_enabled:
        ts = TailscaleManager(exit_node=settings.tailscale_exit_node, enabled=True)
        available = asyncio.run(ts.check_available())
        if available:
            console.print("  [green]PASS[/green] Tailscale CLI available")
        else:
            console.print("  [red]FAIL[/red] Tailscale CLI not found or daemon not running")
            checks_passed = False
    else:
        console.print("  [yellow]SKIP[/yellow] Tailscale disabled")

    # API connectivity check
    console.print("[bold]API Connectivity[/bold]")
    try:
        import aiohttp

        async def _check_api() -> bool:
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    "https://gamma-api.polymarket.com/markets?limit=1",
                    timeout=aiohttp.ClientTimeout(total=10),
                ) as resp:
                    return resp.status == 200

        ok = asyncio.run(_check_api())
        if ok:
            console.print("  [green]PASS[/green] Gamma API reachable")
        else:
            console.print("  [red]FAIL[/red] Gamma API returned error")
            checks_passed = False
    except Exception as e:
        console.print(f"  [red]FAIL[/red] {e}")
        checks_passed = False

    console.print()
    if checks_passed:
        console.print("[green bold]All checks passed.[/green bold]")
    else:
        console.print("[red bold]Some checks failed — review above.[/red bold]")
        sys.exit(1)


def main() -> None:
    cli()


if __name__ == "__main__":
    main()
