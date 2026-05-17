param(
  [string]$ServiceName = "PharmaAgentConnector",
  [string]$DisplayName = "Pharma Agent Connector",
  [string]$InstallDirectory = "$PSScriptRoot\..",
  [string]$NodePath = "node.exe"
)

$ErrorActionPreference = "Stop"

$requiredEnvironment = @(
  "CONNECTOR_TOKEN",
  "CONNECTOR_WS_URL",
  "DB_DRIVER",
  "DB_HOST",
  "DB_PORT",
  "DB_NAME",
  "DB_USER",
  "DB_PASSWORD"
)

foreach ($name in $requiredEnvironment) {
  if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name, "Machine"))) {
    Write-Warning "Machine environment variable '$name' is not set. Configure it before starting $ServiceName."
  }
}

$mainScript = Join-Path $InstallDirectory "dist\main.js"
$binaryPath = "`"$NodePath`" `"$mainScript`""

if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
  throw "Service '$ServiceName' already exists. Use restart-service.ps1 for updates or uninstall-service.ps1 before reinstalling."
}

New-Service `
  -Name $ServiceName `
  -DisplayName $DisplayName `
  -Description "Outbound-only local connector for Pharma Agent product synchronization." `
  -BinaryPathName $binaryPath `
  -StartupType Automatic

sc.exe failure $ServiceName reset= 86400 actions= restart/60000/restart/60000/""/60000 | Out-Null

Write-Host "Installed $ServiceName."
Write-Host "Configure required Machine environment variables, then run:"
Write-Host "  .\restart-service.ps1 -ServiceName $ServiceName"
