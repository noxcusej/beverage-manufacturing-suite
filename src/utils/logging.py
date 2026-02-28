"""
Structured logging setup using structlog + rich.
"""

from __future__ import annotations

import logging
import sys

import structlog
from rich.console import Console
from rich.logging import RichHandler

from src.core.config import Settings


def setup_logging(settings: Settings) -> structlog.stdlib.BoundLogger:
    """Configure structured logging for the bot."""
    settings.ensure_log_dir()

    log_level = getattr(logging, settings.log_level.value)

    # Rich console handler for pretty terminal output
    console = Console(stderr=True)
    handlers: list[logging.Handler] = [
        RichHandler(
            console=console,
            show_time=True,
            show_path=False,
            markup=True,
            rich_tracebacks=True,
            tracebacks_show_locals=False,
        )
    ]

    # Optional file handler
    if settings.log_file:
        file_handler = logging.FileHandler(settings.log_file)
        file_handler.setFormatter(
            logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s")
        )
        handlers.append(file_handler)

    logging.basicConfig(
        level=log_level,
        handlers=handlers,
        force=True,
    )

    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.stdlib.filter_by_level,
            structlog.stdlib.add_logger_name,
            structlog.stdlib.add_log_level,
            structlog.stdlib.PositionalArgumentsFormatter(),
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            structlog.stdlib.ProcessorFormatter.wrap_for_formatter,
        ],
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.stdlib.BoundLogger,
        cache_logger_on_first_use=True,
    )

    return structlog.get_logger("arb-bot")
