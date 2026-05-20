param(
  [string]$CustomActionData = $env:CustomActionData
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($CustomActionData)) {
  throw "ProgramData config custom action data is missing."
}

$values = @{}
foreach ($segment in $CustomActionData -split ";") {
  if ([string]::IsNullOrWhiteSpace($segment)) {
    continue
  }

  $pair = $segment -split "=", 2
  if ($pair.Count -ne 2) {
    continue
  }

  $values[$pair[0].Trim()] = $pair[1].Trim()
}

$token = $values["TOKEN"]
$wsUrl = $values["WSURL"]

if ([string]::IsNullOrWhiteSpace($token)) {
  throw "CONNECTOR_TOKEN is required."
}

if ([string]::IsNullOrWhiteSpace($wsUrl)) {
  throw "CONNECTOR_WS_URL is required."
}

$programDataRoot = [Environment]::GetFolderPath("CommonApplicationData")
$configDir = Join-Path $programDataRoot "PharmaAgentConnector"
$configPath = Join-Path $configDir "connector-config.json"

New-Item -ItemType Directory -Path $configDir -Force | Out-Null

$config = [ordered]@{
  CONNECTOR_TOKEN = $token
  CONNECTOR_WS_URL = $wsUrl
}

$config | ConvertTo-Json -Compress | Set-Content -Path $configPath -Encoding UTF8
