#!/bin/sh
# SPDX-License-Identifier: BUSL-1.1
#
# ClawMeets one-command install.
#
#   curl -fsSL https://clawmeets.ai/install | sh -s <token>
#
# Served by GET /install (clawmeets/server/routes/install.py), which substitutes
# @@CLAWMEETS_SERVER@@ with this deployment's public URL before sending it. The
# file under review and the bytes piped into sh are the same file.
#
# ## What it does, and why in this order
#
#   1. install     uv, then the two clawmeets packages
#   2. link        exchange the one-time token for a saved session (no password),
#                  then create the shared storage folder all agents share
#   3. assistant   register the account's assistant
#   3b. providers  one agent per signed-in model CLI and per pasted API key
#                  (asks on the terminal; a failure here does not stop the install)
#   4. computer     link this machine and set it to reconnect at login
#   5. start       bring the agents online
#   6. check       `clawmeets doctor` — the one definition of "working"
#
# Each step reports to the server before and after it runs, so the web app shows
# real progress rather than a spinner. A step that FAILS reports the failure with
# its reason and stops — the web app then shows where it stopped and why, which
# is the whole point: the old path failed silently in three or four places.
#
# ## POSIX sh, not bash
#
# It arrives through `sh -s`, so there are no arrays, no `local`, no `[[ ]]`, and
# no `pipefail`. Tested against dash as well as bash-as-sh.
#
# ## Idempotent on purpose
#
# Re-running is a normal thing to do after fixing one broken step, so every step
# tolerates already-done: packages are only touched when they are missing or
# older than this server needs, re-registering your own assistant is an upsert
# on the server, the computer step reuses a key the server still accepts, and
# doctor is read-only. The ONE thing that is not repeatable is the token, which
# is single-use for the session exchange — a second run needs a fresh command
# from the web app.
#
# ## Safe on a computer that already has other accounts
#
# The account this run signs in is passed BY NAME to every later step, so the
# computer's default account (the one `clawmeets start` acts on without
# --user) is never consulted, and is only set when there was none. Identity
# left in the shell by another account, or by an agent's own process, is
# cleared first. CLAWMEETS_DATA_DIR is kept on purpose: it is how one computer
# keeps test, staging and prod side by side.
#
# ## Where the software comes from
#
#   sh -s <token>                                     PyPI (production)
#   sh -s <token> --git-repo URL [--git-ref BRANCH]   built from a branch (staging)
#   sh -s <token> --local PATH                        editable install of a checkout (dev)
#
# The software is shared by every account on this computer, so the source chosen
# applies to all of them and the closing message says so. A plain run never
# replaces an editable install, so a dev machine is not quietly put back on PyPI.

set -eu

SERVER="@@CLAWMEETS_SERVER@@"

# Python floor. 3.11 specifically, not "latest": patchright (browser stealth)
# ships no 3.14 wheels, so a 3.14 install either fails to resolve or silently
# drops browser support. Same pin as the bootstrap skill.
PYTHON_VERSION="3.11"

RUNNER_PKG="clawmeets"
COMPUTER_PKG="clawmeets-daemon"

# The oldest releases that understand every flag this script passes. Older is
# upgraded; newer is left alone, because the same install serves every account
# on this computer and replacing it under their running agents is not this
# run's business.
MIN_RUNNER="1.3.1"
MIN_COMPUTER="0.1.4"

# uv puts console scripts here. Exported up front because every step below calls
# a binary that has just been installed into it, and the shell running this
# script does not inherit a PATH change made by the installer.
export PATH="$HOME/.local/bin:$PATH"

# Identity from whatever shell runs this must not leak into a new account's
# setup: a terminal an agent started carries that agent's token, and a shell
# set up for another account carries its server.
unset CLAWMEETS_ASSISTANT_TOKEN CLAWMEETS_USER_TOKEN CLAWMEETS_SERVER_URL \
      CLAWMEETS_AGENT_TOKEN CLAWMEETS_AGENT_ID

DATA_DIR="${CLAWMEETS_DATA_DIR:-$HOME/.clawmeets}"

# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
    C_DIM=$(printf '\033[2m'); C_OK=$(printf '\033[32m')
    C_ERR=$(printf '\033[31m'); C_OFF=$(printf '\033[0m')
else
    C_DIM=''; C_OK=''; C_ERR=''; C_OFF=''
fi

say()  { printf '%s\n' "$*"; }
step() { printf '  %s… %s%s\n' "$C_DIM" "$*" "$C_OFF"; }
ok()   { printf '  %s✓%s %s\n' "$C_OK" "$C_OFF" "$*"; }
warn() { printf '  %s!%s %s\n' "$C_ERR" "$C_OFF" "$*"; }

fail() {
    warn "$1"
    exit 1
}

# A wrong command line. Exit 2, and always before anything is installed or the
# token is used, so the same command works once it is corrected.
usage() {
    warn "$1"
    say "      Usage: sh -s <token> [--git-repo URL [--git-ref BRANCH] | --local PATH]"
    exit 2
}

# ---------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------

TOKEN="${1:-}"
[ $# -gt 0 ] && shift

case "$TOKEN" in
    ""|-*)
        say ""
        usage "No install token. Copy the whole command from ClawMeets in your browser — the token comes right after 'sh -s'."
        ;;
esac

GIT_REPO=""; GIT_REF=""; LOCAL=""
while [ $# -gt 0 ]; do
    case "$1" in
        --git-repo|--git-ref|--local)
            [ $# -ge 2 ] && [ -n "$2" ] || usage "$1 needs a value."
            case "$1" in
                --git-repo) GIT_REPO="$2" ;;
                --git-ref)  GIT_REF="$2" ;;
                --local)    LOCAL="$2" ;;
            esac
            shift 2
            ;;
        --git-repo=*) GIT_REPO="${1#*=}"; shift ;;
        --git-ref=*)  GIT_REF="${1#*=}"; shift ;;
        --local=*)    LOCAL="${1#*=}"; shift ;;
        *) usage "Unknown option: $1" ;;
    esac
done

if [ -n "$GIT_REPO" ] && [ -n "$LOCAL" ]; then
    usage "--git-repo and --local cannot be used together."
elif [ -n "$GIT_REF" ] && [ -z "$GIT_REPO" ]; then
    usage "--git-ref needs --git-repo."
elif [ -n "$GIT_REPO" ]; then
    SOURCE="git"
    GIT_REF="${GIT_REF:-main}"
    for _tool in git bash rsync; do
        command -v "$_tool" >/dev/null 2>&1 \
            || usage "--git-repo needs $_tool, which was not found. Install it and run the command again."
    done
elif [ -n "$LOCAL" ]; then
    SOURCE="local"
    # `~` is not expanded inside --local=~/x, and a typo here would otherwise
    # surface as a confusing uv error after the packages were half replaced.
    case "$LOCAL" in "~"/*) LOCAL="$HOME/${LOCAL#"~"/}" ;; esac
    [ -f "$LOCAL/pyproject.toml" ] && [ -d "$LOCAL/clawmeets" ] && [ -d "$LOCAL/clawmeets_daemon" ] \
        || usage "--local $LOCAL is not a ClawMeets checkout (expected pyproject.toml, clawmeets/ and clawmeets_daemon/ in it)."
    LOCAL=$(cd "$LOCAL" && pwd -P)
else
    SOURCE="pypi"
fi

# Steps run in a subshell (see run_step), so anything a step learns that a
# later part of the script needs is written here as `NAME=value` lines and
# read back once the step is done.
STATE_FILE=$(mktemp "${TMPDIR:-/tmp}/clawmeets-install.XXXXXX")
trap 'rm -f "$STATE_FILE"' EXIT
remember() {
    printf "%s='%s'\n" "$1" "$(printf '%s' "$2" | sed "s/'/'\\\\''/g")" >>"$STATE_FILE"
}

# ---------------------------------------------------------------------------
# Progress reporting
# ---------------------------------------------------------------------------

# Best-effort, always. A machine that cannot reach the server to REPORT is
# usually a machine that is about to fail the step anyway, and the step's own
# error is the better message; a reporting failure must never be the thing that
# stops an install that would otherwise have worked.
report() {
    _step="$1"; _state="$2"; _detail="${3:-}"
    [ -n "$TOKEN" ] || return 0
    # json_escape the detail: it carries command output, which contains quotes,
    # newlines and backslashes.
    _esc=$(printf '%s' "$_detail" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr '\n' ' ')
    curl -fsS -m 10 -X POST "$SERVER/install/progress" \
        -H 'Content-Type: application/json' \
        -d "{\"token\":\"$TOKEN\",\"step\":\"$_step\",\"state\":\"$_state\",\"detail\":\"$_esc\"}" \
        >/dev/null 2>&1 || true
}

# Run one step: announce it, run it, report the outcome, stop on failure.
#
# Output is captured rather than streamed so a failure can be REPORTED with its
# reason (the web app is the only place many users will look) and echoed locally.
# The cost is that a long step looks silent in the terminal; the web checklist is
# moving throughout, which is where this design puts the user's attention.
# Success leaves the output in $_out for the caller.
run_step() {
    _key="$1"; _label="$2"; shift 2
    step "$_label"
    report "$_key" started ""
    if _out=$("$@" 2>&1); then
        report "$_key" ok ""
        ok "$_label"
        return 0
    fi
    _tail=$(printf '%s' "$_out" | tail -n 12)
    report "$_key" failed "$_tail"
    warn "$_label — failed"
    printf '%s\n' "$_out" | sed 's/^/      /'
    say ""
    say "Fix the problem above and run the command again."
    say "Already fixed it? Get a fresh command from ClawMeets in your browser."
    exit 1
}

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

[ -n "$SERVER" ] || fail "This installer was served without a server URL. Tell whoever runs this ClawMeets server that CLAWMEETS_APP_URL is unset."

command -v curl >/dev/null 2>&1 || fail "curl is required and was not found."

case "$(uname -s 2>/dev/null || echo unknown)" in
    Darwin|Linux) ;;
    *)
        # Windows users reach this through Git Bash, where uname says MINGW/MSYS.
        # Not refused — uv and both packages work there — but the login-time
        # autostart does not, and saying so now beats discovering it after a
        # reboot.
        warn "This installer is tested on macOS and Linux. Continuing anyway."
        warn "Your agents will not restart automatically after a reboot on this system."
        ;;
esac

say ""
say "Setting up ClawMeets on this computer."
say ""

# ---------------------------------------------------------------------------
# 1. Install
# ---------------------------------------------------------------------------

# What uv has installed for a tool: its version ("" when not installed) and, for
# an editable install, the checkout it points at. Read from uv itself rather
# than from `clawmeets --version`, because the binary on PATH may belong to
# something else entirely.
tool_version() {
    uv tool list 2>/dev/null | sed -n "s/^$1 v\([^ ]*\).*/\1/p" | head -n 1
}
tool_editable_path() {
    _receipt="$(uv tool dir 2>/dev/null)/$1/uv-receipt.toml"
    [ -f "$_receipt" ] || return 0
    sed -n 's/.*editable = "\([^"]*\)".*/\1/p' "$_receipt" | head -n 1
}

# 0 when version $1 >= version $2 (numeric, dotted).
version_at_least() {
    [ "$(printf '%s\n%s\n' "$2" "$1" | sort -t. -k1,1n -k2,2n -k3,3n | head -n 1)" = "$2" ]
}

# Bring one PyPI package up to its floor without touching it otherwise.
ensure_released() {
    _pkg="$1"; _floor="$2"
    _have=$(tool_version "$_pkg")
    if [ -n "$_have" ] && version_at_least "$_have" "$_floor"; then
        echo "$_pkg $_have is already installed."
        return 0
    fi
    uv tool install --upgrade --python "$PYTHON_VERSION" "$_pkg>=$_floor" || return 1
    _now=$(tool_version "$_pkg")
    if [ -z "$_now" ] || ! version_at_least "$_now" "$_floor"; then
        echo "$_pkg $_floor or newer is needed, but ${_now:-nothing} was installed."
        return 1
    fi
    [ -n "$_have" ] && remember UPGRADED 1
    echo "$_pkg ${_have:+$_have -> }$_now"
}

install_from_pypi() {
    # An editable checkout belongs to a developer who chose it; a plain run
    # must not swap it for a release. It is not version-checked either: the
    # checkout's own version number is a placeholder.
    _dev=$(tool_editable_path "$RUNNER_PKG")
    if [ -n "$_dev" ]; then
        echo "Using your editable checkout at $_dev."
        remember SOURCE_DESC "your editable checkout at $_dev"
        return 0
    fi
    ensure_released "$RUNNER_PKG" "$MIN_RUNNER" || return 1
    # The connection software is its own package with three dependencies, so it
    # keeps working when the runner's dependency stack does not — which is
    # exactly when someone needs to see whether their computer is connected.
    ensure_released "$COMPUTER_PKG" "$MIN_COMPUTER" || return 1
}

# Staging: build both packages from a branch with the repo's own build scripts
# (the PyPI packages are assembled from an allow-list, not the repo's top-level
# project, so installing the repo directly would give the wrong thing). Always
# reinstalls: a branch build carries the last release's version string, so the
# floor cannot tell old code from new, and re-running is how a tester picks up
# the branch's latest commit. A private repo works through this machine's own
# git credentials; nothing is put in the script or the URL.
install_from_git() {
    _src=$(mktemp -d "${TMPDIR:-/tmp}/clawmeets-src.XXXXXX")
    trap 'rm -rf "$_src"' EXIT
    git clone -q --depth 1 --branch "$GIT_REF" "$GIT_REPO" "$_src/repo" || return 1
    # `uv run` so the build script's python3 is the managed interpreter, not
    # whatever this OS happens to have.
    uv run --no-project --python "$PYTHON_VERSION" \
        bash "$_src/repo/scripts/build-runner-package.sh" "$_src/runner" || return 1
    bash "$_src/repo/scripts/build-daemon-package.sh" "$_src/daemon" || return 1
    # Runner first: if it replaces an editable checkout, that also frees the
    # clawmeets-computer command the checkout provided.
    uv tool install --reinstall --python "$PYTHON_VERSION" "$_src/runner" || return 1
    uv tool install --reinstall --python "$PYTHON_VERSION" "$_src/daemon" || return 1
    remember UPGRADED 1
    remember SOURCE_DESC "$GIT_REPO@$GIT_REF ($(git -C "$_src/repo" rev-parse --short HEAD))"
}

# Dev: an editable install of a checkout, which provides clawmeets AND
# clawmeets-computer from one environment. Nothing to do when it is already
# this checkout: its code is live.
install_from_local() {
    remember SOURCE_DESC "your editable checkout at $LOCAL"
    if [ "$(tool_editable_path "$RUNNER_PKG")" = "$LOCAL" ]; then
        echo "Already using your editable checkout at $LOCAL."
        return 0
    fi
    # Two uv tools cannot own the same command, and the checkout now provides
    # clawmeets-computer.
    if [ -n "$(tool_version "$COMPUTER_PKG")" ]; then
        uv tool uninstall "$COMPUTER_PKG" || return 1
    fi
    uv tool install --reinstall --python "$PYTHON_VERSION" -e "$LOCAL" || return 1
    remember UPGRADED 1
}

# uv rather than the system Python, which is the point: it manages its own
# interpreter, so PEP 668 ("externally managed environment") never fires and
# whatever Python the machine happens to have is irrelevant.
install_everything() {
    if ! command -v uv >/dev/null 2>&1; then
        curl -LsSf https://astral.sh/uv/install.sh | sh || return 1
        export PATH="$HOME/.local/bin:$PATH"
    fi
    command -v uv >/dev/null 2>&1 || {
        echo "uv installed but is not on PATH. Open a new terminal and re-run."
        return 1
    }
    uv python install "$PYTHON_VERSION" || return 1
    case "$SOURCE" in
        git)   install_from_git ;;
        local) install_from_local ;;
        *)     install_from_pypi ;;
    esac || return 1
    command -v clawmeets >/dev/null 2>&1 || {
        echo "clawmeets installed but is not on PATH ($HOME/.local/bin)."
        return 1
    }
}

UPGRADED=""; SOURCE_DESC=""
run_step install "Installing ClawMeets" install_everything
# shellcheck disable=SC1090
. "$STATE_FILE"

# ---------------------------------------------------------------------------
# 2. Sign in
# ---------------------------------------------------------------------------

# The token is spent here, inside the CLI, so the session is written by the same
# code that `clawmeets user login` uses and nothing downstream can tell the two
# apart. No password is typed, echoed, or stored. It does not move the
# computer's default account when there already is one, and refuses (exit 3)
# when the same username is already set up here for a different server.
PREV_DEFAULT=$(cat "$DATA_DIR/config/current_user" 2>/dev/null || true)
run_step link "Signing in on this computer" \
    clawmeets user link "$TOKEN" --server "$SERVER"
ACCOUNT=$(printf '%s\n' "$_out" | sed -n 's/^account=//p' | tail -n 1)
[ -n "$ACCOUNT" ] || fail "Signed in, but the account name did not come back. Run: clawmeets doctor"

# Shared storage: one folder every agent on this computer can read and write
# ($AGENT_SHARED_STORAGE_DIR — each agent's home links to it as shared_storage/).
# Not a reported step: it is one mkdir, and the runner creates the same folder
# on every start, so a failure here must not stop the install.
mkdir -p "$DATA_DIR/shared_storage" 2>/dev/null || true

# Every later step names $ACCOUNT. None passes --server: each one uses the
# server saved with that account's session, which is the one it just signed in to.

# ---------------------------------------------------------------------------
# 2b. Default model
# ---------------------------------------------------------------------------

# The model config every new agent starts with: the model CLIs signed in here,
# and with two or more, whether to route between them and in what order. Runs
# BEFORE the assistant so the assistant gets it too. Like the providers step it
# reads the terminal directly (stdin is this piped script) and, with no
# terminal, chooses smart routing in the order found and says so. A failure
# never stops the install: agents then fall back to the server's own choice.
run_model_step() {
    step "Choosing your default model"
    report model started ""
    _rc=0
    if (exec </dev/tty) 2>/dev/null; then
        clawmeets model-default setup --as-user "$ACCOUNT" </dev/tty || _rc=$?
    else
        clawmeets model-default setup --as-user "$ACCOUNT" --no-ask </dev/null || _rc=$?
    fi
    if [ "$_rc" -eq 0 ]; then
        report model ok ""
        ok "Choosing your default model"
    else
        report model failed "The default model was not saved."
        warn "Choosing your default model — not saved."
        say "      Run 'clawmeets model-default setup --as-user $ACCOUNT' later to choose it."
    fi
}

run_model_step

# ---------------------------------------------------------------------------
# 3. Assistant
# ---------------------------------------------------------------------------

# Exit code only. Re-registering your own assistant succeeds on the server, so
# a re-run gets here fine; anything that says "already" is a real failure
# (another account owns the name).
run_step assistant "Setting up your assistant" \
    clawmeets assistant register --username "$ACCOUNT"

# ---------------------------------------------------------------------------
# 3b. Model provider agents
# ---------------------------------------------------------------------------

# One agent per signed-in model CLI, plus one per API key the user pastes.
# NOT run through run_step: run_step captures output, which would hide the key
# prompt. stdin is this piped script, so the prompt reads the terminal directly;
# with no terminal (CI, ssh without -t) it skips the keys. A failure is reported
# but never stops the install: the assistant is already set up.
run_providers_step() {
    step "Connecting your model providers"
    report providers started ""
    _rc=0
    if (exec </dev/tty) 2>/dev/null; then
        clawmeets agent provider register --as-user "$ACCOUNT" </dev/tty || _rc=$?
    else
        clawmeets agent provider register --as-user "$ACCOUNT" --no-ask-keys </dev/null || _rc=$?
    fi
    if [ "$_rc" -eq 0 ]; then
        report providers ok ""
        ok "Connecting your model providers"
    else
        report providers failed "Some model agents were not registered."
        warn "Connecting your model providers — some were not registered."
        say "      Run 'clawmeets agent provider register --as-user $ACCOUNT' later to retry or to add API keys."
    fi
}

run_providers_step

# ---------------------------------------------------------------------------
# 4. This computer
# ---------------------------------------------------------------------------

# No --code: the CLI mints its own pairing code from the session step 2 just
# saved — or, on a re-run, reuses the key the server still accepts. Autostart is
# on by default, which is the single change that makes most "my agents are
# offline" reports disappear — almost nobody stops their agents on purpose, they
# reboot.
run_step computer "Connecting this computer" \
    clawmeets computer install --user "$ACCOUNT"

# ---------------------------------------------------------------------------
# 5. Start
# ---------------------------------------------------------------------------

run_step start "Starting your agents" clawmeets start --user "$ACCOUNT"

# ---------------------------------------------------------------------------
# 6. Check
# ---------------------------------------------------------------------------

# Which other accounts on this computer still have something running — after an
# upgrade, those processes are on the old code until restarted.
others_running() {
    for _cfg in "$DATA_DIR"/config/*/; do
        _user=$(basename "$_cfg")
        [ "$_user" = "$ACCOUNT" ] && continue
        for _pidf in "$DATA_DIR/computer/$_user/computer.pid" "$DATA_DIR/agents/$_user"-*/agent.pid; do
            [ -f "$_pidf" ] || continue
            _pid=$(cat "$_pidf" 2>/dev/null || true)
            if [ -n "$_pid" ] && kill -0 "$_pid" 2>/dev/null; then
                printf '%s\n' "$_user"
                break
            fi
        done
    done
}

closing() {
    say "Set up $ACCOUNT on $SERVER."
    _default=$(cat "$DATA_DIR/config/current_user" 2>/dev/null || true)
    if [ "$_default" = "$ACCOUNT" ]; then
        say "This computer's default account is $ACCOUNT."
    else
        say "This computer's default account is still ${_default:-$PREV_DEFAULT}."
        say "Add --user $ACCOUNT to clawmeets commands for the new account."
    fi
    if [ -n "$SOURCE_DESC" ]; then
        say "ClawMeets on this computer runs from $SOURCE_DESC, for every account."
        say "To go back to the released version: uv tool install --reinstall $RUNNER_PKG && uv tool install --reinstall $COMPUTER_PKG"
    fi
    if [ -n "$UPGRADED" ]; then
        for _other in $(others_running); do
            say "ClawMeets was updated. $_other's agents and computer connection still run the old version until you run:"
            say "  clawmeets computer stop --user $_other && clawmeets computer start --user $_other"
            say "  clawmeets stop --user $_other && clawmeets start --user $_other"
        done
    fi
}

# Deliberately NOT run through run_step. Doctor's non-zero exit means "something
# in your setup needs attention", which is a different thing from "this installer
# broke" — most often a model CLI that is installed but not signed in, which no
# installer can fix and which doctor explains better than anything here could.
# So: report the outcome, print doctor's own output, and exit 0 either way.
step "Checking everything works"
report check started ""
say ""
if doctor_out=$(clawmeets doctor --user "$ACCOUNT" --server "$SERVER" 2>&1); then
    report check ok ""
    printf '%s\n' "$doctor_out"
    say ""
    closing
    say ""
    say "Done. Open ClawMeets in your browser — your agents are ready."
else
    report check failed "$(printf '%s' "$doctor_out" | tail -n 20)"
    printf '%s\n' "$doctor_out"
    say ""
    closing
    say ""
    say "ClawMeets is installed. Fix the item(s) above, then run: clawmeets doctor --user $ACCOUNT"
fi
say ""
