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
PrivilegesRequired=lowest

[Files]
Source: "payload\app\*"; DestDir: "{app}\app"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "payload\tools\*"; DestDir: "{app}\tools"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "start-localirs.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "setup-localirs.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "services.ps1"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\Set up Localirs"; Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -File ""{app}\setup-localirs.ps1"""; WorkingDir: "{app}"
Name: "{group}\Start Localirs"; Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -File ""{app}\start-localirs.ps1"""; WorkingDir: "{app}"
Name: "{group}\Uninstall Localirs"; Filename: "{uninstallexe}"

[Run]
Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -File ""{app}\setup-localirs.ps1"""; Description: "Set up Localirs now"; Flags: postinstall shellexec skipifsilent

[Code]
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
  end;
end;
