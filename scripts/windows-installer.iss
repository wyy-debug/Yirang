[Setup]
AppId={{A79AE040-D672-4F46-B7BD-35D249950733}
AppName=一壤 · Yirang
AppVersion={#AppVersion}
AppPublisher=Yirang
DefaultDirName={localappdata}\Programs\AI Desktop
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
DisableProgramGroupPage=yes
DisableDirPage=no
OutputDir={#RepoDir}\release\installers
OutputBaseFilename=Yirang-{#AppVersion}-Setup-x64
SetupIconFile={#RepoDir}\assets\brand\yirang.ico
UninstallDisplayIcon={app}\versions\{#BuildId}\Yirang.exe
Compression=lzma2/fast
SolidCompression=yes
WizardStyle=modern
CloseApplications=no
RestartApplications=no
SetupLogging=yes

[Files]
Source: "{#RepoDir}\scripts\installer-access-diagnostics.ps1"; Flags: dontcopy
Source: "{#SourceDir}\*"; DestDir: "{app}\versions\{#BuildId}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#StagingDir}\installed.json"; DestDir: "{app}\versions\{#BuildId}"; Flags: ignoreversion
Source: "{#StagingDir}\activate.mjs"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{userprograms}\一壤 · Yirang"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""{app}\start-desktop.ps1"""; IconFilename: "{app}\versions\{#BuildId}\Yirang.exe"
Name: "{userdesktop}\一壤 · Yirang"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""{app}\start-desktop.ps1"""; IconFilename: "{app}\versions\{#BuildId}\Yirang.exe"

[Run]
Filename: "{app}\versions\{#BuildId}\Yirang.exe"; Description: "启动一壤 · Yirang"; Flags: nowait postinstall skipifsilent unchecked

[UninstallDelete]
Type: files; Name: "{app}\current.json"
Type: files; Name: "{app}\start-desktop.ps1"

[Code]
var
  InstallStepFailed: Boolean;

function CreateDirectoryWin(const Path: String; SecurityAttributes: LongWord): LongInt;
  external 'CreateDirectoryW@kernel32.dll stdcall';

function InstallFailure(const Step, Path, Detail: String): String;
begin
  Log('[Yirang] 失败步骤=' + Step + ' | 路径=' + Path + ' | ' + Detail);
  Result := Step + #13#10 + Path + #13#10 + Detail + #13#10#13#10 +
    '安装日志：' + ExpandConstant('{log}');
end;

procedure LogDirectoryAccess(const Path: String);
var
  Code: Integer;
begin
  try
    ExtractTemporaryFile('installer-access-diagnostics.ps1');
    if not ExecAndLogOutput(
      ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
      ExpandConstant('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{tmp}\installer-access-diagnostics.ps1"') +
      ' -FailedPath "' + Path + '" -SetupImage "' + ExpandConstant('{srcexe}') + '"',
      '', SW_HIDE, ewWaitUntilTerminated, Code, nil)
    then
      Log('[Yirang] 无法启动目录权限诊断 | Windows 错误 ' + IntToStr(Code))
    else if Code <> 0 then
      Log('[Yirang] 目录权限诊断退出码 ' + IntToStr(Code));
  except
    Log('[Yirang] 无法读取目录权限诊断 | ' + GetExceptionMessage);
  end;
end;

function CheckInstallDirectory(const Path: String; var Created: TArrayOfString): String;
var
  Parent, Detail: String;
  Code, Index: Integer;
begin
  Result := '';
  if DirExists(Path) then
    Exit;

  Parent := ExtractFileDir(Path);
  if (Parent <> '') and (CompareText(Parent, Path) <> 0) then begin
    Result := CheckInstallDirectory(Parent, Created);
    if Result <> '' then
      Exit;
  end;

  Log('[Yirang] 检查目录创建权限：' + Path);
  if CreateDirectoryWin(Path, 0) <> 0 then begin
    Index := GetArrayLength(Created);
    SetArrayLength(Created, Index + 1);
    Created[Index] := Path;
    Exit;
  end;

  Code := DLLGetLastError;
  if (Code = 183) and DirExists(Path) then
    Exit;
  Detail := 'Windows 错误 ' + IntToStr(Code) + '：' + SysErrorMessage(Code);
  if Code = 5 then begin
    if (Parent <> '') and (CompareText(Parent, Path) <> 0) then
      LogDirectoryAccess(Path);
    Detail := Detail + #13#10 +
      'Windows 拒绝在这个位置创建文件夹。安装日志包含目录权限和拦截记录的检查结果。'
  end else if (Code = 183) and FileExists(Path) then
    Detail := Detail + #13#10 + '这个位置已有同名文件。请选择其他安装目录。';
  Result := InstallFailure('无法创建安装目录', Path, Detail);
end;

function CheckInstallTarget(const Root: String): String;
var
  Created: TArrayOfString;
  Target: String;
  Index: Integer;
begin
  Target := AddBackslash(Root) + 'versions\{#BuildId}';
  Log('[Yirang] 安装预检 | 版本={#AppVersion} | 目标=' + Target);
  try
    Result := CheckInstallDirectory(Target, Created);
  finally
    { Leave directory creation and rollback to Setup after the probe. }
    for Index := GetArrayLength(Created) - 1 downto 0 do
      if not RemoveDir(Created[Index]) then
        Log('[Yirang] 无法移除预检创建的空目录：' + Created[Index]);
  end;
  if Result = '' then
    Log('[Yirang] 安装目录预检通过');
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Problem: String;
begin
  Result := True;
  if (CurPageID = wpSelectDir) and not WizardSilent then begin
    Problem := CheckInstallTarget(WizardDirValue);
    if Problem <> '' then begin
      MsgBox(Problem, mbError, MB_OK);
      Result := False;
    end;
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := CheckInstallTarget(ExpandConstant('{app}'));
end;

procedure RunInstallStep(const Step, Exe, Params: String);
var
  Code: Integer;
  Detail: String;
begin
  Log('[Yirang] 开始步骤=' + Step + ' | 程序=' + Exe);
  Detail := '';
  try
    if not ExecAndLogOutput(Exe, Params, '', SW_HIDE, ewWaitUntilTerminated, Code, nil) then
      Detail := '无法启动程序。Windows 错误 ' + IntToStr(Code) + '：' + SysErrorMessage(Code)
    else if Code <> 0 then
      Detail := '程序退出码 ' + IntToStr(Code);
  except
    Detail := GetExceptionMessage;
  end;
  if Detail <> '' then begin
    InstallStepFailed := True;
    RaiseException(InstallFailure(Step + '失败', Exe, Detail));
  end;
  Log('[Yirang] 完成步骤=' + Step);
end;

function GetCustomSetupExitCode: Integer;
begin
  { Inno may report 0 when a Pascal post-install step raises an exception. }
  Result := 0;
  if InstallStepFailed then
    Result := 20;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then begin
    RunInstallStep('激活安装版本',
      ExpandConstant('{app}\versions\{#BuildId}\runtime\node.exe'),
      ExpandConstant('"{app}\activate.mjs" "{app}"'));
    if not WizardNoIcons then
      RunInstallStep('创建快捷方式',
        ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
        ExpandConstant('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{app}\versions\{#BuildId}\resources\app\apps\electron\install-shortcuts.ps1" -InstallRoot "{app}"'));
  end;
end;
