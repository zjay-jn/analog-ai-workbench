param(
  [ValidateSet('build', 'dev', 'smoke', 'start', 'test', 'typecheck')]
  [string]$Task = 'dev'
)

$projectRoot = Split-Path -Parent $PSScriptRoot
$toolchainDirectory = Join-Path $projectRoot '.local\toolchains\node-v24.20.0-win-x64'
$npmCommand = Join-Path $toolchainDirectory 'npm.cmd'

if (-not (Test-Path -LiteralPath $npmCommand)) {
  throw 'Approved portable Node 24.20.0 toolchain is missing. Re-run the Phase 1 dependency gate setup.'
}

$previousProcessPath = $env:Path
$previousElectronCache = $env:ELECTRON_CACHE
$locationPushed = $false
try {
  $env:Path = "$toolchainDirectory;$previousProcessPath"
  $env:ELECTRON_CACHE = Join-Path $projectRoot '.local\electron-cache'
  Push-Location $projectRoot
  $locationPushed = $true
  & $npmCommand run $Task
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
}
finally {
  if ($locationPushed) {
    Pop-Location
  }
  $env:Path = $previousProcessPath
  $env:ELECTRON_CACHE = $previousElectronCache
}
