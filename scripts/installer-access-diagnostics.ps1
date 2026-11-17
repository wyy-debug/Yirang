param(
  [Parameter(Mandatory=$true)][string]$FailedPath,
  [Parameter(Mandatory=$true)][string]$SetupImage
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$started = Get-Date
$parent = [IO.Path]::GetDirectoryName($FailedPath)
Write-Output "INSTALL_ACCESS operation=CreateDirectory target=$FailedPath parent=$parent"

try {
  $item = Get-Item -LiteralPath $parent -Force
  Write-Output "INSTALL_ACCESS parent_attributes=$($item.Attributes) link_type=$($item.LinkType) link_target=$($item.Target -join ',')"
  $acl = [IO.Directory]::GetAccessControl($parent)
  Write-Output "INSTALL_ACCESS owner=$($acl.Owner) inheritance_blocked=$($acl.AreAccessRulesProtected)"
  Write-Output "INSTALL_ACCESS dacl=$($acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access))"
  $token = [Security.Principal.WindowsIdentity]::GetCurrent(
    [Security.Principal.TokenAccessLevels]::Query -bor [Security.Principal.TokenAccessLevels]::Duplicate)
  try {
    $principal = [Security.Principal.WindowsPrincipal]::new($token)
    Write-Output "INSTALL_ACCESS identity=$($token.Name) sid=$($token.User.Value) administrator_enabled=$($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))"
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;

public static class YirangInstallAccess {
    [StructLayout(LayoutKind.Sequential)]
    struct GenericMapping { public uint Read, Write, Execute, All; }
    [StructLayout(LayoutKind.Sequential)]
    struct SidAndAttributes { public IntPtr Sid; public uint Attributes; }
    [StructLayout(LayoutKind.Sequential)]
    struct TokenGroups { public uint Count; public SidAndAttributes First; }

    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool DuplicateToken(IntPtr token, int level, out IntPtr duplicate);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr buffer, uint size, out uint needed);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool AccessCheck(byte[] descriptor, IntPtr token, uint desired, ref GenericMapping mapping,
        byte[] privileges, ref uint size, out uint granted, out int allowed);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);

    public static bool CanCreateDirectory(IntPtr token, byte[] descriptor) {
        IntPtr duplicate;
        if (!DuplicateToken(token, 2, out duplicate)) throw new Win32Exception();
        try {
            var mapping = new GenericMapping { Read = 0x120089, Write = 0x120116, Execute = 0x1200a0, All = 0x1f01ff };
            var privileges = new byte[256];
            uint size = (uint)privileges.Length;
            uint granted;
            int allowed;
            if (!AccessCheck(descriptor, duplicate, 4, ref mapping, privileges, ref size, out granted, out allowed))
                throw new Win32Exception();
            return allowed != 0;
        } finally { CloseHandle(duplicate); }
    }

    public static Dictionary<string, uint> Groups(IntPtr token) {
        const int TokenGroupsClass = 2;
        uint size;
        GetTokenInformation(token, TokenGroupsClass, IntPtr.Zero, 0, out size);
        if (size == 0) throw new Win32Exception();
        var buffer = Marshal.AllocHGlobal(checked((int)size));
        try {
            if (!GetTokenInformation(token, TokenGroupsClass, buffer, size, out size)) throw new Win32Exception();
            int count = Marshal.ReadInt32(buffer);
            int offset = Marshal.OffsetOf(typeof(TokenGroups), "First").ToInt32();
            int stride = Marshal.SizeOf(typeof(SidAndAttributes));
            var groups = new Dictionary<string, uint>();
            for (int i = 0; i < count; i++) {
                var group = (SidAndAttributes)Marshal.PtrToStructure(IntPtr.Add(buffer, offset + i * stride), typeof(SidAndAttributes));
                groups[new SecurityIdentifier(group.Sid).Value] = group.Attributes;
            }
            return groups;
        } finally { Marshal.FreeHGlobal(buffer); }
    }
}
'@
    $descriptor = $acl.GetSecurityDescriptorBinaryForm()
    $allowed = [YirangInstallAccess]::CanCreateDirectory($token.Token, $descriptor)
    Write-Output "INSTALL_ACCESS acl_allows_create_subdirectory=$allowed"
    $groups = [YirangInstallAccess]::Groups($token.Token)
    $raw = [Security.AccessControl.RawSecurityDescriptor]::new($descriptor, 0)
    $index = 0
    $matches = 0
    foreach ($ace in $raw.DiscretionaryAcl) {
      $index++
      if ($ace -isnot [Security.AccessControl.QualifiedAce] -or
          ([int]$ace.AceFlags -band [int][Security.AccessControl.AceFlags]::InheritOnly) -or
          -not ($ace.AccessMask -band 0x50000004)) { continue }
      $sid = $ace.SecurityIdentifier.Value
      $kind = $ace.AceQualifier
      $groupFlags = if ($groups.ContainsKey($sid)) { $groups[$sid] } else { 0 }
      $enabled = $sid -eq $token.User.Value -or ($groupFlags -band 4)
      $denyOnly = ($groupFlags -band 16) -ne 0
      if (($kind -eq 'AccessAllowed' -and $enabled) -or
          ($kind -eq 'AccessDenied' -and ($enabled -or $denyOnly))) {
        $matches++
        $account = try { $ace.SecurityIdentifier.Translate([Security.Principal.NTAccount]).Value } catch { $sid }
        Write-Output ('INSTALL_ACCESS matching_ace={0} type={1} account={2} sid={3} mask=0x{4:X8} flags={5} deny_only_group={6} callback={7}' -f
          $index,$ace.AceType,$account,$sid,$ace.AccessMask,$ace.AceFlags,$denyOnly,$ace.IsCallback)
      }
    }
    Write-Output "INSTALL_ACCESS matching_ace_count=$matches"
    if ($allowed) {
      Write-Output 'INSTALL_ACCESS classification=acl_allows_but_create_failed'
    } else {
      Write-Output 'INSTALL_ACCESS classification=acl_denies_create_subdirectory'
    }
  } finally {
    $token.Dispose()
  }
} catch {
  Write-Output "INSTALL_ACCESS acl_check_unavailable=$($_.Exception.GetBaseException().Message)"
  Write-Output "INSTALL_ACCESS acl_check_location=$($_.ScriptStackTrace)"
}

try {
  $events = Get-WinEvent -FilterHashtable @{
    LogName='Microsoft-Windows-Windows Defender/Operational'
    Id=1123
    StartTime=$started.AddMinutes(-2)
  } -MaxEvents 20
  $exeName = [IO.Path]::GetFileNameWithoutExtension($SetupImage)
  $relevant = $events | Where-Object {
    $eventXml = $_.ToXml()
    $eventXml.IndexOf($exeName, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
      ($eventXml.IndexOf([Security.SecurityElement]::Escape($FailedPath), [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
       $eventXml.IndexOf([Security.SecurityElement]::Escape($parent), [StringComparison]::OrdinalIgnoreCase) -ge 0)
  } | Select-Object -First 3
  if (!$relevant) { Write-Output 'INSTALL_ACCESS defender_matching_block=not_found' }
  foreach ($event in $relevant) {
    Write-Output "INSTALL_ACCESS defender_matching_block=1123 time=$($event.TimeCreated.ToString('o')) record_id=$($event.RecordId)"
  }
} catch {
  if ($_.FullyQualifiedErrorId -like 'NoMatchingEventsFound,*') {
    Write-Output 'INSTALL_ACCESS defender_matching_block=not_found'
  } else {
    Write-Output "INSTALL_ACCESS defender_check_unavailable=$($_.Exception.Message)"
  }
}
