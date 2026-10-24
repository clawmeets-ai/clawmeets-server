# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/cli_server.py

Server-side CLI commands for clawmeets.

Commands
--------
  server init               Initialize server (dirs, bootstrap user, reserved usernames)
  server start              Start the HTTP + WebSocket server
  server stop               Stop the running server (via PID file)
  server reset              Reset server (stop processes, remove all data)
  server hub register       Register this server with the ClawMeets Hub (--reclaim: under a new key)
  server hub verify         Check the hub's key chain; with --code, confirm the registration email
  server hub status         Show the hub settings, trust and registration (read-only, no network)
  admin reset-passwd        Reset the bootstrap "admin" account's password
  admin generate-invitation-codes  Generate self-registration invitation codes
  admin create-user         Create (or reset) a pre-verified user account
  admin list-users          List user accounts
  admin verify-agent        Mark an agent's card verified
  admin unverify-agent      Clear an agent's verified mark

Every ``admin`` command is a server-host operation: it reads and writes the
server data dir (``--data-dir``) directly and never talks HTTP. There is no
admin account and no admin API — whoever can run these can already read the
data dir. Accounts are plain users; the passwd ``role`` field is legacy and
ignored by the server.

This module imports no runner CLI (cli_runner, cli_skill, cli_client): it is
the entry point of the server tree (scripts/build-server-package.sh), which
does not ship them. The client-side groups (project / chatroom / message /
file) live in clawmeets/cli_client.py and skill / schedule in
clawmeets/cli_skill.py; clawmeets/cli.py registers them from there.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import signal
import subprocess
import sys
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Optional

import bcrypt
import typer
import uvicorn

from clawmeets.api.fs_protocol import FS_WS_MAX_SIZE
from clawmeets.cli_lifecycle import DEFAULT_DATA_DIR, _popen_detached_kwargs, _read_pid, _stop_pid
from clawmeets.models.agent import Agent
from clawmeets.models.context import ModelContext
from clawmeets.models.desk_todo import BACKFILL_SEED_IDS, SEED, backfill_starter_todos
from clawmeets.models.invitation_code import generate_codes
from clawmeets.models.user import EMAIL_PROOF_OPERATOR, User
from clawmeets.utils.file_io import FileUtil
from clawmeets.utils.notification_center import NotificationCenter
from clawmeets.server.app import create_app
from clawmeets.server.channels.config import HubConfigError
from clawmeets.server.channels.log_redaction import install_webhook_log_redaction
from clawmeets.server.hub import operator as hub_operator

# Sub-command groups
server_app   = typer.Typer(help="Server commands", no_args_is_help=True)
admin_app    = typer.Typer(
    help="Server-host operator commands (operate on --data-dir directly; no HTTP, no admin account)",
    no_args_is_help=True,
)

hub_app      = typer.Typer(
    help="Register this server with the ClawMeets Hub (operates on --data-dir directly; "
         "uses the server's environment, so run it with the server's env file loaded)",
    no_args_is_help=True,
)
server_app.add_typer(hub_app, name="hub")

# Username of the bootstrap account `server init` / `admin reset-passwd` create.
# It is an ordinary user — the name is just how those commands find it again.
BOOTSTRAP_USERNAME = "admin"

# Where the clawmeets-server wheel carries the skill and MCP catalogs
# (scripts/build-server-package.sh copies skills/ and mcps/ here). A monorepo
# checkout has none and finds them at the repo root instead.
BUNDLED_CATALOG_DIR = Path(__file__).parent / "_catalog"


# The module the detached `server start` re-runs itself as: the server wheel's
# own entry point (clawmeets/server_cli.py), which it has instead of the
# monorepo's clawmeets/cli.py.
def _cli_module() -> str:
    return "clawmeets.server_cli" if (Path(__file__).parent / "server_cli.py").exists() else "clawmeets.cli"


# The agent catalog's directory: $CLAWMEETS_AGENT_POOL_DIR, else the monorepo's
# agents/ (a checkout with setup.json at its root). The retired --templates-dir
# / $CLAWMEETS_TEMPLATES_DIR are still read for one release, with a warning.
def resolve_agent_pool_dir(legacy_templates_dir: Optional[Path] = None) -> Optional[Path]:
    env = os.environ.get("CLAWMEETS_AGENT_POOL_DIR")
    if env:
        return Path(env)
    legacy = legacy_templates_dir or (
        Path(os.environ["CLAWMEETS_TEMPLATES_DIR"]) if os.environ.get("CLAWMEETS_TEMPLATES_DIR") else None
    )
    if legacy is not None:
        logging.getLogger("clawmeets.server").warning(
            "--templates-dir / CLAWMEETS_TEMPLATES_DIR are deprecated and will be removed: "
            "use --agent-pool-dir / CLAWMEETS_AGENT_POOL_DIR (a clawmeets-agents checkout)"
        )
        return legacy
    candidate = Path(__file__).parent.parent / "agents"
    return candidate if (candidate / "setup.json").is_file() else None


# The skills/ or mcps/ registry dir the server loads: the env var if set, else
# the monorepo's <repo>/<name>/, else the copy bundled in the server wheel.
# None when neither holds a registry.json (the catalog is then empty).
def resolve_registry_dir(env_var: str, name: str) -> Optional[Path]:
    env = os.environ.get(env_var)
    if env:
        return Path(env)
    for candidate in (Path(__file__).parent.parent / name, BUNDLED_CATALOG_DIR / name):
        if (candidate / "registry.json").exists():
            return candidate
    return None


def _print_json(data: dict | list) -> None:
    typer.echo(json.dumps(data, indent=2, default=str))


# ---------------------------------------------------------------------------
# server start
# ---------------------------------------------------------------------------

@server_app.command("start")
def server_start(
    host: str = typer.Option("0.0.0.0", help="Bind host"),
    port: int = typer.Option(int(os.environ.get("CLAWMEETS_BIND_SERVER_PORT", "4567")), help="Bind port"),
    data_dir: Path = typer.Option(DEFAULT_DATA_DIR, help="Root data directory (server data lives in {data_dir}/server/)"),
    batch_timeout: int = typer.Option(1800, "--batch-timeout", help="Batch timeout in seconds (default: 1800)"),
    skills_dir: Optional[Path] = typer.Option(None, "--skills-dir", help="Skills registry directory"),
    mcps_dir: Optional[Path] = typer.Option(None, "--mcps-dir", help="MCP server registry directory"),
    agent_pool_dir: Optional[Path] = typer.Option(
        None, "--agent-pool-dir",
        help="A clawmeets-agents checkout: the agent catalog (default $CLAWMEETS_AGENT_POOL_DIR, "
             "else the monorepo's agents/; none in the clawmeets-server wheel)",
    ),
    templates_dir: Optional[Path] = typer.Option(None, "--templates-dir", hidden=True),
    announcements_file: Optional[Path] = typer.Option(None, "--announcements-file", help="announcements.json path (default: the repo-root file)"),
    log_level: str = typer.Option("info", help="Log level"),
    foreground: bool = typer.Option(False, "--foreground", "-f", help="Run uvicorn in this process (blocking). Default spawns a detached background process and returns immediately; use --foreground for Docker / systemd."),
):
    """Start the clawmeets HTTP + WebSocket server.

    By default spawns a detached background process and returns — matches
    `clawmeets start` semantics, so `&` is no longer needed. Pass
    --foreground to block (for Docker / systemd / manual Ctrl-C runs).
    """
    data_dir_p = Path(data_dir).expanduser()
    server_dir = data_dir_p / "server"
    server_dir.mkdir(parents=True, exist_ok=True)
    pid_file = server_dir / "server.pid"

    existing = _read_pid(pid_file)
    if existing is not None:
        typer.echo(f"Error: server already running (PID {existing}). Stop it first with `clawmeets server stop`.", err=True)
        raise typer.Exit(1)

    # Resolve skills_dir / mcps_dir up front so both the parent and the
    # spawned foreground child see identical values (the child is launched
    # without our cwd, so relying on its auto-detection would be fragile).
    if skills_dir is None:
        skills_dir = resolve_registry_dir("CLAWMEETS_SKILLS_DIR", "skills")
    if mcps_dir is None:
        mcps_dir = resolve_registry_dir("CLAWMEETS_MCPS_DIR", "mcps")
    if agent_pool_dir is None:
        agent_pool_dir = resolve_agent_pool_dir(templates_dir)

    # Left as None when unset: announcements.py resolves the repo-root default
    # itself, so an absent override is not the same as an absent file.
    if announcements_file is None:
        env_announcements = os.environ.get("CLAWMEETS_ANNOUNCEMENTS_FILE")
        if env_announcements:
            announcements_file = Path(env_announcements)

    if not foreground:
        # Spawn the foreground variant as a detached subprocess and return.
        cmd = [
            sys.executable, "-m", _cli_module(), "server", "start",
            "--foreground",
            "--host", host,
            "--port", str(port),
            "--data-dir", str(data_dir),
            "--batch-timeout", str(batch_timeout),
            "--log-level", log_level,
        ]
        if skills_dir:
            cmd.extend(["--skills-dir", str(skills_dir)])
        if mcps_dir:
            cmd.extend(["--mcps-dir", str(mcps_dir)])
        if agent_pool_dir:
            cmd.extend(["--agent-pool-dir", str(agent_pool_dir)])
        if announcements_file:
            cmd.extend(["--announcements-file", str(announcements_file)])

        stdout_log = server_dir / "stdout.log"
        stderr_log = server_dir / "stderr.log"
        stdout_fp = open(stdout_log, "w")
        stderr_fp = open(stderr_log, "w")
        proc = subprocess.Popen(
            cmd, stdout=stdout_fp, stderr=stderr_fp, **_popen_detached_kwargs()
        )

        # Wait up to ~5s for the child to write its PID file (meaning it
        # finished app setup and is about to call uvicorn.run), or to die
        # on a startup error like port-in-use.
        ready = False
        for _ in range(50):
            time.sleep(0.1)
            if proc.poll() is not None:
                break
            if _read_pid(pid_file) is not None:
                ready = True
                break

        if proc.poll() is not None:
            rc = proc.returncode
            tail: list[str] = []
            if stderr_log.exists():
                try:
                    tail = stderr_log.read_text().splitlines()[-10:]
                except OSError:
                    pass
            typer.echo(f"Error: server exited with code {rc} before startup completed.", err=True)
            if tail:
                typer.echo("  Last stderr:", err=True)
                for line in tail:
                    typer.echo(f"    {line}", err=True)
            typer.echo(f"  Full logs: {stderr_log}", err=True)
            raise typer.Exit(1)

        typer.echo(f"Started clawmeets server on {host}:{port} (PID {proc.pid}, data={server_dir})")
        if skills_dir:
            typer.echo(f"  Skills registry: {skills_dir}")
        if mcps_dir:
            typer.echo(f"  MCP registry: {mcps_dir}")
        if agent_pool_dir:
            typer.echo(f"  Agent pool: {agent_pool_dir}")
        if announcements_file:
            typer.echo(f"  Announcements: {announcements_file}")
        typer.echo(f"  Logs:  {stdout_log}")
        typer.echo(f"         {stderr_log}")
        if not ready:
            typer.echo("  Warning: server did not report ready within 5s; check logs.", err=True)
        typer.echo("  Stop with: clawmeets server stop")
        return

    # --- Foreground path: block on uvicorn in the current process ---
    logging.basicConfig(level=log_level.upper())
    typer.echo(f"Starting clawmeets server on {host}:{port}, data={server_dir}")
    if skills_dir:
        typer.echo(f"Skills registry: {skills_dir}")
    if mcps_dir:
        typer.echo(f"MCP registry: {mcps_dir}")
    if agent_pool_dir:
        typer.echo(f"Agent pool: {agent_pool_dir}")
    if announcements_file:
        typer.echo(f"Announcements: {announcements_file}")

    try:
        fast_app = create_app(
            server_dir,
            batch_timeout=batch_timeout,
            skills_dir=skills_dir,
            mcps_dir=mcps_dir,
            agent_pool_dir=agent_pool_dir,
            announcements_path=announcements_file,
        )
    except HubConfigError as exc:
        # CLAWMEETS_HUB_MODE is not off and the hub settings are invalid: the
        # server must not start. Set the mode to off to start without the hub.
        typer.echo(f"Error: the hub configuration is invalid, so the server will not start: {exc}", err=True)
        typer.echo("  Fix the setting(s) named above, or set CLAWMEETS_HUB_MODE=off.", err=True)
        raise typer.Exit(1)

    # Before uvicorn starts logging requests: webhook query strings (which can
    # carry provider secrets) never reach the access log, channels on or off.
    install_webhook_log_redaction()

    pid_file.write_text(str(os.getpid()))
    try:
        # ws_max_size explicit: the home-folder relay's frame caps are sized
        # against it (api/fs_protocol.py).
        uvicorn.run(fast_app, host=host, port=port, log_level=log_level, ws_max_size=FS_WS_MAX_SIZE)
    finally:
        pid_file.unlink(missing_ok=True)


@server_app.command("stop")
def server_stop(
    data_dir: Path = typer.Option(DEFAULT_DATA_DIR, "--data-dir", help="Root data directory (PID file at {data_dir}/server/server.pid)"),
):
    """Stop the running clawmeets server (reads PID from {data_dir}/server/server.pid)."""
    pid_file = Path(data_dir).expanduser() / "server" / "server.pid"
    if _stop_pid(pid_file, "server"):
        typer.echo("Server stopped.")
    else:
        typer.echo("Server was not running.")


# ---------------------------------------------------------------------------
# server ws-edge
# ---------------------------------------------------------------------------

@server_app.command("ws-edge")
def server_ws_edge(
    port: int = typer.Option(8090, "--port", help="Public websocket port (runners, browsers, computers, terminals)"),
    host: str = typer.Option("127.0.0.1", "--host", help="Public bind host"),
    link_host: str = typer.Option("127.0.0.1", "--link-host", help="Bind host of the loopback link core dials"),
    link_port: int = typer.Option(8091, "--link-port", help="Port of the loopback link core dials"),
    data_dir: Path = typer.Option(DEFAULT_DATA_DIR, "--data-dir", help="Root data directory (server data lives in {data_dir}/server/; terminal audit lines are written under it)"),
    log_level: str = typer.Option("info", "--log-level", help="Log level"),
):
    """Run the websocket edge in the foreground (for systemd / Docker).

    Holds every public websocket so the core server can restart without
    dropping one; core dials the edge's loopback link. Foreground only —
    run it under a supervisor. Needs CLAWMEETS_EDGE_LINK_SECRET (core's
    Bearer on the link) and CLAWMEETS_JWT_SECRET (the same secret core
    signs user tokens and terminal tickets with).
    """
    link_secret = os.environ.get("CLAWMEETS_EDGE_LINK_SECRET", "")
    jwt_secret = os.environ.get("CLAWMEETS_JWT_SECRET", "")
    missing = [
        name for name, value in (
            ("CLAWMEETS_EDGE_LINK_SECRET", link_secret),
            ("CLAWMEETS_JWT_SECRET", jwt_secret),
        ) if not value
    ]
    if missing:
        typer.echo(
            f"Error: {' and '.join(missing)} must be set. The edge and core must "
            "share both: core's JWT secret is random per process unless set, and "
            "the edge cannot check user tokens or terminal tickets without it.",
            err=True,
        )
        raise typer.Exit(1)

    # Imported here: nothing else in this module needs the edge.
    from clawmeets.ws_edge.app import EdgeConfig, EdgeServer

    server_dir = Path(data_dir).expanduser() / "server"
    server_dir.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(level=log_level.upper())
    typer.echo(f"Starting clawmeets ws-edge on {host}:{port} (link {link_host}:{link_port}), data={server_dir}")
    edge = EdgeServer(EdgeConfig(
        data_dir=server_dir,
        jwt_secret=jwt_secret,
        link_secret=link_secret,
        public_host=host,
        public_port=port,
        link_host=link_host,
        link_port=link_port,
        log_level=log_level,
    ))
    asyncio.run(edge.serve_forever())


@server_app.command("init")
def server_init(
    data_dir: Path = typer.Option(DEFAULT_DATA_DIR, "--data-dir", help="Root data directory (server data goes into {data_dir}/server/, runner agents into {data_dir}/agents/)"),
    admin_password: Optional[str] = typer.Option(None, "--admin-password", help="Password for the bootstrap \"admin\" account"),
    reserved_usernames: Optional[str] = typer.Option(None, "--reserved-usernames", help="Comma-separated list of usernames to reserve"),
    google_oauth_credentials: Optional[Path] = typer.Option(
        None, "--google-oauth-credentials",
        help="Path to a Google OAuth installed-app client secrets JSON (downloaded "
             "from Google Cloud Console). Copied to {server_dir}/google_oauth_client.json "
             "at 0600 so MCP servers like Gmail and Google Calendar can use a shared "
             "deployment-wide OAuth client.",
    ),
):
    """Initialize server: create directories, the bootstrap user, and reserve usernames.

    The bootstrap account is named "admin" but is an ordinary user with no
    special powers.

    Env var overrides (when CLI flags not set):
      CLAWMEETS_ADMIN_PASSWORD           Bootstrap account password (default: "clawmeets")
      CLAWMEETS_RESERVED_USERNAMES       Comma-separated usernames to reserve
      CLAWMEETS_GOOGLE_OAUTH_CREDENTIALS Path to the Google OAuth client secrets JSON
    """
    data_dir = Path(data_dir).expanduser()
    server_dir = data_dir / "server"

    # Resolve bootstrap password: CLI flag > env var > default
    if admin_password is None:
        admin_password = os.environ.get("CLAWMEETS_ADMIN_PASSWORD", "clawmeets")

    # Resolve reserved usernames: CLI flag > env var > none
    reserved: list[str] = []
    if reserved_usernames is not None:
        reserved = [n.strip() for n in reserved_usernames.split(",") if n.strip()]
    else:
        env_reserved = os.environ.get("CLAWMEETS_RESERVED_USERNAMES", "")
        if env_reserved:
            reserved = [n.strip() for n in env_reserved.split(",") if n.strip()]

    # Resolve Google OAuth credentials path: CLI flag > env var > none
    if google_oauth_credentials is None:
        env_oauth = os.environ.get("CLAWMEETS_GOOGLE_OAUTH_CREDENTIALS", "")
        if env_oauth:
            google_oauth_credentials = Path(env_oauth).expanduser()

    # 1. Create directories
    (server_dir / "agents").mkdir(parents=True, exist_ok=True)
    (server_dir / "projects").mkdir(parents=True, exist_ok=True)
    (data_dir / "agents").mkdir(parents=True, exist_ok=True)  # runner agents (sibling to server/)
    typer.echo(f"Directories initialized: {server_dir}")

    # 2. Init passwd with the bootstrap account (skip if exists)
    passwd_file = server_dir / "passwd"
    if passwd_file.exists():
        typer.echo("Passwd file already exists, skipping bootstrap user creation.")
    else:
        user_id = str(uuid.uuid4())
        password_hash = bcrypt.hashpw(admin_password.encode(), bcrypt.gensalt()).decode()
        data = {"users": {user_id: _bootstrap_entry(user_id, password_hash)}}
        FileUtil.write(passwd_file, data, "json")
        typer.echo(f"Created bootstrap user {BOOTSTRAP_USERNAME!r}.")

    # 3. Reserve usernames
    if reserved:
        passwd_data = FileUtil.read(passwd_file, "json") or {"users": {}}
        existing = {u["username"] for u in passwd_data["users"].values()}
        count = 0
        for name in reserved:
            if name not in existing:
                uid = str(uuid.uuid4())
                passwd_data["users"][uid] = {
                    "id": uid,
                    "username": name,
                    "role": "user",
                    "password_hash": "!reserved",
                    "created_at": datetime.now(UTC).isoformat(),
                    "email": f"{name}@clawmeets.ai",
                    "email_verified": False,
                }
                count += 1
        if count:
            FileUtil.write(passwd_file, passwd_data, "json")
            typer.echo(f"Reserved {count} username(s).")

    # 4. Install Google OAuth client secrets (if provided)
    if google_oauth_credentials is not None:
        src = google_oauth_credentials.expanduser()
        if not src.exists():
            typer.echo(
                f"Error: Google OAuth credentials file not found: {src}",
                err=True,
            )
            raise typer.Exit(1)
        try:
            parsed = json.loads(src.read_text())
        except json.JSONDecodeError as e:
            typer.echo(f"Error: {src} is not valid JSON: {e}", err=True)
            raise typer.Exit(1)
        # Google's OAuth downloads wrap the client in either "installed" or "web"
        # depending on the application type; anything else is probably the wrong
        # file. Validate early so operators don't discover this at runner-auth time.
        if not any(key in parsed for key in ("installed", "web")):
            typer.echo(
                f"Error: {src} does not look like a Google OAuth client secrets file "
                f"(expected a top-level 'installed' or 'web' object).",
                err=True,
            )
            raise typer.Exit(1)

        dest = server_dir / "google_oauth_client.json"
        action = "updated" if dest.exists() else "installed"
        dest.write_text(src.read_text())
        os.chmod(dest, 0o600)
        typer.echo(f"Google OAuth credentials {action}: {dest} (mode 0600)")

    typer.echo("Server initialization complete.")


@server_app.command("reset")
def server_reset(
    data_dir: Path = typer.Option(DEFAULT_DATA_DIR, "--data-dir", help="Top-level data directory to remove"),
    force: bool = typer.Option(False, "--force", "-f", help="Skip confirmation prompt"),
):
    """Reset server: stop processes and remove all data.

    Removes the entire data directory (server data, agent data, projects).
    """
    data_dir = Path(data_dir).expanduser()

    if not data_dir.exists():
        typer.echo(f"Data directory does not exist: {data_dir}")
        return

    if not force:
        confirm = typer.confirm(f"This will remove {data_dir} and all its contents. Continue?")
        if not confirm:
            typer.echo("Aborted.")
            raise typer.Exit(0)

    # Stop processes by finding .pid files
    for pid_file in data_dir.rglob("*.pid"):
        try:
            pid = int(pid_file.read_text().strip())
            os.kill(pid, signal.SIGTERM)
            typer.echo(f"Stopped process {pid} ({pid_file.name})")
        except (ValueError, ProcessLookupError, PermissionError):
            pass
        pid_file.unlink(missing_ok=True)

    shutil.rmtree(data_dir)
    typer.echo(f"Removed {data_dir}")
    typer.echo("Reset complete.")


# ---------------------------------------------------------------------------
# admin — server-host operator commands (direct --data-dir access, no HTTP)
# ---------------------------------------------------------------------------


def _bootstrap_entry(user_id: str, password_hash: str) -> dict:
    """The passwd row `server init` / `admin reset-passwd` write for the
    bootstrap account. ``role`` is a legacy field kept for file-format
    compatibility; the server ignores it, so it is always ``"user"``."""
    return {
        "id": user_id,
        "username": BOOTSTRAP_USERNAME,
        "role": "user",
        "password_hash": password_hash,
        "created_at": datetime.now(UTC).isoformat(),
        "email": f"{BOOTSTRAP_USERNAME}@clawmeets.ai",
        "email_verified": True,
        "email_proven_by": EMAIL_PROOF_OPERATOR,
        "verification_token": None,
    }


def _server_model_ctx(data_dir: Path) -> ModelContext:
    """A ModelContext over ``{data_dir}/server`` — the same base the running
    server hands ``create_app``, so User / Agent reads and writes here land in
    exactly the files the server reads."""
    server_dir = Path(data_dir).expanduser() / "server"
    if not server_dir.is_dir():
        typer.echo(f"Error: server data dir not found: {server_dir}. Run 'server init' first.", err=True)
        raise typer.Exit(1)
    return ModelContext(base_dir=server_dir, notification_center=NotificationCenter())


@admin_app.command("reset-passwd")
def admin_reset_passwd(
    password: str = typer.Argument(..., help="New password for the bootstrap \"admin\" account"),
    data_dir: Path = typer.Option(DEFAULT_DATA_DIR, "--data-dir", help="Root data directory (passwd file at {data_dir}/server/passwd)"),
):
    """Reset the bootstrap "admin" account's password (creates passwd file if needed).

    The account is an ordinary user; to reset any other user's password use
    `clawmeets admin create-user <username> <password>`.
    """
    passwd_file = Path(data_dir).expanduser() / "server" / "passwd"
    password_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()

    if passwd_file.exists():
        passwd_data = FileUtil.read(passwd_file, "json") or {"users": {}}
        entry = next(
            (u for u in passwd_data["users"].values() if u.get("username") == BOOTSTRAP_USERNAME),
            None,
        )
        if entry is None:
            typer.echo(f"Error: user {BOOTSTRAP_USERNAME!r} not found in passwd file.", err=True)
            raise typer.Exit(1)
        entry["password_hash"] = password_hash
        FileUtil.write(passwd_file, passwd_data, "json")
        typer.echo(f"Password reset for {BOOTSTRAP_USERNAME!r}.")
    else:
        user_id = str(uuid.uuid4())
        data = {"users": {user_id: _bootstrap_entry(user_id, password_hash)}}
        FileUtil.write(passwd_file, data, "json")
        typer.echo(f"Created passwd file with user {BOOTSTRAP_USERNAME!r} at {passwd_file}")


@admin_app.command("generate-invitation-codes")
def admin_generate_invitation_codes(
    count: int = typer.Argument(..., help="Number of invitation codes to generate"),
    password: str = typer.Option(..., "--password", "-p", prompt=True, hide_input=True, help="Password of the bootstrap \"admin\" account"),
    allowed_usage_count: int = typer.Option(1, "--allowed-usage-count", "-n", help="Number of times each code can be used"),
    data_dir: Path = typer.Option(DEFAULT_DATA_DIR, "--data-dir", help="Root data directory (server data at {data_dir}/server/)"),
):
    """Generate invitation codes for user self-registration (offline, no server required)."""
    server_dir = Path(data_dir).expanduser() / "server"
    passwd_file = server_dir / "passwd"
    if not passwd_file.exists():
        typer.echo("Error: passwd file not found. Run 'server init' first.", err=True)
        raise typer.Exit(1)

    # Confirm the operator knows the bootstrap account's password.
    data = FileUtil.read(passwd_file, "json") or {}
    entry = next(
        (u for u in data.get("users", {}).values() if u.get("username") == BOOTSTRAP_USERNAME),
        None,
    )
    if entry is None:
        typer.echo(f"Error: user {BOOTSTRAP_USERNAME!r} not found in passwd file.", err=True)
        raise typer.Exit(1)

    if not bcrypt.checkpw(password.encode(), entry["password_hash"].encode()):
        typer.echo("Error: invalid password.", err=True)
        raise typer.Exit(1)

    codes = generate_codes(count, server_dir, allowed_usage_count=allowed_usage_count)
    suffix = f" (allowed uses: {allowed_usage_count})" if allowed_usage_count > 1 else ""
    typer.echo(f"Generated {count} invitation code(s){suffix}:")
    for code in codes:
        typer.echo(f"  {code}")


@admin_app.command("create-user")
def admin_create_user(
    username: str = typer.Argument(..., help="Username (lowercase)"),
    password: str = typer.Argument(..., help="Password"),
    email: Optional[str] = typer.Option(None, "--email", "-e", help="User email address"),
    data_dir: Path = typer.Option(DEFAULT_DATA_DIR, "--data-dir", help="Root data directory (passwd file at {data_dir}/server/passwd)"),
):
    """Create a pre-verified user account (no email verification needed).

    If the username already exists, its password is reset and its email marked
    verified instead. The assistant agent is created later with
    `clawmeets assistant register` on the user's machine. Safe to run while
    the server is up: the server re-reads the passwd file on every lookup.
    """
    ctx = _server_model_ctx(data_dir)

    async def _run() -> tuple[User, bool]:
        try:
            user = await User.register(
                username, password, ctx, email=email, email_verified=True,
                email_proven_by=EMAIL_PROOF_OPERATOR,
            )
            return user, True
        except ValueError as e:
            existing = User.get_by_username(username, ctx)
            if existing is None:
                typer.echo(f"Error: {e}", err=True)
                raise typer.Exit(1)
            await existing.change_password(password)
            if not existing.email_proven:
                await existing.set_email_verified(True, proven_by=EMAIL_PROOF_OPERATOR)
            return existing, False

    user, created = asyncio.run(_run())
    verb = "Created" if created else "Updated existing"
    typer.echo(f"{verb} user: {user.username} (id={user.id})")
    if created:
        typer.echo("Run `clawmeets assistant register` (as that user) to create the assistant agent.")


@admin_app.command("list-users")
def admin_list_users(
    data_dir: Path = typer.Option(DEFAULT_DATA_DIR, "--data-dir", help="Root data directory (passwd file at {data_dir}/server/passwd)"),
    as_json: bool = typer.Option(False, "--json", help="Print the user records as JSON"),
    unverified: bool = typer.Option(False, "--unverified", help="Only accounts whose email is not verified yet (they cannot sign in)"),
):
    """List user accounts from the server's passwd file."""
    ctx = _server_model_ctx(data_dir)
    users = sorted((u.to_dict() for u in User.list_all(ctx)), key=lambda u: u["username"])
    if unverified:
        users = [u for u in users if not u.get("email_verified")]
    if as_json:
        _print_json(users)
        return
    if not users:
        typer.echo("No users.")
        return
    for u in users:
        verified = "verified" if u.get("email_verified") else "unverified"
        typer.echo(f"  {u['username']:20s}  id={u['id']}  {u.get('email') or '-'}  ({verified})")


@admin_app.command("verify-user")
def admin_verify_user(
    username: str = typer.Argument(..., help="Username of the account to activate"),
    data_dir: Path = typer.Option(DEFAULT_DATA_DIR, "--data-dir", help="Root data directory (passwd file at {data_dir}/server/passwd)"),
):
    """Mark an account's email verified so it can sign in.

    For a server with no mail service: a new account cannot sign in until its
    email is verified, and without SendGrid the verification link only appears
    in the server log. Safe to run while the server is up.
    """
    ctx = _server_model_ctx(data_dir)
    user = User.get_by_username(username, ctx)
    if user is None:
        typer.echo(f"Error: no user named {username!r}", err=True)
        raise typer.Exit(1)
    # A trusted-domain account is verified but unproven; the operator's word
    # upgrades it, so a later Google/GitHub sign-in for the address can link.
    if user.email_proven:
        typer.echo(f"{user.username} is already verified.")
        return
    asyncio.run(user.set_email_verified(True, proven_by=EMAIL_PROOF_OPERATOR))
    typer.echo(f"verified {user.username} ({user.email or 'no email'})")


@admin_app.command("backfill-starter-todos")
def admin_backfill_starter_todos(
    data_dir: Path = typer.Option(DEFAULT_DATA_DIR, "--data-dir", help="Root data directory (plates under {data_dir}/server/desk-todos/)"),
    apply: bool = typer.Option(False, "--apply", help="Write the changes. Without it this is a read-only dry-run."),
):
    """Give every existing account's saved plate each starter to-do added
    after launch ("Add a thinking partner for big decisions", "Get the best
    answer from all my models combined"), each one once.

    Manual and one-time: nothing runs this on server start. The default is a
    read-only dry-run that may run while the server is up. --apply refuses
    while the server is running, because plate writes are serialized by a lock
    inside the server process that this command cannot share. An account that
    already got an item — including one that has since deleted it — is never
    given that item again, and an account with no saved plate is left to the
    new-account seed.
    """
    ctx = _server_model_ctx(data_dir)
    server_dir = ctx.participants_dir
    live = _read_pid(server_dir / "server.pid")
    if apply and live is not None:
        typer.echo(
            f"Refusing --apply: the server is running (PID {live}). "
            "Stop it first: clawmeets server stop",
            err=True,
        )
        raise typer.Exit(1)
    if live is not None:
        typer.echo(f"Note: the server is running (PID {live}); dry-run counts may drift.")

    user_ids = [u.id for u in User.list_all(ctx)]
    report = backfill_starter_todos(server_dir, user_ids, apply=apply)
    titles = [str(r["text"]) for r in SEED if r["id"] in BACKFILL_SEED_IDS]
    typer.echo(f"starter to-dos: {'; '.join(titles)}")
    typer.echo(f"accounts scanned: {len(user_ids)}")
    typer.echo(f"{'added' if apply else 'would add'}: {len(report.would_add)}")
    unreadable = (
        f", unreadable plate: {len(report.skipped_unreadable)}"
        if report.skipped_unreadable else ""
    )
    typer.echo(
        f"skipped: {report.skipped}  (already given: "
        f"{len(report.skipped_already_given)}, no saved plate: "
        f"{len(report.skipped_no_plate)}{unreadable})"
    )
    if not apply:
        typer.echo("dry-run: nothing written; re-run with --apply to write")


def _set_agent_verified(agent_ref: str, data_dir: Path, verified: bool) -> None:
    """Flip ``is_verified`` on an agent card through the same model code the
    server reads it with (``Agent.verify`` / ``Agent.unverify``)."""
    ctx = _server_model_ctx(data_dir)
    agent = Agent.get(agent_ref, ctx) or Agent.get_by_name(agent_ref, ctx)
    if agent is None:
        typer.echo(f"Error: agent {agent_ref!r} not found.", err=True)
        raise typer.Exit(1)
    if verified:
        agent.verify()
    else:
        agent.unverify()
    _print_json({
        "status": "verified" if verified else "unverified",
        "agent_id": agent.id,
        "agent_name": agent.name,
    })


@admin_app.command("verify-agent")
def admin_verify_agent(
    agent: str = typer.Argument(..., help="Agent ID or full agent name"),
    data_dir: Path = typer.Option(DEFAULT_DATA_DIR, "--data-dir", help="Root data directory (agent cards under {data_dir}/server/agents/)"),
):
    """Mark an agent verified (sets is_verified=true on its card)."""
    _set_agent_verified(agent, data_dir, True)


@admin_app.command("unverify-agent")
def admin_unverify_agent(
    agent: str = typer.Argument(..., help="Agent ID or full agent name"),
    data_dir: Path = typer.Option(DEFAULT_DATA_DIR, "--data-dir", help="Root data directory (agent cards under {data_dir}/server/agents/)"),
):
    """Clear an agent's verified mark (sets is_verified=false on its card)."""
    _set_agent_verified(agent, data_dir, False)


# ---------------------------------------------------------------------------
# server hub — this deployment's registration with the ClawMeets Hub
# ---------------------------------------------------------------------------
#
# Thin printers over clawmeets/server/hub/operator.py, which holds every rule.
# Exit codes: 0 ok, 1 internal, 2 usage, 3 hub off / config invalid, 4 hub
# untrusted, 5 local state forbids it, 6 the hub refused, 7 hub unreachable,
# 8 outcome unknown (rotate: the server took the request but its answer never
# came; run `server hub status`).
# With --json, stdout carries exactly one JSON object, errors included
# ({"ok": false, "error": {"code", "message"}}); otherwise errors go to stderr
# as "Error: <code>: <message>".

_DATA_DIR_HELP = "Root data directory (the server's channels.db is under {data_dir}/server/channels/)"
_JSON_HELP = "Print one JSON object on stdout"


def _hub_emit(json_out: bool, call, human) -> None:
    try:
        result = call()
    except hub_operator.OperatorError as exc:
        _hub_fail(json_out, exc)
    except Exception as exc:  # noqa: BLE001 — the type only: a message could quote a secret
        _hub_fail(json_out, hub_operator.OperatorError(1, "internal", f"unexpected {type(exc).__name__}"))
    if json_out:
        typer.echo(json.dumps(result.to_json(), ensure_ascii=False))
    else:
        human(result)


def _hub_fail(json_out: bool, exc: "hub_operator.OperatorError") -> None:
    if json_out:
        typer.echo(json.dumps(exc.to_json(), ensure_ascii=False))
    else:
        typer.echo(f"Error: {exc.code}: {exc.message}", err=True)
        if exc.retry_after is not None:
            typer.echo(f"  Retry after {exc.retry_after} s.", err=True)
    raise typer.Exit(exc.exit_code)


def _hub_server_dir(data_dir: Path) -> Path:
    return Path(data_dir).expanduser() / "server"


@hub_app.command("register")
def hub_register(
    name: str = typer.Option(..., "--name", help="Deployment name on the hub (3-63 of a-z 0-9 . -)"),
    email: str = typer.Option(..., "--email", help="Operator contact email; the hub sends a confirmation code"),
    label: Optional[str] = typer.Option(None, "--label", help="Display label (default: the name)"),
    public_url: Optional[str] = typer.Option(None, "--public-url", help="This server's public https URL (optional)"),
    accept_tos: bool = typer.Option(False, "--accept-tos", help=f"Accept the hub's terms ({hub_operator.TOS_URL})"),
    reclaim: bool = typer.Option(False, "--reclaim", help="Register again under a NEW identity key (confirmed by email)"),
    data_dir: Path = typer.Option(DEFAULT_DATA_DIR, "--data-dir", help=_DATA_DIR_HELP),
    json_out: bool = typer.Option(False, "--json", help=_JSON_HELP),
):
    """Register this server with the hub, or reclaim its registration under a new key.

    While the registration waits for its email code, running this again with
    the same --name sends a fresh code (to this --email)."""
    if not accept_tos:
        _hub_fail(json_out, hub_operator.OperatorError(
            2, "usage",
            f"read the hub's terms at {hub_operator.TOS_URL} and pass --accept-tos to accept "
            f"them (version {hub_operator.TOS_VERSION})",
        ))

    def human(result: "hub_operator.RegisterResult") -> None:
        verb = "Reclaimed" if result.reclaimed else "Registered"
        typer.echo(f"{verb} {result.name} with {result.hub_url} (deployment {result.deployment_id}).")
        typer.echo(f"  Status:       {result.status}")
        typer.echo(f"  Identity key: {hub_operator.fp_tail(result.fingerprint)}")
        if result.status == "pending_email":
            typer.echo(f"  Check {email} for a code, then run: clawmeets server hub verify --code <code>")
        typer.echo(f"  {hub_operator.RESTART_HINT}")

    _hub_emit(json_out, lambda: hub_operator.register(
        _hub_server_dir(data_dir), name=name, email=email, label=label,
        public_url=public_url, reclaim=reclaim,
    ), human)


@hub_app.command("verify")
def hub_verify(
    code: Optional[str] = typer.Option(None, "--code", help="The code from the hub's email (optional)"),
    data_dir: Path = typer.Option(DEFAULT_DATA_DIR, "--data-dir", help=_DATA_DIR_HELP),
    json_out: bool = typer.Option(False, "--json", help=_JSON_HELP),
):
    """Check the hub's key chain against the pinned keys; with --code, confirm the email."""

    def human(result: "hub_operator.VerifyResult") -> None:
        typer.echo(f"Hub key chain for {result.hub_url}: ok")
        if result.added_kids:
            typer.echo(f"  New hub keys trusted: {', '.join(result.added_kids)}")
        if result.purged_kids:
            typer.echo(f"  Withdrawn hub keys removed: {', '.join(result.purged_kids)}")
        typer.echo(f"  Registration: {result.status}")
        if result.code_submitted:
            typer.echo(f"  {hub_operator.RESTART_HINT}")

    _hub_emit(json_out, lambda: hub_operator.verify(_hub_server_dir(data_dir), code=code), human)


@hub_app.command("rotate")
def hub_rotate(
    timeout: float = typer.Option(30.0, "--timeout", help="Seconds to wait for the running server"),
    data_dir: Path = typer.Option(DEFAULT_DATA_DIR, "--data-dir", help=_DATA_DIR_HELP),
    json_out: bool = typer.Option(False, "--json", help=_JSON_HELP),
):
    """Rotate this server's identity key (chained). The running server does it on its own hub socket."""

    def human(result: "hub_operator.RotateResult") -> None:
        typer.echo(f"Rotated the identity key of deployment {result.deployment_id} on {result.hub_url}.")
        typer.echo(f"  New key:  {hub_operator.fp_tail(result.fingerprint)}")
        typer.echo(f"  Re-signed {result.resigned} waiting message(s); conversations keep their root.")

    _hub_emit(json_out, lambda: hub_operator.rotate(_hub_server_dir(data_dir), timeout_s=timeout), human)


@hub_app.command("revoke")
def hub_revoke(
    yes: bool = typer.Option(False, "--yes", help="Confirm: revoke this server's identity key at the hub"),
    data_dir: Path = typer.Option(DEFAULT_DATA_DIR, "--data-dir", help=_DATA_DIR_HELP),
    json_out: bool = typer.Option(False, "--json", help=_JSON_HELP),
):
    """Revoke this server's identity key at the hub (if it was stolen). Needs no running server."""
    if not yes:
        _hub_fail(json_out, hub_operator.OperatorError(
            2, "usage",
            "this revokes the server's identity key at the hub and every key rotated from it; the hub "
            "stops routing for this server until 'clawmeets server hub register --reclaim' under a new "
            "key, confirmed by email. Pass --yes to do it",
        ))

    def human(result: "hub_operator.RevokeResult") -> None:
        tails = ", ".join(hub_operator.fp_tail(f) or "" for f in result.revoked)
        typer.echo(f"Revoked at {result.hub_url}: {tails}")
        typer.echo(f"  Registration: {result.status}")
        typer.echo("  Next: clawmeets server hub register --reclaim --name <name> --email <email> --accept-tos")

    _hub_emit(json_out, lambda: hub_operator.revoke(_hub_server_dir(data_dir)), human)


@hub_app.command("status")
def hub_status(
    data_dir: Path = typer.Option(DEFAULT_DATA_DIR, "--data-dir", help=_DATA_DIR_HELP),
    json_out: bool = typer.Option(False, "--json", help=_JSON_HELP),
):
    """Show the hub settings, trust and registration. Read-only; never contacts the hub."""

    def human(report: "hub_operator.StatusReport") -> None:
        trust_notes = {
            "placeholder": " (only a placeholder key is pinned in this release: this server will not connect)",
            "none": " (no hub key configured)",
        }
        typer.echo(f"Hub mode:      {report.mode}")
        typer.echo(f"Hub URL:       {report.hub_url or '(invalid)'}{' (default)' if report.hub_url_is_default else ''}")
        typer.echo(f"Trust:         {report.trust}{trust_notes.get(report.trust, '')}")
        if report.trusted_kids:
            typer.echo(f"  Trusted keys: {', '.join(report.trusted_kids)}")
        if report.revoked_kids:
            typer.echo(f"  Withdrawn keys: {', '.join(report.revoked_kids)}")
        reg = report.registration
        typer.echo(f"Registration:  {reg['status']}")
        for key in ("deployment_id", "name", "label", "public_url", "genesis_fp", "current_fp"):
            if reg.get(key):
                typer.echo(f"  {key}: {reg[key]}")
        typer.echo(f"Hub link:      {report.hub_link}")
        if report.last_connected_at:
            when = datetime.fromtimestamp(report.last_connected_at, UTC).isoformat(timespec="seconds")
            typer.echo(f"  Last connected: {when}")
        rows = ", ".join(f"{n} {state}" for state, n in report.open_hub_rows.items()) or "none"
        typer.echo(f"Open hub rows: {rows}")
        for problem in report.config_problems:
            typer.echo(f"Problem: {problem}")
        for warning in report.warnings:
            typer.echo(f"Warning: {warning}")
        if report.db_problem:
            typer.echo(f"Problem: {report.db_problem}")

    _hub_emit(json_out, lambda: hub_operator.status(_hub_server_dir(data_dir)), human)
