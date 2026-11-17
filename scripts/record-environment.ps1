$ErrorActionPreference = 'Continue'
$app = Get-AppxPackage -Name '*Codex*' | Select-Object -First 1 Name,Version,Architecture
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1 Name,VirtualizationFirmwareEnabled,SecondLevelAddressTranslationExtensions
$vm = Get-Service vmms -ErrorAction SilentlyContinue
$runtime = node -p 'JSON.stringify({node:process.version,arch:process.arch,platform:process.platform,abi:process.versions.modules,os:require("node:os").release()})'
$record = [ordered]@{
  collectedAt = [DateTimeOffset]::UtcNow.ToString('o')
  desktop = $app
  runtime = ($runtime | ConvertFrom-Json)
  cpu = $cpu
  hyperVService = if ($vm) { $vm.Status.ToString() } else { 'unavailable' }
  qemuInPath = [bool](Get-Command qemu-system-x86_64 -ErrorAction SilentlyContinue)
  independentWorkspaceVmVerified = $false
}
New-Item -ItemType Directory -Force -Path docs\evidence | Out-Null
$record | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath docs\evidence\environment.json -Encoding utf8
$record | ConvertTo-Json -Depth 6
