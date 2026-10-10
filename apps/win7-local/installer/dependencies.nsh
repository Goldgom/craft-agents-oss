!include nsDialogs.nsh
!include LogicLib.nsh
!include MUI2.nsh

!ifndef BUILD_UNINSTALLER
Var depDialog
Var depGit
Var depPython
Var depJava
Var depUpdate
Var depNode
Var depMingw
Var selGit
Var selPython
Var selJava
Var selUpdate
Var selNode
Var selMingw
Var nodeBase
Var mingwBase
Var nodePath
Var mingwPath
Var dirControl
Var pathControl
Var archiveKind
Var depExit

!macro customInit
  StrCpy $selGit 0
  StrCpy $selPython 0
  StrCpy $selJava 0
  StrCpy $selUpdate 0
  StrCpy $selNode 0
  StrCpy $selMingw 0
  StrCpy $nodePath 0
  StrCpy $mingwPath 0
  StrCpy $nodeBase "$LOCALAPPDATA\TokenBird-Tools"
  StrCpy $mingwBase "$LOCALAPPDATA\TokenBird-Tools"
!macroend

!macro customPageAfterChangeDir
  Page custom DependencyPage DependencyLeave
  Page custom NodeDirectoryPage ArchiveDirectoryLeave
  Page custom MingwDirectoryPage ArchiveDirectoryLeave
!macroend

!macro DepCheckbox y text handle selected
  ${NSD_CreateCheckbox} 0 ${y}u 100% 12u "${text}"
  Pop ${handle}
  ${NSD_SetState} ${handle} ${selected}
!macroend

Function DependencyPage
  IfSilent 0 +2
    Abort
  !insertmacro MUI_HEADER_TEXT "可选外部工具 / Optional tools" "全部不勾选即可跳过；不影响 TokenBird 本体安装。"
  nsDialogs::Create 1018
  Pop $depDialog
  ${If} $depDialog == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 24u "工具由各自安装程序安装，可能要求管理员权限；取消或失败不会阻止本体安装。"
  Pop $0
  !insertmacro DepCheckbox 28 "Git 2.46.2 x64（含 Git Bash）" $depGit $selGit
  !insertmacro DepCheckbox 44 "Python 3.8.10 x64" $depPython $selPython
  !insertmacro DepCheckbox 60 "Oracle JDK 21（官方不支持 Win7，谨慎选择）" $depJava $selJava
  !insertmacro DepCheckbox 76 "KB3080149 x64（可选遥测更新，非运行库补丁）" $depUpdate $selUpdate
  !insertmacro DepCheckbox 92 "Node.js 18.16.0 ZIP（官方不支持 Win7，谨慎选择）" $depNode $selNode
  !insertmacro DepCheckbox 108 "MinGW-w64 GCC 16.2 7z（UCRT 版，需匹配系统运行库）" $depMingw $selMingw
  ${NSD_CreateLabel} 0 128u 100% 32u "Node/MinGW 下一页选择解压目录和用户 PATH。外部工具不会替换 TokenBird 内置运行时，也不会随本软件卸载。"
  Pop $0
  nsDialogs::Show
FunctionEnd

Function DependencyLeave
  ${NSD_GetState} $depGit $selGit
  ${NSD_GetState} $depPython $selPython
  ${NSD_GetState} $depJava $selJava
  ${NSD_GetState} $depUpdate $selUpdate
  ${NSD_GetState} $depNode $selNode
  ${NSD_GetState} $depMingw $selMingw
  ${If} $selJava == 1
  ${OrIf} $selNode == 1
    MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "所选官方 Node 18 / Oracle JDK 21 不支持 Win7。打包并不代表已修复其系统要求。仍要尝试安装这些文件吗？" IDYES riskAccepted
    Abort
    riskAccepted:
  ${EndIf}
FunctionEnd

Function NodeDirectoryPage
  ${If} $selNode != 1
    Abort
  ${EndIf}
  StrCpy $archiveKind node
  !insertmacro MUI_HEADER_TEXT "Node.js 安装目录" "解压到所选目录的 node-v18.16.0-win-x64 子目录。"
  Call ArchiveDirectoryPage
FunctionEnd
Function MingwDirectoryPage
  ${If} $selMingw != 1
    Abort
  ${EndIf}
  StrCpy $archiveKind mingw
  !insertmacro MUI_HEADER_TEXT "MinGW 安装目录" "解压到所选目录的 mingw64 子目录；需要约 1 GiB 可用空间。"
  Call ArchiveDirectoryPage
FunctionEnd
Function ArchiveDirectoryPage
  nsDialogs::Create 1018
  Pop $depDialog
  ${If} $depDialog == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 24u "请选择有写入权限的本地目录。已有同名工具目录不会被覆盖；解压失败可查安装日志。"
  Pop $0
  ${NSD_CreateDirRequest} 0 34u 78% 14u ""
  Pop $dirControl
  ${NSD_CreateBrowseButton} 80% 34u 20% 14u "浏览..."
  Pop $0
  ${NSD_OnClick} $0 BrowseArchiveDirectory
  ${NSD_CreateCheckbox} 0 60u 100% 14u "添加到当前用户 PATH（不修改系统 PATH）"
  Pop $pathControl
  ${If} $archiveKind == node
    ${NSD_SetText} $dirControl $nodeBase
    ${NSD_SetState} $pathControl $nodePath
  ${Else}
    ${NSD_SetText} $dirControl $mingwBase
    ${NSD_SetState} $pathControl $mingwPath
  ${EndIf}
  ${NSD_CreateLabel} 0 90u 100% 42u "不添加 PATH 时仍记录位置供 TokenBird 使用。PATH 选项用于其他终端；建议安装完成后重新登录或重启。Git/Python/Java 的位置和 PATH 请在各自安装向导中选择。"
  Pop $0
  nsDialogs::Show
FunctionEnd
Function BrowseArchiveDirectory
  Pop $0
  ${NSD_GetText} $dirControl $1
  nsDialogs::SelectFolderDialog "选择工具解压目录" "$1"
  Pop $0
  ${If} $0 != error
    ${NSD_SetText} $dirControl $0
  ${EndIf}
FunctionEnd
Function ArchiveDirectoryLeave
  ${NSD_GetText} $dirControl $0
  ${If} $0 == ""
    MessageBox MB_OK|MB_ICONEXCLAMATION "请选择工具解压目录。"
    Abort
  ${EndIf}
  ${If} $archiveKind == node
    StrCpy $nodeBase $0
    ${NSD_GetState} $pathControl $nodePath
    StrCpy $1 "$nodeBase\node-v18.16.0-win-x64"
  ${Else}
    StrCpy $mingwBase $0
    ${NSD_GetState} $pathControl $mingwPath
    StrCpy $1 "$mingwBase\mingw64"
  ${EndIf}
  IfFileExists "$1" 0 directoryAccepted
    MessageBox MB_OK|MB_ICONEXCLAMATION "目标已存在：$1。请选择其他目录，以免覆盖已有文件。"
    Abort
  directoryAccepted:
FunctionEnd

!macro WriteSelection id selected
  WriteINIStr "$PLUGINSDIR\dependencies-selection.ini" "${id}" "selected" "${selected}"
!macroend
!macro customInstall
  ${If} $selGit == 1
  ${OrIf} $selPython == 1
  ${OrIf} $selJava == 1
  ${OrIf} $selUpdate == 1
  ${OrIf} $selNode == 1
  ${OrIf} $selMingw == 1
    InitPluginsDir
    SetOutPath "$PLUGINSDIR\win7-dependencies"
    # Already-compressed offline payloads: do not recompress them into ASAR.
    SetCompress off
    File /r "${PROJECT_DIR}\dist\installer-payload\*"
    SetCompress auto
    # Force Unicode INI so non-ANSI user-chosen paths survive WriteINIStr.
    FileOpen $0 "$PLUGINSDIR\dependencies-selection.ini" w
    FileWriteWord $0 0xFEFF
    FileClose $0
    !insertmacro WriteSelection git $selGit
    !insertmacro WriteSelection python $selPython
    !insertmacro WriteSelection java $selJava
    !insertmacro WriteSelection update $selUpdate
    !insertmacro WriteSelection node $selNode
    !insertmacro WriteSelection mingw $selMingw
    WriteINIStr "$PLUGINSDIR\dependencies-selection.ini" "node" "directory" "$nodeBase"
    WriteINIStr "$PLUGINSDIR\dependencies-selection.ini" "node" "addPath" "$nodePath"
    WriteINIStr "$PLUGINSDIR\dependencies-selection.ini" "mingw" "directory" "$mingwBase"
    WriteINIStr "$PLUGINSDIR\dependencies-selection.ini" "mingw" "addPath" "$mingwPath"
    DetailPrint "正在打开所选 Git / Python / Java 原生安装界面；请逐个完成向导（不会静默安装）..."
    # Keep current user identity. Only the selected native setups request UAC.
    # NSIS is x86; invoke native x64 PowerShell to discover x64 registry keys.
    ${DisableX64FSRedirection}
    ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "$PLUGINSDIR\win7-dependencies\install-dependencies.ps1" -PayloadDirectory "$PLUGINSDIR\win7-dependencies" -SelectionFile "$PLUGINSDIR\dependencies-selection.ini"' $depExit
    ${EnableX64FSRedirection}
    ${If} $depExit == 3010
      MessageBox MB_OK|MB_ICONINFORMATION "工具安装或 PATH 已更新。建议重启 Windows；安装程序不会主动重启。"
    ${ElseIf} $depExit != 0
      MessageBox MB_OK|MB_ICONEXCLAMATION "部分外部工具未成功安装或被取消。TokenBird 本体已安装，可继续使用。详情：%APPDATA%\TokenBird-Win7-Local\dependency-install.log。Python 详细日志：同目录 python-setup.log。"
    ${EndIf}
    SetOutPath "$INSTDIR"
  ${EndIf}
!macroend
!endif
