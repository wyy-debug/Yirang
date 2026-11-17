param([Parameter(Mandatory=$true)][string]$InstallRoot)
$ErrorActionPreference = 'Stop'
$launcher = Join-Path $InstallRoot 'start-desktop.ps1'
$content = @'
$ErrorActionPreference = 'Stop'
$state = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'current.json') -Raw | ConvertFrom-Json
if ($state.buildId -notmatch '^\d+\.\d+\.\d+-\d{8}-\d{9}$') { throw 'Invalid installation version' }
$executableName = if ($state.executableName) { $state.executableName } else { 'AI Desktop.exe' }
if ($executableName -notin @('Yirang.exe', 'AI Desktop.exe')) { throw 'Invalid executable name' }
$executable = Join-Path (Join-Path (Join-Path $PSScriptRoot 'versions') $state.buildId) $executableName
Start-Process -FilePath $executable -WorkingDirectory (Split-Path -Parent $executable)
'@
[System.IO.File]::WriteAllText($launcher, $content, [System.Text.UTF8Encoding]::new($true))
$wsh = New-Object -ComObject WScript.Shell
foreach ($folder in @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop'))) {
  $link = $wsh.CreateShortcut((Join-Path $folder '一壤 · Yirang.lnk'))
  $link.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $link.Arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $launcher + '"'
  $link.WorkingDirectory = $InstallRoot
  $link.Description = '一壤 · Yirang — 让想法，自由生长。'
  $state = Get-Content -LiteralPath (Join-Path $InstallRoot 'current.json') -Raw | ConvertFrom-Json
  $executableName = if ($state.executableName) { $state.executableName } else { 'AI Desktop.exe' }
  if ($executableName -notin @('Yirang.exe', 'AI Desktop.exe')) { throw 'Invalid executable name' }
  $link.IconLocation = (Join-Path (Join-Path (Join-Path $InstallRoot 'versions') $state.buildId) $executableName) + ',0'
  $link.Save()
  # Replace only the shortcut owned by this installation, never a user's unrelated link.
  $oldPath = Join-Path $folder 'AI Desktop.lnk'
  if (Test-Path -LiteralPath $oldPath) {
    $oldLink = $wsh.CreateShortcut($oldPath)
    if ($oldLink.Arguments -eq $link.Arguments -and $oldLink.TargetPath -eq $link.TargetPath) {
      Remove-Item -LiteralPath $oldPath
    }
  }
}
