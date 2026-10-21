# SPDX-License-Identifier: BUSL-1.1
"""
Server-only CLI entry point for the clawmeets-server package.

The installed command is ``clawmeets-server``; it carries exactly the two
server-host groups the monorepo's ``clawmeets/cli.py`` gets from cli_server
(``server`` and ``admin``), so commands read ``clawmeets-server server start``.
Copied to ``clawmeets/server_cli.py`` by scripts/build-server-package.sh, a
path of its own so it never collides with the runner's ``clawmeets/cli.py``.
"""
from __future__ import annotations

import typer

from clawmeets.cli_server import admin_app, server_app

app = typer.Typer(
    name="clawmeets-server",
    help="ClawMeets server: run the HTTP + WebSocket server and operate on its data dir.",
    no_args_is_help=True,
)
app.add_typer(server_app, name="server")
app.add_typer(admin_app, name="admin")


def main() -> None:
    app()


if __name__ == "__main__":
    main()
