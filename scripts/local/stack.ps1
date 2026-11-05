# REAL-001 - local camera stack controller: go2rtc + mediaMTX + ffmpeg publisher.
#   powershell -NoProfile -File scripts/local/stack.ps1 start|stop|status
# Idempotent: start probes ports/checks pidfiles first; stop kills ONLY processes
# this script spawned or whose CommandLine matches runtime markers.
# NOTE: Get-NetTCPConnection under-reports on this machine (Go-binary sockets
# missing from the table while they serve traffic), so presence checks use
# real TCP-connect probes + CIM process enumeration instead.
# ASCII-only: Windows PowerShell 5.1 reads BOM-less .ps1 as ANSI -> no diacritics.
[CmdletBinding()]
param(
    [Parameter(Position = 0, Mandatory = $true)]
    [ValidateSet("start", "stop", "status")]
    [string]$Action,
    [string]$LanIp = $env:DAI_LAN_IP,
    [string]$RuntimeDir = $env:DAI_RUNTIME_DIR
)
$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = (Resolve-Path (Join-Path $scriptDir "..\..")).Path
if (-not $RuntimeDir) { $RuntimeDir = (Resolve-Path (Join-Path $repoRoot "..\..\runtime")).Path }
$pidDir = Join-Path $RuntimeDir "pids"
$logDir = Join-Path $RuntimeDir "logs"
$go2rtcDir = Join-Path $RuntimeDir "go2rtc"
$mtxDir = Join-Path $RuntimeDir "mediamtx"

function Info([string]$m) { Write-Output "[INFO] $m" }
function Ok([string]$m) { Write-Output "[ OK ] $m" }
function Warn([string]$m) { Write-Output "[WARN] $m" }

function Test-PortOpen([string]$Addr, [int]$Port, [int]$TimeoutMs = 1200) {
    $c = New-Object System.Net.Sockets.TcpClient
    try {
        $iar = $c.BeginConnect($Addr, $Port, $null, $null)
        if (-not $iar.AsyncWaitHandle.WaitOne($TimeoutMs)) { return $false }
        $c.EndConnect($iar)
        return $true
    } catch { return $false } finally { $c.Close() }
}
function Get-ProcInfo([int]$ProcId) {
    Get-CimInstance Win32_Process -Filter "ProcessId=$ProcId" -ErrorAction SilentlyContinue |
        Select-Object -First 1 ProcessId, Name, CommandLine
}
function Find-ManagedProcs {
    # Processes belonging to this stack, by CommandLine marker (runtime dir,
    # publisher script, or our ffmpeg RTSP publisher target).
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.CommandLine -and (
            $_.CommandLine.Contains("$RuntimeDir") -or
            $_.CommandLine.Contains("rtsp-publisher.ps1") -or
            ($_.Name -eq "ffmpeg.exe" -and $_.CommandLine.Contains(":8554/cam"))
        )
    }
}
function Read-PidFile([string]$Name) {
    $f = Join-Path $pidDir "$Name.pid"
    if (Test-Path $f) { [int](Get-Content $f -Raw).Trim() } else { 0 }
}
function Write-PidFile([string]$Name, [int]$ProcId) {
    New-Item -ItemType Directory -Force -Path $pidDir | Out-Null
    Set-Content -Path (Join-Path $pidDir "$Name.pid") -Value $ProcId -NoNewline
}
function Test-Ours([string]$Name, [string]$Marker) {
    $procId = Read-PidFile $Name
    if (-not $procId) { return $false }
    $p = Get-ProcInfo $procId
    return ($p -and $p.CommandLine -and $p.CommandLine.Contains($Marker))
}
function Stop-Managed([string]$Name, [string]$Marker) {
    $procId = Read-PidFile $Name
    $f = Join-Path $pidDir "$Name.pid"
    if (-not $procId) { Info "$Name : no pidfile, skip"; return }
    $p = Get-ProcInfo $procId
    if (-not $p) {
        Info "$Name : pid $procId already dead, cleaning pidfile"
        Remove-Item $f -Force -ErrorAction SilentlyContinue; return
    }
    if (-not ($p.CommandLine -and $p.CommandLine.Contains($Marker))) {
        Warn "$Name : pid $procId is '$($p.Name)', marker '$Marker' mismatch - NOT killing (possible PID reuse)"
        Remove-Item $f -Force -ErrorAction SilentlyContinue; return
    }
    # Kill children first (publisher wrapper -> ffmpeg child), then the process.
    Get-CimInstance Win32_Process -Filter "ParentProcessId=$procId" -ErrorAction SilentlyContinue |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
    Remove-Item $f -Force -ErrorAction SilentlyContinue
    Ok "$Name : stopped pid $procId"
}
function Start-Managed([string]$Name, [string]$Exe, [string[]]$ProcArgs, [string]$WorkDir) {
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    $out = Join-Path $logDir "$Name.out.log"
    $err = Join-Path $logDir "$Name.err.log"
    $p = Start-Process -FilePath $Exe -ArgumentList $ProcArgs -WorkingDirectory $WorkDir `
        -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err -PassThru
    Write-PidFile $Name $p.Id
    Ok "$Name : started pid $($p.Id) (logs: $out, $err)"
    return $p.Id
}
function Wait-HttpOk([string]$Url, [int]$TimeoutSec) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    do {
        try {
            $r = Invoke-WebRequest -Uri $Url -TimeoutSec 3 -UseBasicParsing
            if ($r.StatusCode -eq 200) { return $true }
        } catch { }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    return $false
}
function Resolve-LanIPv4 {
    if ($LanIp) { return $LanIp }
    # IPv4 of the interface holding the default route = the LAN IP in use.
    $route = Get-NetRoute -DestinationPrefix "0.0.0.0/0" -ErrorAction SilentlyContinue |
        Sort-Object RouteMetric | Select-Object -First 1
    if ($route) {
        $a = Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $route.InterfaceIndex -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($a -and $a.IPAddress -match '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|169\.254\.)') { return $a.IPAddress }
    }
    $a = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object {
        $_.IPAddress -match '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)' -and
        $_.InterfaceAlias -notmatch 'Loopback|vEthernet|Bluetooth|WSL|Hyper-V'
    } | Select-Object -First 1
    if (-not $a) { throw "No private IPv4 LAN address found; pass -LanIp or set DAI_LAN_IP." }
    return $a.IPAddress
}

switch ($Action) {
    "start" {
        # ffmpeg is required both for the publisher and for go2rtc's
        # ffmpeg:...#video=mjpeg transcode producer.
        $ff = Get-Command ffmpeg -ErrorAction SilentlyContinue
        if (-not $ff) { throw "ffmpeg not found in PATH." }
        $env:Path = (Split-Path $ff.Source) + ";" + $env:Path
        $ip = Resolve-LanIPv4

        # --- go2rtc ---
        if (Test-Ours "go2rtc" "go2rtc.exe") {
            Ok "go2rtc already running (pid $(Read-PidFile 'go2rtc')), skip"
        } elseif (Test-PortOpen "127.0.0.1" 1984) {
            Warn "127.0.0.1:1984 already served by another process - not starting go2rtc"
        } else {
            Start-Managed "go2rtc" (Join-Path $go2rtcDir "go2rtc.exe") @("-config", "go2rtc.yaml") $go2rtcDir | Out-Null
            if (Wait-HttpOk "http://127.0.0.1:1984/api" 15) { Ok "go2rtc API 127.0.0.1:1984 OK" }
            else { Warn "go2rtc API not responding after 15s - see $logDir\go2rtc.err.log" }
        }

        # --- mediaMTX ---
        if (Test-Ours "mediamtx" "mediamtx.exe") {
            Ok "mediaMTX already running (pid $(Read-PidFile 'mediamtx')), skip"
        } else {
            # go2rtc owns 127.0.0.1:8554 (loopback RTSP); mediaMTX wildcard :8554 can
            # still bind on Windows and serves LAN-IP traffic. Foreign occupancy of
            # the LAN IP port or the api port blocks us.
            $busy = (Test-PortOpen $ip 8554) -or (Test-PortOpen "127.0.0.1" 9997)
            if ($busy) {
                Warn ":8554/$ip or 127.0.0.1:9997 already served - not starting mediaMTX"
            } else {
                Start-Managed "mediamtx" (Join-Path $mtxDir "mediamtx.exe") @("mediamtx.yml") $mtxDir | Out-Null
                if (Wait-HttpOk "http://127.0.0.1:9997/v3/paths/list" 15) { Ok "mediaMTX API 127.0.0.1:9997 OK" }
                else { Warn "mediaMTX API not responding after 15s - see $logDir\mediamtx.err.log" }
            }
        }

        # --- publisher ---
        # Testsrc2 publisher (hình giả) đã bị gỡ khỏi stack mặc định — chỉ bật lại
        # khi chủ động set DAI_TEST_PUBLISHER=1 (vd: dev cần feed giả để test pipeline).
        if ($env:DAI_TEST_PUBLISHER -ne "1") {
            Info "publisher : disabled (DAI_TEST_PUBLISHER!=1) - bo qua video gia testsrc2"
        } else {
        # mediaMTX runs authMethod=internal with anonymous publish denied (M0), so a
        # publisher URL without credentials is rejected with 401 and the "cam" path
        # stays dead -- which then makes the M0 gate unverifiable. The publish
        # credential comes from the out-of-repo secret file, never from this script.
        $rtsp = "rtsp://${ip}:8554/cam"
        $credFile = Join-Path $env:USERPROFILE ".camdai\mediamtx.env"
        if (Test-Path $credFile) {
            Get-Content $credFile | ForEach-Object {
                if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
                    Set-Item -Path ("env:" + $matches[1]) -Value $matches[2].Trim()
                }
            }
        }
        if ($env:MEDIAMTX_PUBLISH_USER -and $env:MEDIAMTX_PUBLISH_PASS) {
            $pu = [Uri]::EscapeDataString($env:MEDIAMTX_PUBLISH_USER)
            $pp = [Uri]::EscapeDataString($env:MEDIAMTX_PUBLISH_PASS)
            $rtsp = "rtsp://${pu}:${pp}@${ip}:8554/cam"
        } else {
            Warn "MEDIAMTX_PUBLISH_USER/PASS not found - publisher will be rejected (401)"
        }
        if (Test-Ours "publisher" "rtsp-publisher.ps1") {
            Ok "publisher already running (pid $(Read-PidFile 'publisher')), skip"
        } else {
            $pub = Join-Path $scriptDir "rtsp-publisher.ps1"
            Start-Managed "publisher" "powershell.exe" @(
                "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$pub`"",
                "-RtspUrl", "`"$rtsp`"", "-LogPath", "`"$(Join-Path $logDir 'ffmpeg-publisher.log')`""
            ) $repoRoot | Out-Null
        }
        Info "RTSP camera URL to add in the app: $rtsp"
        }
    }

    "stop" {
        Stop-Managed "publisher" "rtsp-publisher.ps1"
        Stop-Managed "mediamtx" "mediamtx.exe"
        Stop-Managed "go2rtc" "go2rtc.exe"
        # Safety sweep: kill any leftover process whose CommandLine marks it as
        # part of this stack (covers dead pidfiles / orphaned ffmpeg children).
        foreach ($p in @(Find-ManagedProcs)) {
            Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
            Ok "swept leftover pid $($p.ProcessId) ($($p.Name))"
        }
    }

    "status" {
        $managed = @(Find-ManagedProcs)
        $ip = try { Resolve-LanIPv4 } catch { "<no LAN IPv4>" }
        $checks = @(
            @{ L = "127.0.0.1:1984 (go2rtc api)"; A = "127.0.0.1"; P = 1984 },
            @{ L = "127.0.0.1:8554 (go2rtc rtsp)"; A = "127.0.0.1"; P = 8554 },
            @{ L = "${ip}:8554 (mediamtx rtsp)"; A = $ip; P = 8554 },
            @{ L = "127.0.0.1:9997 (mediamtx api)"; A = "127.0.0.1"; P = 9997 }
        )
        foreach ($c in $checks) {
            if ($c.A -like "<*") { Info "port $($c.L): skip (no LAN IP)"; continue }
            $state = if (Test-PortOpen $c.A $c.P) { "OPEN" } else { "CLOSED" }
            Info "port $($c.L) : $state"
        }
        try {
            $r = Invoke-WebRequest -Uri "http://127.0.0.1:1984/api" -TimeoutSec 3 -UseBasicParsing
            Ok "go2rtc /api -> HTTP $($r.StatusCode): $($r.Content.Substring(0, [Math]::Min(120, $r.Content.Length)))"
        } catch { Warn "go2rtc /api not responding: $($_.Exception.Message)" }
        try {
            $cam = Invoke-RestMethod -Uri "http://127.0.0.1:9997/v3/paths/get/cam" -TimeoutSec 3
            Info "mediaMTX path cam: ready=$($cam.ready) source=$($cam.source.type)"
        } catch { Warn "mediaMTX path cam not ready / api down: $($_.Exception.Message)" }
        foreach ($n in @("go2rtc", "mediamtx", "publisher")) {
            $procId = Read-PidFile $n
            $alive = if ($procId) { [bool](Get-ProcInfo $procId) } else { $false }
            Info "$n : pidfile=$procId alive=$alive"
        }
        $names = foreach ($p in $managed) { "$($p.Name)#$($p.ProcessId)" }
        Info "managed processes (n=$($managed.Count)): $($names -join ', ')"
    }
}
