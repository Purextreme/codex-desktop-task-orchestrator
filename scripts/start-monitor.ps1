param(
    [Parameter(Mandatory)][string]$StatePath,
    [Parameter(Mandatory)][string]$PythonPath,
    [string]$CodexDirectory = '',
    [string]$DesktopLogs = '',
    [ValidateRange(1, 24)][int]$Hours = 8
)
$ErrorActionPreference = 'Stop'
$stateFile = (Resolve-Path -LiteralPath $StatePath).Path
$pythonFile = (Resolve-Path -LiteralPath $PythonPath).Path
$folder = Split-Path -Parent $stateFile
$scriptFile = Join-Path $PSScriptRoot 'local-monitor.py'
if (Test-Path -LiteralPath (Join-Path $folder 'monitor.stop')) {
    throw 'monitor.stop exists; inspect prior monitoring before deliberately removing this stop marker.'
}
# Start-Process accepts a command line on Windows; quote each path and reject embedded quotes.
$arguments = @('-X', 'utf8', $scriptFile, '--state', $stateFile, '--watch', '--duration-seconds', [string]($Hours * 3600))
if ($CodexDirectory) { $arguments += @('--codex-home', $CodexDirectory) }
if ($DesktopLogs) { $arguments += @('--desktop-logs', $DesktopLogs) }
$quoted = foreach ($item in $arguments) {
    if ($item.Contains('"') -or $item.Contains("`n") -or $item.Contains("`r")) { throw 'Invalid argument' }
    '"' + $item.TrimEnd('\') + '"'
}
$process = Start-Process -FilePath $pythonFile -ArgumentList ($quoted -join ' ') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $folder 'monitor-stdout.log') -RedirectStandardError (Join-Path $folder 'monitor-stderr.log')
[pscustomobject]@{pid = $process.Id; health = (Join-Path $folder 'health.json'); stop = (Join-Path $folder 'monitor.stop')}
