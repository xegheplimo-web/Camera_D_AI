#requires -Version 5.1
<#
  Khoi dong MediaMTX voi danh sach user nap tu file secret NGOAI repo.

  Vi sao can script: mediaMTX khong noi suy bien trong YAML, va repo la PUBLIC nen
  khong duoc chua mat khau. Script doc file secret (mac dinh
  %USERPROFILE%\.camdai\mediamtx.env), roi dung cac bien MTX_AUTHINTERNALUSERS_<i>_*
  de mediaMTX nap danh sach user luc khoi dong.

  Vi du file secret (khong commit, khong in ra log):
    MEDIAMTX_PUBLISH_USER=publisher
    MEDIAMTX_PUBLISH_PASS=<random>
    MEDIAMTX_READ_USER=reader
    MEDIAMTX_READ_PASS=<random>
    MEDIAMTX_PLAYBACK_USER=playback
    MEDIAMTX_PLAYBACK_PASS=<random>

  Quyen cua tung user:
    publisher  -> publish, chi tu dai private (LAN/loopback)
    reader     -> read,    chi tu dai private
    playback   -> playback, chi 127.0.0.1
    any        -> api,     pass rong, CHI 127.0.0.1 (cho app goi Control API)
#>
param(
  [string]$EnvFile = (Join-Path $HOME ".camdai\mediamtx.env"),
  [string]$Config = (Join-Path $PSScriptRoot "mediamtx.yml"),
  [string]$Bin = "F:\Camera-D-AI\runtime\mediamtx\mediamtx.exe"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $EnvFile)) { throw "Thieu file secret: $EnvFile" }
if (-not (Test-Path -LiteralPath $Config)) { throw "Thieu file cau hinh: $Config" }
if (-not (Test-Path -LiteralPath $Bin)) { throw "Khong tim thay mediamtx.exe: $Bin" }

$cfg = @{}
foreach ($line in Get-Content -LiteralPath $EnvFile) {
  $t = $line.Trim()
  if ($t -eq "" -or $t.StartsWith("#")) { continue }
  $i = $t.IndexOf("=")
  if ($i -lt 1) { continue }
  $cfg[$t.Substring(0, $i).Trim()] = $t.Substring($i + 1).Trim()
}

$required = @(
  "MEDIAMTX_PUBLISH_USER", "MEDIAMTX_PUBLISH_PASS",
  "MEDIAMTX_READ_USER", "MEDIAMTX_READ_PASS",
  "MEDIAMTX_PLAYBACK_USER", "MEDIAMTX_PLAYBACK_PASS"
)
foreach ($k in $required) {
  if (-not $cfg.ContainsKey($k) -or [string]::IsNullOrWhiteSpace($cfg[$k])) {
    throw "Thieu hoac rong $k trong $EnvFile"
  }
}

$lanRanges = "127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"

# 0: publish
$env:MTX_AUTHINTERNALUSERS_0_USER = $cfg["MEDIAMTX_PUBLISH_USER"]
$env:MTX_AUTHINTERNALUSERS_0_PASS = $cfg["MEDIAMTX_PUBLISH_PASS"]
$env:MTX_AUTHINTERNALUSERS_0_IPS = $lanRanges
$env:MTX_AUTHINTERNALUSERS_0_PERMISSIONS_0_ACTION = "publish"

# 1: read
$env:MTX_AUTHINTERNALUSERS_1_USER = $cfg["MEDIAMTX_READ_USER"]
$env:MTX_AUTHINTERNALUSERS_1_PASS = $cfg["MEDIAMTX_READ_PASS"]
$env:MTX_AUTHINTERNALUSERS_1_IPS = $lanRanges
$env:MTX_AUTHINTERNALUSERS_1_PERMISSIONS_0_ACTION = "read"

# 2: playback (loopback only)
$env:MTX_AUTHINTERNALUSERS_2_USER = $cfg["MEDIAMTX_PLAYBACK_USER"]
$env:MTX_AUTHINTERNALUSERS_2_PASS = $cfg["MEDIAMTX_PLAYBACK_PASS"]
$env:MTX_AUTHINTERNALUSERS_2_IPS = "127.0.0.1/32"
$env:MTX_AUTHINTERNALUSERS_2_PERMISSIONS_0_ACTION = "playback"

# 3: any -> api, loopback only, pass rong (app goi Control API khong kem credential)
$env:MTX_AUTHINTERNALUSERS_3_USER = "any"
$env:MTX_AUTHINTERNALUSERS_3_IPS = "127.0.0.1/32"
$env:MTX_AUTHINTERNALUSERS_3_PERMISSIONS_0_ACTION = "api"

# Khong in mat khau ra stdout.
Write-Host "MediaMTX: nap 4 user tu $EnvFile; config $Config"
& $Bin $Config
