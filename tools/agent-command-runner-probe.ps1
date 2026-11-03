$ErrorActionPreference = 'Stop'
$nativeWorkingDirectory = [System.Environment]::CurrentDirectory
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::WriteLine('AAW_POWERSHELL_BEGIN')
[Console]::Error.WriteLine('AAW_POWERSHELL_STDERR')
[Console]::WriteLine('PSVersion=' + $PSVersionTable.PSVersion.ToString())
[Console]::WriteLine('WIN32_CWD=' + $nativeWorkingDirectory)
[Console]::WriteLine('PWD_BEFORE=' + (Get-Location).Path)
function Write-ExpectedDiagnostic($tag, $exception) {
    [Console]::WriteLine('DIAG_EXCEPTION=' + $tag + '|' + $exception.GetType().FullName + '|' + $exception.HResult + '|' + $exception.Message.Replace("`r", ' ').Replace("`n", ' '))
}
$ancestor = $nativeWorkingDirectory
for ($index = 0; $index -lt 12 -and -not [string]::IsNullOrEmpty($ancestor); $index++) {
    try { [Console]::WriteLine('DIAG_ATTRIBUTE=' + $ancestor + '|' + [System.IO.File]::GetAttributes($ancestor)) }
    catch { Write-ExpectedDiagnostic ('attribute:' + $ancestor) $_.Exception }
    $ancestor = [System.IO.Path]::GetDirectoryName($ancestor)
}
try { [Console]::WriteLine('DIAG_BASELINE_DOTNET=' + [System.IO.File]::ReadAllText($env:AAW_BASELINE).Trim()) }
catch { Write-ExpectedDiagnostic 'baseline_dotnet' $_.Exception }
$systemDrive = $null
try { $systemDrive = $ExecutionContext.SessionState.Drive.Get('C') }
catch [System.Management.Automation.DriveNotFoundException] { }
if ($null -eq $systemDrive) {
    $null = New-PSDrive -Name C -PSProvider FileSystem -Root 'C:\' -Scope Global -ErrorAction Stop
}
try { $null = Get-Item -LiteralPath $nativeWorkingDirectory -ErrorAction Stop; [Console]::WriteLine('DIAG_C_PROVIDER_GETITEM=ok') }
catch { Write-ExpectedDiagnostic 'c_provider_getitem' $_.Exception }
try { Set-Location -LiteralPath $nativeWorkingDirectory -ErrorAction Stop; [Console]::WriteLine('DIAG_C_PROVIDER_SETLOCATION=ok') }
catch { Write-ExpectedDiagnostic 'c_provider_setlocation' $_.Exception }
$runtimeDirectory = [System.IO.Path]::GetDirectoryName($env:AAW_NODE)
$null = New-PSDrive -Name AAWWork -PSProvider FileSystem -Root $nativeWorkingDirectory -Scope Global -ErrorAction Stop
$null = New-PSDrive -Name AAWTools -PSProvider FileSystem -Root $runtimeDirectory -Scope Global -ErrorAction Stop
Set-Location -LiteralPath 'AAWWork:\' -ErrorAction Stop
$providerPath = (Get-Location).ProviderPath
[Console]::WriteLine('PWD=' + (Get-Location).Path)
[Console]::WriteLine('PROVIDER_PATH=' + $providerPath)
[Console]::WriteLine('WIN32_CWD_AFTER=' + [System.Environment]::CurrentDirectory)
function Get-NormalDirectoryPath([string]$value) {
    $full = [System.IO.Path]::GetFullPath($value)
    $root = [System.IO.Path]::GetPathRoot($full)
    if ($full.Length -gt $root.Length) {
        $full = $full.TrimEnd([char[]]@([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar))
    }
    return $full
}
if (-not [string]::Equals((Get-NormalDirectoryPath $providerPath), (Get-NormalDirectoryPath $nativeWorkingDirectory), [System.StringComparison]::OrdinalIgnoreCase)) { throw 'PowerShell provider cwd differs from admitted native cwd' }
if (-not [string]::Equals([System.Environment]::CurrentDirectory, $nativeWorkingDirectory, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Win32 cwd changed outside admitted work' }
$items = @(Get-ChildItem -LiteralPath 'AAWWork:\' -ErrorAction Stop)
[Console]::WriteLine('PROVIDER_ITEMS_BEFORE=' + $items.Count)
$null = New-Item -Path '.\ps-provider' -ItemType Directory -ErrorAction Stop
$null = New-Item -Path '.\ps-provider\check.txt' -ItemType File -Value 'provider ok' -ErrorAction Stop
[Console]::WriteLine('PROVIDER_RELATIVE_WRITE=' + [System.IO.File]::ReadAllText([System.IO.Path]::Combine($nativeWorkingDirectory, 'ps-provider\check.txt')))
Set-Alias -Name node -Value 'AAWTools:\node.exe' -Scope Global -ErrorAction Stop
$nodeCommand = Get-Command node -ErrorAction Stop
[Console]::WriteLine('NODE_COMMAND_KIND=' + $nodeCommand.CommandType)
[Console]::WriteLine('NODE_COMMAND_DEFINITION=' + $nodeCommand.Definition)
$resolvedNode = $nodeCommand.ResolvedCommand
if ($null -eq $resolvedNode -or -not [string]::Equals($resolvedNode.Path, $env:AAW_NODE, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'node alias does not resolve to admitted runtime' }
[Console]::WriteLine('NODE_COMMAND_PATH=' + $resolvedNode.Path)
[Console]::WriteLine('HOME=' + $HOME)
node --no-addons --no-global-search-paths --preserve-symlinks-main $env:AAW_SCRIPT
$nodeExit = $LASTEXITCODE
[Console]::WriteLine('NODE_EXIT=' + $nodeExit)
if ($nodeExit -ne 0) { exit $nodeExit }
[Console]::WriteLine('AAW_POWERSHELL_END')
exit 0
