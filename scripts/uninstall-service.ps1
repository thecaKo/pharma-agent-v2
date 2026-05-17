param(
  [string]$ServiceName = "PharmaAgentConnector"
)

$ErrorActionPreference = "Stop"

$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if (-not $service) {
  Write-Host "Service '$ServiceName' is not installed."
  exit 0
}

if ($service.Status -ne "Stopped") {
  Stop-Service -Name $ServiceName -Force
  $service.WaitForStatus("Stopped", "00:00:30")
}

sc.exe delete $ServiceName | Out-Null
Write-Host "Uninstalled $ServiceName."
