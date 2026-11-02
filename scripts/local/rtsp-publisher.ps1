# REAL-001 - ffmpeg RTSP publisher loop (testsrc2 720p@10fps -> mediaMTX).
# Spawned by stack.ps1 as hidden powershell; PID tracked via pids/publisher.pid.
# Forever-retry: if ffmpeg dies or mediaMTX is not ready yet, retry after RetrySeconds.
# ASCII-only on purpose (Windows PowerShell 5.1 ANSI parsing of BOM-less files).
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$RtspUrl,
    [Parameter(Mandatory = $true)][string]$LogPath,
    [int]$RetrySeconds = 2
)
while ($true) {
    "=== publisher $(Get-Date -Format o) -> $RtspUrl" | Out-File -Append -Encoding utf8 $LogPath
    & ffmpeg -hide_banner -nostdin -loglevel warning -stats_period 10 -re `
        -f lavfi -i "testsrc2=size=1280x720:rate=10" `
        -an -c:v libx264 -profile:v baseline -level 3.1 -preset ultrafast -tune zerolatency `
        -g 10 -pix_fmt yuv420p -b:v 1500k -maxrate 1800k -bufsize 2400k `
        -f rtsp -rtsp_transport tcp $RtspUrl 2>> $LogPath
    "=== ffmpeg exit code=$LASTEXITCODE $(Get-Date -Format o); retry in ${RetrySeconds}s" | Out-File -Append -Encoding utf8 $LogPath
    Start-Sleep -Seconds $RetrySeconds
}
