# Run after closing Codex if Windows reports that the plugin cache is in use.
$ErrorActionPreference = 'Stop'
$desktopCli = Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin') -Directory -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    ForEach-Object { Join-Path $_.FullName 'codex.exe' } |
    Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
    Select-Object -First 1
if (-not $desktopCli) {
    $desktopCli = (Get-Command codex -ErrorAction SilentlyContinue).Source
    if (-not $desktopCli) { throw 'Codex CLI not found. Open a terminal with Codex on PATH and retry.' }
}
& $desktopCli plugin add 'ai-desktop@ai-desktop-local' --json
if ($LASTEXITCODE -ne 0) {
    throw 'Plugin update failed. Close Codex to release the old plugin processes, then retry. Existing workspace data is preserved.'
}
Write-Host 'AI Desktop installed. Open Codex to load the new plugin.'
