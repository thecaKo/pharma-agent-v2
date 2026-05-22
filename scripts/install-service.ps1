param(
  [string]$ServiceName = "PharmaAgentConnector",
  [string]$DisplayName = "Pharma Agent Connector",
  [string]$InstallDirectory = "$PSScriptRoot\..",
  [string]$NodePath = "",
  [string]$WinSWPath = $env:WINSW_EXE_PATH
)

$ErrorActionPreference = "Stop"

$serviceExecutableName = "PharmaAgentConnector.Service.exe"
$serviceConfigurationName = "PharmaAgentConnector.Service.xml"
$serviceDescription = "Outbound-only local connector for Pharma Agent product synchronization."
$mainScript = Join-Path $InstallDirectory "dist\main.js"
$targetWrapperPath = Join-Path $InstallDirectory $serviceExecutableName
$targetConfigurationPath = Join-Path $InstallDirectory $serviceConfigurationName

function Resolve-NodeExecutablePath {
  param(
    [string]$RequestedNodePath,
    [string]$InstallDir
  )

  $stagedNodePath = Join-Path $InstallDir "node.exe"

  if (Test-Path -LiteralPath $stagedNodePath) {
    return @{
      XmlPath = "%BASE%\node.exe"
      AbsolutePath = (Resolve-Path -LiteralPath $stagedNodePath).Path
    }
  }

  if (-not [string]::IsNullOrWhiteSpace($RequestedNodePath)) {
    if (Test-Path -LiteralPath $RequestedNodePath) {
      $absolutePath = (Resolve-Path -LiteralPath $RequestedNodePath).Path
      return @{
        XmlPath = $absolutePath
        AbsolutePath = $absolutePath
      }
    }

    $command = Get-Command $RequestedNodePath -ErrorAction SilentlyContinue
    if ($command) {
      return @{
        XmlPath = $command.Source
        AbsolutePath = $command.Source
      }
    }

    throw "Node executable '$RequestedNodePath' was not found."
  }

  $nodeCommand = Get-Command "node.exe" -ErrorAction SilentlyContinue
  if ($nodeCommand) {
    return @{
      XmlPath = $nodeCommand.Source
      AbsolutePath = $nodeCommand.Source
    }
  }

  throw "Could not locate node.exe. Copy node.exe into '$InstallDirectory', pass -NodePath, or ensure node.exe is on PATH."
}

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

if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
  throw "Service '$ServiceName' already exists. Use restart-service.ps1 for updates or uninstall-service.ps1 before reinstalling."
}

if (-not (Test-Path -LiteralPath $mainScript)) {
  throw "Connector entrypoint '$mainScript' was not found. Run npm run build before installing the service."
}

if (-not [string]::IsNullOrWhiteSpace($WinSWPath)) {
  Copy-Item -LiteralPath $WinSWPath -Destination $targetWrapperPath -Force
} elseif (-not (Test-Path -LiteralPath $targetWrapperPath)) {
  throw "WinSW wrapper '$targetWrapperPath' was not found. Copy $serviceExecutableName into the install directory or set WINSW_EXE_PATH."
}

$resolvedNode = Resolve-NodeExecutablePath -RequestedNodePath $NodePath -InstallDir $InstallDirectory
$winswConfiguration = @(
  "<service>",
  "  <id>$ServiceName</id>",
  "  <name>$DisplayName</name>",
  "  <description>$serviceDescription</description>",
  "  <executable>$($resolvedNode.XmlPath)</executable>",
  "  <arguments>&quot;%BASE%\dist\main.js&quot;</arguments>",
  "  <workingdirectory>%BASE%</workingdirectory>",
  "  <logpath>%ProgramData%\PharmaAgentConnector\logs</logpath>",
  "  <log mode=""roll""></log>",
  "  <onfailure action=""restart"" delay=""60 sec"" />",
  "  <resetfailure>1 day</resetfailure>",
  "  <startmode>Automatic</startmode>",
  "  <hidewindow>true</hidewindow>",
  "</service>",
  ""
) -join [Environment]::NewLine

Set-Content -LiteralPath $targetConfigurationPath -Value $winswConfiguration -Encoding UTF8

New-Service `
  -Name $ServiceName `
  -DisplayName $DisplayName `
  -Description $serviceDescription `
  -BinaryPathName "`"$targetWrapperPath`"" `
  -StartupType Automatic

sc.exe failure $ServiceName reset= 86400 actions= restart/60000/restart/60000/""/60000 | Out-Null

Write-Host "Installed $ServiceName."
Write-Host "WinSW wrapper: $targetWrapperPath"
Write-Host "WinSW config: $targetConfigurationPath"
Write-Host "Configure required Machine environment variables, then run:"
Write-Host "  .\restart-service.ps1 -ServiceName $ServiceName"
