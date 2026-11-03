import path from 'node:path';

export const INSTALLER_MARKER='.aaw-installation';
export const INSTALLER_MARKER_BYTES='aaw.windows-installation/v1\nAnalogAIWorkbench\n';
export const UNINSTALLER='Uninstall.exe';
export function safePackagePath(value){return typeof value==='string'&&value.length>0&&value.length<512&&!value.includes('\\')&&!value.includes(':')&&!value.includes('$')&&!value.includes('"')&&!value.includes('\0')&&value.split('/').every(part=>part&&part!=='.'&&part!=='..'&&!/[\x00-\x1f<>|?*]/u.test(part)&&!/[. ]$/u.test(part)&&!/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/iu.test(part.split('.')[0]));}
const quote=value=>'"'+value.replaceAll('$','$$').replaceAll('"','$\\"')+'"';
export function packageDirectories(files){const result=new Set();for(const file of files){if(!safePackagePath(file))throw Error('INSTALLER_PACKAGE_PATH_INVALID');let directory=path.posix.dirname(file);while(directory!=='.'){result.add(directory);directory=path.posix.dirname(directory);}}return [...result].sort((a,b)=>a.split('/').length-b.split('/').length||a.localeCompare(b,'en'));}
export function preflightHeader(files){const names=[...files,UNINSTALLER],dirs=packageDirectories(files);if(new Set(names.map(f=>f.toLowerCase())).size!==names.length||names.some(f=>!safePackagePath(f)))throw Error('INSTALLER_PACKAGE_SET_INVALID');return '#pragma once\n#include <array>\nnamespace aaw_installer {\ninline constexpr std::array<const wchar_t*,'+names.length+'> packageFiles={'+names.map(f=>'L'+JSON.stringify(f)).join(',')+'};\ninline constexpr std::array<const wchar_t*,'+dirs.length+'> packageDirectories={'+dirs.map(f=>'L'+JSON.stringify(f)).join(',')+'};\n}\n';}
export function installerScript({payloadRoot,files,preflight,licenseFile,outputFile,version}){
  if(!path.isAbsolute(payloadRoot)||!path.isAbsolute(preflight)||!path.isAbsolute(outputFile)||!path.isAbsolute(licenseFile)||!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u.test(version)||files.some(f=>!safePackagePath(f))||!files.includes(INSTALLER_MARKER))throw Error('INSTALLER_SCRIPT_INPUT_INVALID');
  const q=quote,ns=value=>value.replaceAll('/','\\'),dirs=packageDirectories(files),numeric=version.split('-')[0]+'.0';
  const fileCommands=files.map(file=>{const dir=path.posix.dirname(file),base=path.posix.basename(file);return `  SetOutPath "$INSTDIR${dir==='.'?'':'\\'+ns(dir)}"\n  ClearErrors\n  File ${q('/oname='+base)} ${q(path.join(payloadRoot,...file.split('/')))}\n  IfErrors installation_failed`;}).join('\n');
  const deletions=files.filter(file=>file!==INSTALLER_MARKER).map((file,index)=>`  IfFileExists "$INSTDIR\\${ns(file)}" 0 un_file_${index}\n  ClearErrors\n  Delete "$INSTDIR\\${ns(file)}"\n  IfErrors 0 un_file_${index}\n  StrCpy $1 1\n  un_file_${index}:`).join('\n');
  return `Unicode true
!include "MUI2.nsh"
Name "Analog AI Workbench"
OutFile ${q(outputFile)}
InstallDir "$LOCALAPPDATA\\Programs\\AnalogAIWorkbench"
RequestExecutionLevel user
CRCCheck force
ManifestDPIAware true
SetCompressor /SOLID lzma
SetCompressorDictSize 32
SetOverwrite on
VIProductVersion "${numeric}"
VIAddVersionKey "ProductName" "Analog AI Workbench"
VIAddVersionKey "FileDescription" "Analog AI Workbench Setup"
VIAddVersionKey "FileVersion" "${version}"
VIAddVersionKey "LegalCopyright" "Analog AI Workbench contributors"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\\AnalogAIWorkbench.exe"
!define MUI_FINISHPAGE_RUN_TEXT "运行 Analog AI Workbench"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE ${q(licenseFile)}
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  SetShellVarContext current
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=preflight.exe ${q(preflight)}
  StrCpy $0 99
  ClearErrors
  ExecWait '"$PLUGINSDIR\\preflight.exe" validate-install "$INSTDIR"' $0
  IfErrors invalid_root
  StrCmp $0 0 valid_root
  invalid_root:
  MessageBox MB_OK|MB_ICONSTOP "安装目录不可用或含有链接。请使用当前用户的默认安装目录。" /SD IDOK
  SetErrorLevel 20
  Abort
  valid_root:
FunctionEnd

Function un.onInit
  SetShellVarContext current
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=preflight.exe ${q(preflight)}
  StrCpy $0 99
  ClearErrors
  ExecWait '"$PLUGINSDIR\\preflight.exe" validate-uninstall "$INSTDIR"' $0
  IfErrors invalid_root
  StrCmp $0 0 valid_root
  invalid_root:
  MessageBox MB_OK|MB_ICONSTOP "无法核对安装目录，已停止卸载。用户数据未删除。" /SD IDOK
  SetErrorLevel 21
  Abort
  valid_root:
FunctionEnd

Section "Analog AI Workbench"
${fileCommands}
  SetOutPath "$INSTDIR"
  ClearErrors
  WriteUninstaller "$INSTDIR\\${UNINSTALLER}"
  IfErrors installation_failed
  ReadRegStr $0 HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\AnalogAIWorkbench" "InstallLocation"
  StrCmp $0 "$INSTDIR" 0 create_shortcuts
  IfFileExists "$SMPROGRAMS\\Analog AI Workbench\\卸载.lnk" 0 create_shortcuts
  ClearErrors
  Delete "$SMPROGRAMS\\Analog AI Workbench\\卸载.lnk"
  IfErrors installation_failed
  create_shortcuts:
  ClearErrors
  CreateDirectory "$SMPROGRAMS\\Analog AI Workbench"
  CreateShortcut "$SMPROGRAMS\\Analog AI Workbench\\Analog AI Workbench.lnk" "$INSTDIR\\AnalogAIWorkbench.exe"
  CreateShortcut "$DESKTOP\\Analog AI Workbench.lnk" "$INSTDIR\\AnalogAIWorkbench.exe"
  IfErrors installation_failed
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\AnalogAIWorkbench" "DisplayName" "Analog AI Workbench"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\AnalogAIWorkbench" "DisplayVersion" "${version}"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\AnalogAIWorkbench" "Publisher" "Analog AI Workbench contributors"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\AnalogAIWorkbench" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\AnalogAIWorkbench" "UninstallString" '$\\"$INSTDIR\\${UNINSTALLER}$\\"'
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\AnalogAIWorkbench" "QuietUninstallString" '$\\"$INSTDIR\\${UNINSTALLER}$\\" /S'
  WriteRegDWORD HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\AnalogAIWorkbench" "NoModify" 1
  WriteRegDWORD HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\AnalogAIWorkbench" "NoRepair" 1
  Goto installation_complete
  installation_failed:
  MessageBox MB_OK|MB_ICONSTOP "安装未完成。请关闭正在运行的工作台后重试。聊天与密钥未修改。" /SD IDOK
  SetErrorLevel 22
  Abort
  installation_complete:
SectionEnd

Section "Uninstall"
  SetOutPath "$TEMP"
  StrCpy $1 0
${deletions}
  StrCmp $1 0 remove_registration
  MessageBox MB_OK|MB_ICONSTOP "部分程序文件正在使用，请关闭工作台后重新卸载。用户数据未删除。" /SD IDOK
  SetErrorLevel 23
  Abort
  remove_registration:
  ClearErrors
  Delete "$INSTDIR\\${UNINSTALLER}"
  IfErrors uninstall_incomplete
  Delete "$INSTDIR\\${INSTALLER_MARKER}"
  IfErrors uninstall_incomplete
${[...dirs].reverse().map(dir=>`  RMDir "$INSTDIR\\${ns(dir)}"`).join('\n')}
  RMDir "$INSTDIR"
  ClearErrors
  Delete "$DESKTOP\\Analog AI Workbench.lnk"
  Delete "$SMPROGRAMS\\Analog AI Workbench\\Analog AI Workbench.lnk"
  Delete "$SMPROGRAMS\\Analog AI Workbench\\卸载.lnk"
  RMDir "$SMPROGRAMS\\Analog AI Workbench"
  ReadRegStr $0 HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\AnalogAIWorkbench" "InstallLocation"
  StrCmp $0 "$INSTDIR" 0 registry_complete
  DeleteRegKey HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\AnalogAIWorkbench"
  registry_complete:
  Goto uninstall_complete
  uninstall_incomplete:
  MessageBox MB_OK|MB_ICONSTOP "卸载尚未完成，请关闭工作台后重试。用户数据未删除。" /SD IDOK
  SetErrorLevel 23
  Abort
  uninstall_complete:
SectionEnd
`;
}
