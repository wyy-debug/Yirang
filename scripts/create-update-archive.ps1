param(
  [Parameter(Mandatory = $true)][string]$Source,
  [Parameter(Mandatory = $true)][string]$Archive
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$folder = Get-Item -LiteralPath $Source
$zip = [System.IO.Compression.ZipFile]::Open(
  $Archive, [System.IO.Compression.ZipArchiveMode]::Create, [System.Text.Encoding]::UTF8
)
try {
  foreach ($file in Get-ChildItem -LiteralPath $folder.FullName -Recurse -Force -File) {
    $path = $file.FullName.Substring($folder.FullName.Length + 1).Replace('\', '/')
    $entry = "$($folder.Name)/$path"
    [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
      $zip, $file.FullName, $entry, [System.IO.Compression.CompressionLevel]::Optimal
    )
  }
} finally {
  $zip.Dispose()
}
