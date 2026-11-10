; Safe page-only harness: no installation section, registry or PATH mutations.
Unicode true
Name "TokenBird dependency wizard test"
OutFile "../../../.toolchains/win7-wizard-test.exe"
RequestExecutionLevel user
InstallDir "$TEMP\TokenBird-Wizard-Test"
!include MUI2.nsh
!include dependencies.nsh
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro customPageAfterChangeDir
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_LANGUAGE "SimpChinese"
Function .onInit
  !insertmacro customInit
FunctionEnd
Section
  DetailPrint "Page-only test: nothing installed."
SectionEnd
