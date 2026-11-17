$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$package = (Resolve-Path -LiteralPath 'release\marketplace\plugins\ai-desktop').Path
$releaseRoot = (Resolve-Path -LiteralPath 'release').Path
$manifest = Get-Content -LiteralPath (Join-Path $package 'plugin.json') -Raw | ConvertFrom-Json
$archive = Join-Path $releaseRoot "ai-desktop-$($manifest.version)-win-x64.zip"
if (Test-Path -LiteralPath $archive) { throw "Archive already exists: $archive" }
[System.IO.Compression.ZipFile]::CreateFromDirectory($package, $archive, [System.IO.Compression.CompressionLevel]::Optimal, $false)
$zip = [System.IO.Compression.ZipFile]::OpenRead($archive)
try {
  $entries = @($zip.Entries | ForEach-Object { $_.FullName.Replace('\','/') })
  $required = @('plugin.json','mcp.json','.codex-plugin/plugin.json','.mcp.json','dist/server.mjs','dist/panel.html','runtime/node.exe','runtime/LICENSE','dependency-inventory.json','THIRD_PARTY_NOTICES.txt','assets/icon.svg')
  foreach ($entry in $required) {
    if ($entry -notin $entries) { throw "Missing package entry: $entry" }
  }
  if ($entries | Where-Object { $_ -match '(^|/)(node_modules|test-results|desktop\.sqlite|diagnostics\.jsonl)(/|$)' }) { throw 'Unexpected development data in package' }
  New-Item -ItemType Directory -Force -Path test-results | Out-Null
  [ordered]@{
    archive = $archive
    version = $manifest.version
    bytes = (Get-Item -LiteralPath $archive).Length
    sha256 = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    entryCount = $entries.Count
    requiredEntriesVerified = $true
  } | ConvertTo-Json | Tee-Object -FilePath test-results\plugin-package.json
} finally { $zip.Dispose() }
