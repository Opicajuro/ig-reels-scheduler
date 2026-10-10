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
