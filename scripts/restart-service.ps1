param(
  [string]$ServiceName = "PharmaAgentConnector"
)

$ErrorActionPreference = "Stop"

$service = Get-Service -Name $ServiceName -ErrorAction Stop

if ($service.Status -eq "Running") {
  Restart-Service -Name $ServiceName -Force
} else {
  Start-Service -Name $ServiceName
}

Get-Service -Name $ServiceName
