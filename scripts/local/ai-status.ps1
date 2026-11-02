# REAL-001 - probe the local AI runtime (Hermes llama.cpp router).
#   powershell -NoProfile -File scripts/local/ai-status.ps1
# Reads %LOCALAPPDATA%\hermes\runtimes\llamacpp\server.json -> base_url + api_key,
# checks the recorded pid, GET {base_url}/models, prints available model ids.
# Never writes the api_key anywhere (console output is masked).
[CmdletBinding()] param()
$ErrorActionPreference = "Continue"

$serverJson = Join-Path $env:LOCALAPPDATA "hermes\runtimes\llamacpp\server.json"
function Info([string]$m) { Write-Output "[INFO] $m" }
function Ok([string]$m) { Write-Output "[ OK ] $m" }
function Warn([string]$m) { Write-Output "[WARN] $m" }

if (-not (Test-Path $serverJson)) {
    Warn "missing $serverJson - llamacpp runtime was never created."
    exit 1
}
$cfg = Get-Content $serverJson -Raw | ConvertFrom-Json
$masked = if ($cfg.api_key -and $cfg.api_key.Length -gt 8) {
    $cfg.api_key.Substring(0, 4) + "..." + $cfg.api_key.Substring($cfg.api_key.Length - 4)
} else { "(empty)" }
Info "server.json: base_url=$($cfg.base_url) api_key=$masked pid=$($cfg.pid)"

if ($cfg.pid) {
    $proc = Get-Process -Id $cfg.pid -ErrorAction SilentlyContinue
    if ($proc) { Ok "llama-server pid $($cfg.pid) is running ($($proc.ProcessName))" }
    else { Warn "pid $($cfg.pid) from server.json is NOT running (stale state)" }
}

try {
    $r = Invoke-RestMethod -Uri "$($cfg.base_url)/models" -TimeoutSec 5 `
        -Headers @{ Authorization = "Bearer $($cfg.api_key)" }
    $ids = @($r.data | ForEach-Object { $_.id })
    Ok "GET $($cfg.base_url)/models -> $($ids.Count) model(s)"
    foreach ($id in $ids) { Info "  model id: $id" }
    Info "Use in .env.local: HERMES_BASE_URL=$($cfg.base_url)"
    if ($ids.Count -gt 0) { Info "                   HERMES_MODEL=$($ids[0])" }
    exit 0
} catch {
    Warn "GET $($cfg.base_url)/models failed: $($_.Exception.Message)"
    Warn "llamacpp router is not running - start the Hermes local runtime first, then re-run this script."
    exit 1
}
