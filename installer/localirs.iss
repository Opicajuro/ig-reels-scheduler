; Inno Setup script for Localirs. Build with installer\build-installer.ps1.
#define AppName "Localirs"
; The CI run number this installer was built by (0 for a local build), from build-installer.ps1. The tray launcher
; compares it with the newest release to offer updates.
#ifndef AppBuild
  #error Pass the build number: ISCC /DAppBuild=<n>
#endif

[Setup]
AppName={#AppName}
AppVersion=0.1.{#AppBuild}
DefaultDirName={localappdata}\Localirs
DefaultGroupName=Localirs
OutputDir=Output
OutputBaseFilename=Localirs-Setup
Compression=lzma2/fast
SolidCompression=yes
LZMANumBlockThreads=8
LZMAUseSeparateProcess=yes
DisableProgramGroupPage=yes
; Always show the folder page. On an update it is filled in with the current folder, so Next updates in place.
DisableDirPage=no
PrivilegesRequired=lowest
SetupIconFile=launcher\localirs.ico
UninstallDisplayIcon={app}\Localirs.exe
; Localirs.exe holds this mutex while it runs. Its services lock their files, so setup asks you to quit it first.
AppMutex=Localirs.Launcher

[Tasks]
Name: "desktopicon"; Description: "Create a desktop icon"; GroupDescription: "Shortcuts:"

[Files]
Source: "payload\Localirs.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "payload\app\*"; DestDir: "{app}\app"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "payload\tools\*"; DestDir: "{app}\tools"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "start-localirs.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "stop-localirs.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "setup-localirs.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "services.ps1"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\Localirs"; Filename: "{app}\Localirs.exe"; WorkingDir: "{app}"
Name: "{autodesktop}\Localirs"; Filename: "{app}\Localirs.exe"; WorkingDir: "{app}"; Tasks: desktopicon
Name: "{group}\Uninstall Localirs"; Filename: "{uninstallexe}"

[Run]
; Not skipped when silent: an update from the tray icon runs setup silently, and this reopens Localirs after it.
Filename: "{app}\Localirs.exe"; Description: "Open Localirs now"; Flags: postinstall nowait

[UninstallDelete]
; Written by the code below, so the uninstaller does not know it.
Type: files; Name: "{app}\version.txt"

[UninstallRun]
; Stops the web app, worker, storage and database so their files can be removed.
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\stop-localirs.ps1"""; Flags: runhidden waituntilterminated; RunOnceId: "StopLocalirs"

[Code]
const
  // Free-mail domains can never be verified in Resend, so email sent from them never arrives.
  FreeMailDomains = '|gmail|googlemail|outlook|hotmail|live|msn|yahoo|icloud|me|aol|gmx|proton|protonmail|seznam|azet|centrum|zoznam|post|';

var
  AlertPage: TInputQueryWizardPage;

procedure InitializeWizard;
begin
  AlertPage := CreateInputQueryPage(wpSelectDir,
    'Email me when a post fails (optional)',
    'Localirs can email you when a scheduled Reel fails, through Resend (https://resend.com). Leave everything empty to skip it; failures still show in the app.',
    'Keep the sender address unless you verified your own domain in Resend. Empty fields keep what an earlier install saved.');
  AlertPage.Add('Your email address:', False);
  AlertPage.Add('Resend API key (starts with re_):', True);
  AlertPage.Add('Sender address:', False);
  AlertPage.Values[2] := 'Localirs <onboarding@resend.dev>';
end;

function IsPlainText(Value: String): Boolean;
begin
  // The values go into .env and a command line, so they cannot hold quotes or line breaks.
  Result := (Pos('"', Value) = 0) and (Pos('''', Value) = 0) and (Pos(#13, Value) = 0) and (Pos(#10, Value) = 0);
end;

function IsFreeMailSender(Address: String): Boolean;
var
  Domain: String;
  Dot: Integer;
begin
  Domain := Copy(LowerCase(Address), Pos('@', Address) + 1, Length(Address));
  Dot := Pos('.', Domain);
  if Dot > 0 then Domain := Copy(Domain, 1, Dot - 1);
  Result := Pos('|' + Domain + '|', FreeMailDomains) > 0;
end;

// Empty email and key: no change. Otherwise the email, key and sender must all be usable.
function AlertPageValid: Boolean;
var
  Email, Key, Sender: String;
begin
  Email := AlertPage.Values[0];
  Key := AlertPage.Values[1];
  Sender := AlertPage.Values[2];
  Result := False;
  if (Email = '') and (Key = '') then
    Result := True
  else if (Pos('@', Email) = 0) or (not IsPlainText(Email)) then
    MsgBox('Enter the email address the failure emails should go to.', mbError, MB_OK)
  else if (Key = '') and (not FileExists(ExpandConstant('{app}\data\secrets.json'))) then
    MsgBox('Enter your Resend API key. You can create one at https://resend.com/api-keys.', mbError, MB_OK)
  else if not IsPlainText(Key) then
    MsgBox('The Resend API key cannot contain quotes or line breaks.', mbError, MB_OK)
  else if (Pos('@', Sender) = 0) or (not IsPlainText(Sender)) then
    MsgBox('Enter a sender address such as Localirs <onboarding@resend.dev>.', mbError, MB_OK)
  else if IsFreeMailSender(Sender) then
    MsgBox('Resend cannot send from gmail.com, outlook.com or similar addresses. Use Localirs <onboarding@resend.dev>, or an address on a domain you verified in Resend.', mbError, MB_OK)
  else
    Result := True;
end;

// PostgreSQL fails to create its database ("invalid byte sequence for encoding UTF8") when its folder path has
// letters outside plain ASCII, with accents (such as a Slovak folder name). Refuse such a folder before installing.
function NextButtonClick(CurPageID: Integer): Boolean;
var
  Dir: String;
  I: Integer;
begin
  Result := True;
  if CurPageID = wpSelectDir then
  begin
    Dir := WizardDirValue;
    for I := 1 to Length(Dir) do
      if Ord(Dir[I]) > 127 then
      begin
        MsgBox('Please choose a folder whose path uses only plain English letters and digits, for example C:\Localirs.' + #13#10 + #13#10 + 'The database Localirs uses cannot start from a folder with accented letters.', mbError, MB_OK);
        Result := False;
        Exit;
      end;
  end
  else if CurPageID = AlertPage.ID then
    Result := AlertPageValid;
end;

// An update cannot replace files that Localirs's services hold open, so stop them first. The stop script comes from
// this setup, because versions before the tray launcher have none in their folder.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  AppDir: String;
  ResultCode: Integer;
begin
  Result := '';
  AppDir := ExpandConstant('{app}');
  if not DirExists(AppDir) then Exit;
  ExtractTemporaryFile('stop-localirs.ps1');
  ExtractTemporaryFile('services.ps1');
  if (not Exec('powershell.exe', '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{tmp}\stop-localirs.ps1') + '" -InstallDir "' + AppDir + '"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode)) or (ResultCode <> 0) then
    Result := 'Localirs is still running and could not be stopped. The details are in ' + AppDir + '\data\stop.log. Restart the PC, then run this setup again.';
end;

// Records the build, then runs the setup hidden, with its progress on the install screen. Its output goes to data\setup.log.
// The sender is only passed with a key, so an empty page changes nothing. A silent update skips the page, so it is empty.
procedure CurStepChanged(CurStep: TSetupStep);
var
  AppDir, Params, Sender: String;
  ResultCode: Integer;
begin
  if CurStep = ssPostInstall then
  begin
    AppDir := ExpandConstant('{app}');
    if not SaveStringToFile(AppDir + '\version.txt', '{#AppBuild}', False) then
      RaiseException('Could not write ' + AppDir + '\version.txt');
    Sender := '';
    if AlertPage.Values[1] <> '' then Sender := AlertPage.Values[2];
    Params := '-ExecutionPolicy Bypass -File "' + AppDir + '\setup-localirs.ps1" -AlertEmail "' + AlertPage.Values[0] + '" -ResendApiKey "' + AlertPage.Values[1] + '" -EmailFrom "' + Sender + '"';
    WizardForm.StatusLabel.Caption := 'Setting up the database and file storage. The first time this takes a few minutes.';
    if (not Exec('powershell.exe', Params, AppDir, SW_HIDE, ewWaitUntilTerminated, ResultCode)) or (ResultCode <> 0) then
      MsgBox('Localirs is installed, but its setup did not finish. The details are in ' + AppDir + '\data\setup.log.' + #13#10 + #13#10 + 'Fix the problem, then run the installer again.', mbError, MB_OK);
  end;
end;
