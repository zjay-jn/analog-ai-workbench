$ErrorActionPreference = 'Stop'
$nativeWorkingDirectory = [Environment]::CurrentDirectory
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
function Get-AAWCanonicalDirectory([string]$value) {
    $full = [IO.Path]::GetFullPath($value)
    $root = [IO.Path]::GetPathRoot($full)
    if ($full.Length -gt $root.Length) { $full = $full.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) }
    return $full
}
# PowerShell 5.1 may omit the work volume when AppContainer cannot query root attributes.
# Private provider roots preserve normal shell semantics without changing ancestor ACLs.
$workVolume = [IO.Path]::GetPathRoot($nativeWorkingDirectory)
$workDrive = $workVolume.Substring(0, 1)
try { $null = $ExecutionContext.SessionState.Drive.Get($workDrive) }
catch [System.Management.Automation.DriveNotFoundException] { New-PSDrive -Name $workDrive -PSProvider FileSystem -Root $workVolume -Scope Global | Out-Null }
New-PSDrive -Name AAWWork -PSProvider FileSystem -Root $env:AAW_WORK -Scope Global | Out-Null
New-PSDrive -Name AAWTools -PSProvider FileSystem -Root $env:AAW_RUNTIME -Scope Global | Out-Null
$location = 'AAWWork:\'
if ($env:AAW_CWD_RELATIVE) { $location += $env:AAW_CWD_RELATIVE.Replace('/', '\') }
Set-Location -LiteralPath $location
if (-not [string]::Equals((Get-AAWCanonicalDirectory ((Get-Location).ProviderPath)), (Get-AAWCanonicalDirectory $nativeWorkingDirectory), [StringComparison]::OrdinalIgnoreCase)) { throw 'AAW provider working directory mismatch' }
if (-not [string]::Equals([Environment]::CurrentDirectory, $nativeWorkingDirectory, [StringComparison]::OrdinalIgnoreCase)) { throw 'AAW native working directory mismatch' }
Set-Alias -Name node -Value 'AAWTools:\node.exe' -Scope Global
$resolvedNode = Get-Command node -ErrorAction Stop
if (-not [string]::Equals($resolvedNode.ResolvedCommand.Path, ($env:AAW_RUNTIME + '\node.exe'), [StringComparison]::OrdinalIgnoreCase)) { throw 'AAW node alias identity mismatch' }
# Invoke the exact BOM command file normally in the same runspace. Explicit exit and
# terminating errors retain PowerShell behavior; the final external code is propagated.
$global:LASTEXITCODE = 0
& 'AAWTools:\command.ps1'
$commandSucceeded = $?
$commandExitCode = $global:LASTEXITCODE
if ($commandExitCode -ne 0) { exit $commandExitCode }
if (-not $commandSucceeded) { exit 1 }
exit 0
