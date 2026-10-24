Unicode True
!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"
!include "WinVer.nsh"

!ifndef APP_VERSION
  !error "APP_VERSION is required"
!endif
!ifndef PAYLOAD
  !error "PAYLOAD is required"
!endif
Name "AutoReply"
OutFile "${OUTPUT}"
InstallDir "$LOCALAPPDATA\AutoReply"
RequestExecutionLevel user
SetCompressor zlib
VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey "ProductName" "AutoReply"
VIAddVersionKey "LegalCopyright" "AutoReply"
VIAddVersionKey "FileDescription" "AutoReply 安装程序"
VIAddVersionKey "FileVersion" "${APP_VERSION}"

Var KeyInput
Var KeyValue
Var Dialog
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
Page custom KeyPage KeyPageLeave
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_TEXT "安装完成。请在 Chrome 或 Edge 扩展管理页加载安装目录中的 extension 文件夹。插件会自动连接本机组件。"
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

!macro CheckNotRunning
  System::Call 'kernel32::OpenMutexW(i 0x100000, i 0, w "Local\AutoReply.Component.InUse") p.r0'
  ${If} $0 != 0
    System::Call 'kernel32::CloseHandle(p r0)'
    MessageBox MB_OK|MB_ICONINFORMATION "AutoReply 正在使用。请先暂停任务并关闭使用插件的店铺环境，再运行安装或卸载程序。"
    Abort
  ${EndIf}
!macroend

Function .onInit
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AutoReply" "InstallLocation"
  ${If} $0 != ""
    StrCpy $INSTDIR $0
  ${EndIf}
  ${IfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONSTOP "当前安装包适用于 Windows 10 / 11 x64。"
    Abort
  ${EndIf}
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_OK|MB_ICONSTOP "当前安装包需要 Windows 10 / 11。"
    Abort
  ${EndIf}
  ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full" "Release"
  ${If} $0 < 528040
    MessageBox MB_OK|MB_ICONSTOP "请先安装或启用 Windows 的 .NET Framework 4.8，再运行安装程序。"
    Abort
  ${EndIf}
  !insertmacro CheckNotRunning
FunctionEnd
Function un.onInit
  !insertmacro CheckNotRunning
FunctionEnd

Function KeyPage
  !insertmacro MUI_HEADER_TEXT "模型账户（可选）" "现在填写 OpenRouter API Key，也可安装后在插件的“模型账户”填写。"
  nsDialogs::Create 1018
  Pop $Dialog
  ${NSD_CreateLabel} 0 0 100% 32u "OpenRouter API Key 只加密保存在当前电脑，不保存在插件或店铺资料中。"
  Pop $0
  ${NSD_CreateLabel} 0 46u 100% 12u "OpenRouter API Key"
  Pop $0
  ${NSD_CreatePassword} 0 62u 100% 14u ""
  Pop $KeyInput
  ${If} ${FileExists} "$INSTDIR\config\openrouter-key.dat"
    ${NSD_CreateLabel} 0 86u 100% 25u "已保存账户凭据。留空保留原值，填写新 Key 则替换。"
    Pop $0
  ${Else}
    ${NSD_CreateLabel} 0 86u 100% 25u "可留空完成安装，之后在插件中填写 API Key。"
    Pop $0
  ${EndIf}
  nsDialogs::Show
FunctionEnd

Function KeyPageLeave
  ${NSD_GetText} $KeyInput $KeyValue
FunctionEnd

Function SaveKey
  ${If} $KeyValue == ""
    Return
  ${EndIf}
  ; CryptProtectData uses UTF-16 bytes; the launcher decrypts with CurrentUser.
  StrCpy $0 $KeyValue
  StrLen $2 $0
  IntOp $2 $2 * 2
  System::Call '*(&w${NSIS_MAX_STRLEN} r0) p.r1'
  System::Call '*(i r2, p r1) p.r3'
  System::Call '*(i 0, p 0) p.r4'
  System::Call 'crypt32::CryptProtectData(p r3, p 0, p 0, p 0, p 0, i 1, p r4) i.r5'
  ${If} $5 = 0
    MessageBox MB_OK|MB_ICONSTOP "无法加密保存 Key，安装未完成。"
    SetErrorLevel 1
    Abort
  ${EndIf}
  System::Call '*$4(i.r6, p.r7)'
  CreateDirectory "$INSTDIR\config"
  System::Call 'kernel32::CreateFileW(w "$INSTDIR\config\openrouter-key.tmp", i 0x40000000, i 0, p 0, i 2, i 0x80, p 0) p.r8'
  System::Call 'kernel32::WriteFile(p r8, p r7, i r6, *i.r9, p 0) i.r5'
  System::Call 'kernel32::CloseHandle(p r8)'
  System::Call 'kernel32::LocalFree(p r7)'
  System::Free $1
  System::Free $3
  System::Free $4
  StrCpy $0 ""
  StrCpy $KeyValue ""
  ${If} $5 = 0
  ${OrIf} $9 != $6
    Delete "$INSTDIR\config\openrouter-key.tmp"
    MessageBox MB_OK|MB_ICONSTOP "Key 保存失败，安装未完成。"
    SetErrorLevel 1
    Abort
  ${EndIf}
  System::Call 'kernel32::MoveFileExW(w "$INSTDIR\config\openrouter-key.tmp", w "$INSTDIR\config\openrouter-key.dat", i 9) i.r5'
  ${If} $5 = 0
    Delete "$INSTDIR\config\openrouter-key.tmp"
    MessageBox MB_OK|MB_ICONSTOP "无法更新 Key，原有凭据未被替换。"
    SetErrorLevel 1
    Abort
  ${EndIf}
FunctionEnd

Section "AutoReply"
  !insertmacro CheckNotRunning
  SetOutPath "$INSTDIR"
  File /r "${PAYLOAD}\*"
  Call SaveKey
  WriteRegStr HKCU "Software\Microsoft\Edge\NativeMessagingHosts\com.autoreply.workflow" "" "$INSTDIR\native-host.json"
  WriteRegStr HKCU "Software\Google\Chrome\NativeMessagingHosts\com.autoreply.workflow" "" "$INSTDIR\native-host.json"
  WriteRegStr HKCU "Software\Chromium\NativeMessagingHosts\com.autoreply.workflow" "" "$INSTDIR\native-host.json"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AutoReply" "DisplayName" "AutoReply"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AutoReply" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AutoReply" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AutoReply" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  CreateDirectory "$SMPROGRAMS\AutoReply"
  CreateShortcut "$SMPROGRAMS\AutoReply\安装说明.lnk" "$INSTDIR\安装说明.md"
  ${If} $EXEPATH != "$INSTDIR\AutoReplySetup.exe"
    CopyFiles /SILENT "$EXEPATH" "$INSTDIR\AutoReplySetup.exe"
  ${EndIf}
  CreateShortcut "$SMPROGRAMS\AutoReply\更新模型账户.lnk" "$INSTDIR\AutoReplySetup.exe"
SectionEnd

Section "Uninstall"
  !insertmacro CheckNotRunning
  DeleteRegKey HKCU "Software\Microsoft\Edge\NativeMessagingHosts\com.autoreply.workflow"
  DeleteRegKey HKCU "Software\Google\Chrome\NativeMessagingHosts\com.autoreply.workflow"
  DeleteRegKey HKCU "Software\Chromium\NativeMessagingHosts\com.autoreply.workflow"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AutoReply"
  RMDir /r "$SMPROGRAMS\AutoReply"
  ; Keep the independent extension files usable so it can explain a missing host.
  Delete "$INSTDIR\AutoReplyHost.exe"
  Delete "$INSTDIR\AutoReplySetup.exe"
  Delete "$INSTDIR\native-host.json"
  Delete "$INSTDIR\package.json"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir /r "$INSTDIR\runtime"
  RMDir /r "$INSTDIR\server"
  RMDir /r "$INSTDIR\config"
  RMDir "$INSTDIR"
SectionEnd
