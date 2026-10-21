# SPDX-License-Identifier: BUSL-1.1
#
# ClawMeets one-command install, Windows edition.
#
#   & ([scriptblock]::Create((irm https://clawmeets.ai/install.ps1))) <token>
#
# Served by GET /install.ps1 (clawmeets/server/routes/install.py), which
# substitutes @@CLAWMEETS_SERVER@@ with this deployment's public URL before
# sending it. The file under review and the bytes the user runs are the same
# file.
#
# The PowerShell twin of install.sh: the same steps, in the same order, reporting
# the same step keys to the same progress route, so the web app cannot tell which
# of the two is running. Read install.sh for WHY each step exists; this header
# only covers what is different on Windows.
#
# ## A scriptblock, not `irm | iex`
#
# `irm … | iex` cannot pass an argument, and the token has to arrive somehow. A
# scriptblock can take one, and creating one from a string is not subject to the
# execution policy (that applies to script FILES), so no policy change is asked
# of the user.
#
# ## Never `exit`
#
# This runs inside the user's own PowerShell session. `exit` would close their
# window and take the error message with it. Failures `throw`; the one catch at
# the bottom prints the reason and returns.
#
# ## Developer Mode is checked first
#
# The runner creates symbolic links when agents start, which Windows allows only
# for administrators or with Developer Mode on. Without it `clawmeets start` dies
# with WinError 1314 at step five — after the token is spent. Checked before
# anything is installed, so the remedy arrives while re-running is still free.
#
# ## No start-at-login
#
# `clawmeets computer install` reports that autostart is unsupported on Windows
# and carries on; the closing message tells the user what to run after a reboot.
#
# ## Safe on a computer that already has other accounts
#
# Same rules as install.sh: the account `clawmeets user link` signs in is passed
# BY NAME to every later step, so the computer's default account is never acted
# on; identity left in the shell is cleared first; and the shared install is
# only upgraded when it is older than this server needs, never when it is an
# editable checkout.
#
# ## Windows PowerShell 5.1 compatible
#
# The PowerShell every Windows 10/11 machine has. No ternaries, no `??`, no
# `&&`, ASCII-only output (5.1's console mangles UTF-8 check marks).

param([string]$Token = '')

$Server = '@@CLAWMEETS_SERVER@@'
# Same pin as install.sh: patchright ships no 3.14 wheels.
$PythonVersion = '3.11'
$RunnerPkg = 'clawmeets'
$ComputerPkg = 'clawmeets-daemon'
$UvBin = Join-Path $HOME '.local\bin'
# Same floors as install.sh, and for the same reason: older is upgraded, newer
# is left alone because every account on this computer runs from it.
$MinRunner = '1.3.1'
$MinComputer = '0.1.4'

# Identity from whatever shell runs this must not leak into a new account's
# setup (see install.sh). Process scope only; the user's own settings are untouched.
foreach ($var in @('CLAWMEETS_ASSISTANT_TOKEN', 'CLAWMEETS_USER_TOKEN', 'CLAWMEETS_SERVER_URL',
                   'CLAWMEETS_AGENT_TOKEN', 'CLAWMEETS_AGENT_ID')) {
    Remove-Item -Path "Env:$var" -ErrorAction SilentlyContinue
}

$DataDir = $env:CLAWMEETS_DATA_DIR
if (-not $DataDir) { $DataDir = Join-Path $HOME '.clawmeets' }

# What Install-Everything learned, for the closing message.
$script:Upgraded = $false
$script:SourceDesc = ''

# Older Windows PowerShell defaults to TLS 1.0, which the progress route refuses.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072

# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

function Say([string]$Text) { Write-Host $Text }
function Step([string]$Text) { Write-Host "  ... $Text" -ForegroundColor DarkGray }
function Ok([string]$Text) { Write-Host '  ok ' -ForegroundColor Green -NoNewline; Write-Host $Text }
function Warn([string]$Text) { Write-Host '  !  ' -ForegroundColor Red -NoNewline; Write-Host $Text }

# ---------------------------------------------------------------------------
# Progress reporting — best-effort, always (see install.sh)
# ---------------------------------------------------------------------------

function Send-Progress([string]$Key, [string]$State, [string]$Detail = '') {
    if (-not $Token) { return }
    $body = @{ token = $Token; step = $Key; state = $State; detail = $Detail } | ConvertTo-Json -Compress
    try {
        Invoke-RestMethod -Method Post -Uri "$Server/install/progress" -ContentType 'application/json' `
            -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 10 | Out-Null
    } catch { }
}

# Run a native command and capture everything it printed. $ErrorActionPreference
# is relaxed for the call because 5.1 turns a native program's stderr into
# terminating errors under 'Stop', and plenty of CLIs log progress to stderr.
function Invoke-Native([scriptblock]$Command) {
    $saved = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $global:LASTEXITCODE = 0
        $out = & $Command 2>&1 | ForEach-Object { "$_" }
        return @{ Ok = ($LASTEXITCODE -eq 0); Output = ($out -join "`n") }
    } catch {
        return @{ Ok = $false; Output = "$_" }
    } finally {
        $ErrorActionPreference = $saved
    }
}

# Announce, run, report, stop on failure — install.sh's run_step. Success
# returns the step's output.
function Invoke-Step([string]$Key, [string]$Label, [scriptblock]$Body) {
    Step $Label
    Send-Progress $Key started
    $result = & $Body
    if ($result.Ok) {
        Send-Progress $Key ok
        Ok $Label
        return $result.Output
    }
    $tail = (($result.Output -split "`n") | Select-Object -Last 12) -join "`n"
    Send-Progress $Key failed $tail
    Warn "$Label - failed"
    ($result.Output -split "`n") | ForEach-Object { Write-Host "      $_" }
    throw 'STEP_FAILED'
}

function Refresh-Path {
    if (($env:Path -split ';') -notcontains $UvBin) { $env:Path = "$UvBin;$env:Path" }
}

function Test-Command([string]$Name) {
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

function Test-CanSymlink {
    $key = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock'
    $dev = (Get-ItemProperty -Path $key -Name AllowDevelopmentWithoutDevLicense -ErrorAction SilentlyContinue).AllowDevelopmentWithoutDevLicense
    if ($dev -eq 1) { return $true }
    $identity = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    return $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# ---------------------------------------------------------------------------
# Steps
# ---------------------------------------------------------------------------

# What uv has installed for a tool: its version ('' when not installed) and,
# for an editable install, the checkout it points at (see install.sh).
function Get-ToolVersion([string]$Pkg) {
    $r = Invoke-Native { uv tool list }
    foreach ($line in ($r.Output -split "`n")) {
        if ($line -match ('^' + [regex]::Escape($Pkg) + ' v(\S+)')) { return $Matches[1] }
    }
    return ''
}

function Get-ToolEditablePath([string]$Pkg) {
    $r = Invoke-Native { uv tool dir }
    if (-not $r.Ok) { return '' }
    $receipt = Join-Path ($r.Output -split "`n" | Select-Object -Last 1).Trim() (Join-Path $Pkg 'uv-receipt.toml')
    if (-not (Test-Path $receipt)) { return '' }
    foreach ($line in (Get-Content $receipt)) {
        if ($line -match 'editable = "([^"]*)"') { return $Matches[1] }
    }
    return ''
}

# $true when dotted version $Have >= $Floor. Compared on the leading numbers,
# so a pre-release suffix ('1.3.0rc1') still compares.
function Test-VersionAtLeast([string]$Have, [string]$Floor) {
    $h = @($Have -split '\.' | ForEach-Object { if ($_ -match '^\d+') { [int]$Matches[0] } else { 0 } })
    $f = @($Floor -split '\.' | ForEach-Object { if ($_ -match '^\d+') { [int]$Matches[0] } else { 0 } })
    for ($i = 0; $i -lt [Math]::Max($h.Count, $f.Count); $i++) {
        $a = 0; if ($i -lt $h.Count) { $a = $h[$i] }
        $b = 0; if ($i -lt $f.Count) { $b = $f[$i] }
        if ($a -ne $b) { return ($a -gt $b) }
    }
    return $true
}

# Bring one PyPI package up to its floor without touching it otherwise.
function Install-Released([string]$Pkg, [string]$Floor) {
    $have = Get-ToolVersion $Pkg
    if ($have -and (Test-VersionAtLeast $have $Floor)) {
        return @{ Ok = $true; Output = "$Pkg $have is already installed." }
    }
    $r = Invoke-Native { uv tool install --upgrade --python $PythonVersion "$Pkg>=$Floor" }
    if (-not $r.Ok) { return $r }
    $now = Get-ToolVersion $Pkg
    if (-not $now -or -not (Test-VersionAtLeast $now $Floor)) {
        $got = $now; if (-not $got) { $got = 'nothing' }
        return @{ Ok = $false; Output = "$($r.Output)`n$Pkg $Floor or newer is needed, but $got was installed." }
    }
    if ($have) { $script:Upgraded = $true }
    return @{ Ok = $true; Output = "$Pkg $have -> $now" }
}

function Install-Everything {
    Refresh-Path
    if (-not (Test-Command uv)) {
        # A child process so uv's installer runs under its own policy without
        # changing the user's.
        $r = Invoke-Native { powershell -NoProfile -ExecutionPolicy ByPass -Command 'irm https://astral.sh/uv/install.ps1 | iex' }
        if (-not $r.Ok) { return $r }
        Refresh-Path
    }
    if (-not (Test-Command uv)) {
        return @{ Ok = $false; Output = "uv installed but is not on PATH. Open a new PowerShell window and re-run." }
    }
    $r = Invoke-Native { uv python install $PythonVersion }
    if (-not $r.Ok) { return $r }
    # An editable checkout belongs to a developer who chose it; it is neither
    # replaced nor version-checked (its version number is a placeholder).
    $dev = Get-ToolEditablePath $RunnerPkg
    if ($dev) {
        $script:SourceDesc = "your editable checkout at $dev"
    } else {
        foreach ($pkg in @(@($RunnerPkg, $MinRunner), @($ComputerPkg, $MinComputer))) {
            $r = Install-Released $pkg[0] $pkg[1]
            if (-not $r.Ok) { return $r }
        }
    }
    if (-not (Test-Command clawmeets)) {
        return @{ Ok = $false; Output = "clawmeets installed but is not on PATH ($UvBin)." }
    }
    return @{ Ok = $true; Output = '' }
}

# Not through Invoke-Step: capturing output would hide the API-key prompt, and a
# failure here never stops the install (the assistant is already set up).
function Invoke-ProvidersStep([string]$Account) {
    $label = 'Connecting your model providers'
    Step $label
    Send-Progress providers started
    $saved = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        if ([Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {
            clawmeets agent provider register --as-user $Account
        } else {
            clawmeets agent provider register --as-user $Account --no-ask-keys
        }
        $rc = $LASTEXITCODE
    } catch {
        $rc = 1
    } finally {
        $ErrorActionPreference = $saved
    }
    if ($rc -eq 0) {
        Send-Progress providers ok
        Ok $label
    } else {
        Send-Progress providers failed 'Some model agents were not registered.'
        Warn "$label - some were not registered."
        Say "      Run 'clawmeets agent provider register --as-user $Account' later to retry or to add API keys."
    }
}

# The model config every new agent starts with (install.sh: run_model_step).
# Before the assistant, so it gets it too; never stops the install.
function Invoke-ModelStep([string]$Account) {
    $label = 'Choosing your default model'
    Step $label
    Send-Progress model started
    $saved = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        if ([Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {
            clawmeets model-default setup --as-user $Account
        } else {
            clawmeets model-default setup --as-user $Account --no-ask
        }
        $rc = $LASTEXITCODE
    } catch {
        $rc = 1
    } finally {
        $ErrorActionPreference = $saved
    }
    if ($rc -eq 0) {
        Send-Progress model ok
        Ok $label
    } else {
        Send-Progress model failed 'The default model was not saved.'
        Warn "$label - not saved."
        Say "      Run 'clawmeets model-default setup --as-user $Account' later to choose it."
    }
}

# Which other accounts on this computer still have something running — after
# an upgrade, those processes are on the old code until restarted.
function Get-OthersRunning([string]$Account) {
    $configDir = Join-Path $DataDir 'config'
    if (-not (Test-Path $configDir)) { return @() }
    $others = @()
    foreach ($cfg in (Get-ChildItem -Path $configDir -Directory)) {
        $user = $cfg.Name
        if ($user -eq $Account) { continue }
        $pidFiles = @(Join-Path (Join-Path (Join-Path $DataDir 'computer') $user) 'computer.pid')
        $agentsDir = Join-Path $DataDir 'agents'
        if (Test-Path $agentsDir) {
            $pidFiles += @(Get-ChildItem -Path $agentsDir -Directory -Filter "$user-*" |
                ForEach-Object { Join-Path $_.FullName 'agent.pid' })
        }
        foreach ($pidFile in $pidFiles) {
            if (-not (Test-Path $pidFile)) { continue }
            $procId = 0
            if (-not [int]::TryParse((Get-Content $pidFile -TotalCount 1), [ref]$procId)) { continue }
            if (Get-Process -Id $procId -ErrorAction SilentlyContinue) { $others += $user; break }
        }
    }
    return $others
}

function Write-Closing([string]$Account, [string]$PrevDefault) {
    Say "Set up $Account on $Server."
    $default = Get-Content (Join-Path (Join-Path $DataDir 'config') 'current_user') -TotalCount 1 -ErrorAction SilentlyContinue
    if ($default -eq $Account) {
        Say "This computer's default account is $Account."
    } else {
        if (-not $default) { $default = $PrevDefault }
        Say "This computer's default account is still $default."
        Say "Add --user $Account to clawmeets commands for the new account."
    }
    if ($script:SourceDesc) {
        Say "ClawMeets on this computer runs from $($script:SourceDesc), for every account."
        Say "To go back to the released version: uv tool install --reinstall $RunnerPkg; uv tool install --reinstall $ComputerPkg"
    }
    if ($script:Upgraded) {
        foreach ($other in (Get-OthersRunning $Account)) {
            Say "ClawMeets was updated. $other's agents and computer connection still run the old version until you run:"
            Say "  clawmeets computer stop --user $other; clawmeets computer start --user $other"
            Say "  clawmeets stop --user $other; clawmeets start --user $other"
        }
    }
}

# Doctor's non-zero exit means "your setup needs attention", not "the installer
# broke" — reported, printed, and never a failure of the install (see install.sh).
function Invoke-CheckStep([string]$Account, [string]$PrevDefault) {
    Step 'Checking everything works'
    Send-Progress check started
    Say ''
    $r = Invoke-Native { clawmeets doctor --user $Account --server $Server }
    Write-Host $r.Output
    Say ''
    Write-Closing $Account $PrevDefault
    Say ''
    if ($r.Ok) {
        Send-Progress check ok
        Say 'Done. Open ClawMeets in your browser - your agents are ready.'
    } else {
        Send-Progress check failed ((($r.Output -split "`n") | Select-Object -Last 20) -join "`n")
        Say "ClawMeets is installed. Fix the item(s) above, then run: clawmeets doctor --user $Account"
    }
    Say "After a restart, run: clawmeets computer start --user $Account; clawmeets start --user $Account"
    Say ''
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

function Invoke-Install {
    if ($Server -eq '' -or $Server.StartsWith('@@')) {
        Warn 'This installer was served without a server URL. Tell whoever runs this ClawMeets server that CLAWMEETS_APP_URL is unset.'
        return
    }
    if (-not $Token) {
        Warn 'No install token. Copy the whole command from ClawMeets in your browser - it ends with the token.'
        return
    }
    if (-not (Test-CanSymlink)) {
        $why = 'Developer Mode is off. ClawMeets creates symbolic links when your agents start, which Windows only allows with Developer Mode on (or as administrator). Turn it on in Settings > System > For developers > Developer Mode, then run the same command again.'
        Send-Progress install failed $why
        Warn $why
        Say ''
        Say 'To open that settings page now, run: start ms-settings:developers'
        return
    }

    Say ''
    Say 'Setting up ClawMeets on this computer.'
    Say ''

    try {
        $null = Invoke-Step install 'Installing ClawMeets' { Install-Everything }
        # The token is spent here, inside the CLI. No password is typed. It keeps
        # an existing default account and prints the one it signed in as.
        $prevDefault = Get-Content (Join-Path (Join-Path $DataDir 'config') 'current_user') -TotalCount 1 -ErrorAction SilentlyContinue
        $linked = Invoke-Step link 'Signing in on this computer' { Invoke-Native { clawmeets user link $Token --server $Server } }
        $account = ''
        foreach ($line in ("$linked" -split "`n")) {
            if ($line -match '^account=(.+)$') { $account = $Matches[1].Trim() }
        }
        if (-not $account) { throw 'Signed in, but the account name did not come back. Run: clawmeets doctor' }

        # Shared storage; the runner creates it on every start too, so never fatal.
        New-Item -ItemType Directory -Force -Path (Join-Path $DataDir 'shared_storage') -ErrorAction SilentlyContinue | Out-Null

        # Every later step names $account. Exit code only for the assistant:
        # re-registering your own is an upsert, so "already" means another
        # account owns the name.
        Invoke-ModelStep $account
        $null = Invoke-Step assistant 'Setting up your assistant' { Invoke-Native { clawmeets assistant register --username $account } }
        Invoke-ProvidersStep $account
        $null = Invoke-Step computer 'Connecting this computer' { Invoke-Native { clawmeets computer install --user $account } }
        $null = Invoke-Step start 'Starting your agents' { Invoke-Native { clawmeets start --user $account } }
        Invoke-CheckStep $account $prevDefault
    } catch {
        if ("$_" -ne 'STEP_FAILED') { Warn "$_" }
        Say ''
        Say 'Fix the problem above and run the command again.'
        Say 'Already fixed it? Get a fresh command from ClawMeets in your browser.'
    }
}

Invoke-Install
