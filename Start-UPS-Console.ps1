param(
    [ValidateRange(1024,65535)][int]$Port = 8765,
    [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
$address = "http://127.0.0.1:$Port/"

function Open-ConsoleTab {
    $programFiles86 = [Environment]::GetFolderPath('ProgramFilesX86')
    $candidates = @(
        "$programFiles86\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "$programFiles86\Google\Chrome\Application\chrome.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
    )
    foreach ($browserPath in $candidates) {
        if (Test-Path -LiteralPath $browserPath) {
            Start-Process -FilePath $browserPath -ArgumentList $address
            return
        }
    }
    Write-Host "Open $address in desktop Edge or Chrome."
}

Add-Type -Path (Join-Path $PSScriptRoot 'StaticServer.cs')
$server = [UpsConsole.StaticServer]::new((Join-Path $PSScriptRoot 'app'), $Port)
try {
    try {
        $server.Start()
    } catch {
        # Only reuse a previous launcher if it identifies this application.
        $response = $null
        try { $response = Invoke-WebRequest -UseBasicParsing -Uri $address -TimeoutSec 2 } catch {}
        if ($response -and $response.Headers['X-UPS-Console'] -eq '1') {
            if (-not $NoBrowser) { Open-ConsoleTab }
            return
        }
        throw "Port $Port is unavailable. Run Start-UPS-Console.ps1 -Port 8766 to select another port."
    }
    Write-Host "UPS Console is at $address"
    Write-Host 'Close this window or press Ctrl+C to stop the local server.'
    if (-not $NoBrowser) { Open-ConsoleTab }
    while ($true) { Start-Sleep -Seconds 1 }
} finally { $server.Dispose() }
