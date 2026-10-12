; Inno Setup script for Localirs. Build with installer\build-installer.ps1.
#define AppName "Localirs"
#define AppVersion "0.1.0"

[Setup]
AppName={#AppName}
AppVersion={#AppVersion}
DefaultDirName={localappdata}\Localirs
DefaultGroupName=Localirs
OutputDir=Output
OutputBaseFilename=Localirs-Setup
Compression=lzma2/max
SolidCompression=yes
LZMANumBlockThreads=4
LZMAUseSeparateProcess=yes
DisableProgramGroupPage=yes
; Always show the folder page. On an update it is filled in with the current folder, so Next updates in place.
DisableDirPage=no
PrivilegesRequired=lowest

[Files]
Source: "payload\app\*"; DestDir: "{app}\app"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "payload\tools\*"; DestDir: "{app}\tools"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "start-localirs.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "setup-localirs.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "services.ps1"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\Start Localirs"; Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -File ""{app}\start-localirs.ps1"""; WorkingDir: "{app}"
Name: "{group}\Uninstall Localirs"; Filename: "{uninstallexe}"

[Code]
const
  // Free-mail domains can never be verified in Resend, so sign-in email from them never arrives.
  FreeMailDomains = '|gmail|googlemail|outlook|hotmail|live|msn|yahoo|icloud|me|aol|gmx|proton|protonmail|seznam|azet|centrum|zoznam|post|';

var
  ResendPage: TInputQueryWizardPage;

procedure InitializeWizard;
begin
  ResendPage := CreateInputQueryPage(wpSelectDir,
    'Sign-in email',
    'Localirs emails sign-in links through Resend (https://resend.com). Keep the sender address unless you verified your own domain in Resend.',
    'Leave the API key empty to keep the one from an earlier install.');
  ResendPage.Add('Resend API key (starts with re_):', True);
  ResendPage.Add('Sender address:', False);
  ResendPage.Values[1] := 'Localirs <onboarding@resend.dev>';
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

function ResendPageValid: Boolean;
var
  Key, Sender: String;
begin
  Key := ResendPage.Values[0];
  Sender := ResendPage.Values[1];
  Result := False;
  if (Key = '') and (not FileExists(ExpandConstant('{app}\data\secrets.json'))) then
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
  else if CurPageID = ResendPage.ID then
    Result := ResendPageValid;
end;

// Runs the setup hidden, with its progress on the install screen. Its output goes to data\setup.log.
procedure CurStepChanged(CurStep: TSetupStep);
var
  AppDir, Params: String;
  ResultCode: Integer;
begin
  if CurStep = ssPostInstall then
  begin
    AppDir := ExpandConstant('{app}');
    Params := '-ExecutionPolicy Bypass -File "' + AppDir + '\setup-localirs.ps1" -ResendApiKey "' + ResendPage.Values[0] + '" -EmailFrom "' + ResendPage.Values[1] + '"';
    WizardForm.StatusLabel.Caption := 'Setting up the database and file storage. The first time this takes a few minutes.';
    if (not Exec('powershell.exe', Params, AppDir, SW_HIDE, ewWaitUntilTerminated, ResultCode)) or (ResultCode <> 0) then
      MsgBox('Localirs is installed, but its setup did not finish. The details are in ' + AppDir + '\data\setup.log.' + #13#10 + #13#10 + 'Fix the problem, then run the installer again.', mbError, MB_OK);
  end;
end;
