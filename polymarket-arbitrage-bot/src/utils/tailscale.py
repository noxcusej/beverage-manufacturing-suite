"""
Tailscale VPN integration via the tailscale CLI.

Ensures traffic is routed through a Tailscale exit node before
the bot connects to external APIs. This provides IP rotation
and geographic flexibility.
"""

from __future__ import annotations

import asyncio
import shutil

import structlog

log = structlog.get_logger("tailscale")


class TailscaleManager:
    """Manages Tailscale exit node routing via the CLI."""

    def __init__(self, exit_node: str = "", enabled: bool = False):
        self.exit_node = exit_node
        self.enabled = enabled
        self._original_exit_node: str | None = None
        self._cli_path: str | None = None

    async def _run_cmd(self, *args: str) -> tuple[int, str, str]:
        """Execute a tailscale CLI command."""
        cli = self._cli_path or "tailscale"
        proc = await asyncio.create_subprocess_exec(
            cli, *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await proc.communicate()
        return proc.returncode or 0, stdout.decode().strip(), stderr.decode().strip()

    async def check_available(self) -> bool:
        """Check if tailscale CLI is available and the daemon is running."""
        self._cli_path = shutil.which("tailscale")
        if not self._cli_path:
            log.warning("tailscale_cli_not_found", hint="Install tailscale or add to PATH")
            return False

        rc, stdout, stderr = await self._run_cmd("status", "--json")
        if rc != 0:
            log.warning("tailscale_not_running", error=stderr)
            return False

        log.info("tailscale_available", cli=self._cli_path)
        return True

    async def get_current_status(self) -> dict[str, str]:
        """Get current tailscale status."""
        rc, stdout, _ = await self._run_cmd("status")
        if rc != 0:
            return {"status": "error"}
        return {"status": "connected", "details": stdout[:500]}

    async def get_current_exit_node(self) -> str | None:
        """Get the currently active exit node, if any."""
        rc, stdout, _ = await self._run_cmd("exit-node", "list")
        if rc != 0:
            return None
        # Parse for the selected node (marked with *)
        for line in stdout.splitlines():
            if "selected" in line.lower() or "*" in line:
                parts = line.split()
                if parts:
                    return parts[0]
        return None

    async def set_exit_node(self, node: str) -> bool:
        """Route traffic through a specific exit node."""
        log.info("setting_exit_node", node=node)
        rc, stdout, stderr = await self._run_cmd(
            "set", f"--exit-node={node}"
        )
        if rc != 0:
            log.error("exit_node_failed", node=node, error=stderr)
            return False
        log.info("exit_node_set", node=node)
        return True

    async def clear_exit_node(self) -> bool:
        """Remove exit node routing (direct connection)."""
        log.info("clearing_exit_node")
        rc, _, stderr = await self._run_cmd("set", "--exit-node=")
        if rc != 0:
            log.error("clear_exit_node_failed", error=stderr)
            return False
        return True

    async def setup(self) -> bool:
        """
        Initialize Tailscale VPN routing for the bot.
        Returns True if traffic is being routed through an exit node.
        """
        if not self.enabled:
            log.info("tailscale_disabled")
            return True  # Not an error — just not using VPN

        available = await self.check_available()
        if not available:
            log.error("tailscale_required_but_unavailable")
            return False

        # Save current exit node so we can restore on shutdown
        self._original_exit_node = await self.get_current_exit_node()

        if not self.exit_node:
            log.warning("no_exit_node_configured", hint="Set TAILSCALE_EXIT_NODE in .env")
            return True  # Use whatever routing is currently active

        success = await self.set_exit_node(self.exit_node)
        if not success:
            return False

        # Verify connectivity
        rc, stdout, _ = await self._run_cmd("ping", "--c=1", self.exit_node)
        if rc != 0:
            log.warning("exit_node_ping_failed", node=self.exit_node)
            # Don't fail — the node might not respond to pings but still route traffic

        log.info("tailscale_ready", exit_node=self.exit_node)
        return True

    async def teardown(self) -> None:
        """Restore original exit node routing on shutdown."""
        if not self.enabled:
            return

        if self._original_exit_node:
            await self.set_exit_node(self._original_exit_node)
            log.info("tailscale_restored", original_node=self._original_exit_node)
        else:
            await self.clear_exit_node()
            log.info("tailscale_cleared")

    async def verify_ip(self) -> str | None:
        """Check the current public IP via tailscale."""
        rc, stdout, _ = await self._run_cmd("ip", "-4")
        if rc == 0 and stdout:
            log.info("tailscale_ip", ip=stdout.splitlines()[0])
            return stdout.splitlines()[0]
        return None
