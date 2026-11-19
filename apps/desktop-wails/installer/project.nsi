Unicode true

####
## Alice Desktop — NSIS installer (Wails v2).
##
## Customised from Wails' stock template for two reasons:
##   1. The app is not just the exe: it ships a self-contained Python backend
##      (resources/python) plus the agent runtime tree (resources/alice), so an
##      installer-managed machine needs no git checkout and no `alice` CLI.
##   2. User scope by default (`wails build -installscope user`), so installing
##      and updating never raises UAC.
##
## Source of truth: apps/desktop-wails/installer/project.nsi. build.ps1 copies
## it into build\windows\installer\ (build/ is gitignored, the script isn't).
## Paths below are relative to build\windows\installer.
##
## Build:  wails build -platform windows/amd64 -nsis -installscope user
## Output: build\bin\alice-desktop-amd64-installer.exe
####

## Overrides MUST come before the include: wails_tools.nsh only fills in the
## values that aren't already defined (redefining after it is a compile error).
## The product surfaces as "Alice" (shortcut + Add/Remove Programs) while the
## executable stays alice-desktop.exe.
!define INFO_PRODUCTNAME "Alice"
!define INFO_PROJECTNAME "alice-desktop"
!define PRODUCT_EXECUTABLE "alice-desktop.exe"

## Wails writes wails_tools.nsh from the project data before invoking makensis.
!include "wails_tools.nsh"

# The version information for these two must consist of 4 parts
VIProductVersion "${INFO_PRODUCTVERSION}.0"
VIFileVersion    "${INFO_PRODUCTVERSION}.0"

VIAddVersionKey "CompanyName"     "${INFO_COMPANYNAME}"
VIAddVersionKey "FileDescription" "${INFO_PRODUCTNAME} Installer"
VIAddVersionKey "ProductVersion"  "${INFO_PRODUCTVERSION}"
VIAddVersionKey "FileVersion"     "${INFO_PRODUCTVERSION}"
VIAddVersionKey "LegalCopyright"  "${INFO_COPYRIGHT}"
VIAddVersionKey "ProductName"     "${INFO_PRODUCTNAME}"

ManifestDPIAware true

!include "MUI.nsh"

!define MUI_ICON "..\icon.ico"
!define MUI_UNICON "..\icon.ico"
!define MUI_FINISHPAGE_NOAUTOCLOSE
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\${PRODUCT_EXECUTABLE}"
!define MUI_FINISHPAGE_RUN_TEXT "Start Alice"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

Name "${INFO_PRODUCTNAME}"
OutFile "..\..\bin\${INFO_PROJECTNAME}-${ARCH}-installer.exe"
!ifdef WAILS_INSTALL_SCOPE
  !if "${WAILS_INSTALL_SCOPE}" == "user"
    InstallDir "$LOCALAPPDATA\Programs\${INFO_PRODUCTNAME}"
  !else
    InstallDir "$PROGRAMFILES64\${INFO_COMPANYNAME}\${INFO_PRODUCTNAME}"
  !endif
!else
  InstallDir "$PROGRAMFILES64\${INFO_COMPANYNAME}\${INFO_PRODUCTNAME}"
!endif
ShowInstDetails show

Function .onInit
   !insertmacro wails.checkArchitecture
FunctionEnd

Section
    !insertmacro wails.setShellContext

    !insertmacro wails.webview2runtime

    SetOutPath $INSTDIR

    # The Wails binary itself.
    !insertmacro wails.files

    # Self-contained Python backend (python.exe at the root of this tree).
    SetOutPath "$INSTDIR\resources\python"
    File /r "..\..\bin\resources\python\*.*"

    # Agent runtime tree: python_manager.go resolves <exe>\resources\alice and
    # runs `python -m alice_cli.main serve` with it on PYTHONPATH.
    SetOutPath "$INSTDIR\resources\alice"
    File /r "..\..\bin\resources\alice\*.*"

    # Standalone icon for the shortcuts (avoids shell icon-cache staleness on
    # upgrade — see install.ps1's New-DesktopShortcuts).
    SetOutPath "$INSTDIR\resources"
    File "..\..\bin\resources\icon.ico"

    SetOutPath $INSTDIR

    CreateShortcut "$SMPROGRAMS\${INFO_PRODUCTNAME}.lnk" "$INSTDIR\${PRODUCT_EXECUTABLE}" "" "$INSTDIR\resources\icon.ico"
    CreateShortCut "$DESKTOP\${INFO_PRODUCTNAME}.lnk" "$INSTDIR\${PRODUCT_EXECUTABLE}" "" "$INSTDIR\resources\icon.ico"

    !insertmacro wails.associateFiles
    !insertmacro wails.associateCustomProtocols

    !insertmacro wails.writeUninstaller
SectionEnd

Section "uninstall"
    !insertmacro wails.setShellContext

    RMDir /r "$AppData\${PRODUCT_EXECUTABLE}" # Remove the WebView2 DataPath
    RMDir /r $INSTDIR

    Delete "$SMPROGRAMS\${INFO_PRODUCTNAME}.lnk"
    Delete "$DESKTOP\${INFO_PRODUCTNAME}.lnk"

    !insertmacro wails.unassociateFiles
    !insertmacro wails.unassociateCustomProtocols

    !insertmacro wails.deleteUninstaller
SectionEnd
