#pragma once
// Included in the command supervisor after its byte-hashing helpers.
struct PackagedCommandProfile {std::wstring shell;std::string profile,revision;std::vector<Handle> systemPins;};
PackagedCommandProfile ProbePackagedCommandProfile(){
  PackagedCommandProfile result;const auto& roots=packaged_runtime::roots;result.shell=roots.systemRoot+L"\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const std::array<std::pair<const char*,std::wstring>,4> paths{{{"shell",result.shell},{"shellConfig",result.shell+L".config"},{"automation",roots.systemRoot+L"\\Microsoft.Net\\assembly\\GAC_MSIL\\System.Management.Automation\\v4.0_3.0.0.0__31bf3856ad364e35\\System.Management.Automation.dll"},{"clr",roots.systemRoot+L"\\Microsoft.NET\\Framework64\\v4.0.30319\\clr.dll"}}};
  std::string files="[";for(const auto& entry:paths){
    // OS files can be Windows-servicing hardlinks. Preserve the existing system
    // pin policy; only package/execution payloads require a single link.
    packaged_runtime::PinChain(entry.second.substr(0,entry.second.find_last_of(L'\\')));
    Handle file(CreateFileW((L"\\\\?\\"+entry.second).c_str(),GENERIC_READ|FILE_READ_ATTRIBUTES,FILE_SHARE_READ,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,nullptr));Check(file.h!=INVALID_HANDLE_VALUE,"packaged_system_open");
    FILE_ATTRIBUTE_TAG_INFO tag{};FILE_STANDARD_INFO standard{};Check(GetFileInformationByHandleEx(file.h,FileAttributeTagInfo,&tag,sizeof(tag))&&GetFileInformationByHandleEx(file.h,FileStandardInfo,&standard,sizeof(standard)),"packaged_system_metadata");
    Require(!(tag.FileAttributes&(FILE_ATTRIBUTE_REPARSE_POINT|FILE_ATTRIBUTE_OFFLINE|FILE_ATTRIBUTE_DEVICE))&&!standard.Directory&&standard.EndOfFile.QuadPart>0&&standard.EndOfFile.QuadPart<=268435456&&Lower(FinalPath(file.h))==Lower(entry.second),"packaged_system_identity");
    const auto bytes=static_cast<ULONGLONG>(standard.EndOfFile.QuadPart);const auto digest=Hash(file.h,bytes);if(files.size()>1)files+=',';
    files+="{\"role\":\""+std::string(entry.first)+"\",\"path\":"+Json(entry.second)+",\"bytes\":"+std::to_string(bytes)+",\"sha256\":\""+digest+"\"}";result.systemPins.push_back(std::move(file));
  }files+=']';
  Handle token;Check(OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&token.h),"packaged_token");const auto info=TokenInfo(token.h,TokenUser);const auto sid=reinterpret_cast<const TOKEN_USER*>(info.data())->User.Sid;Require(IsValidSid(sid),"packaged_user_sid");const auto sidHash=HashBytes(static_cast<const unsigned char*>(sid),GetLengthSid(sid));
  result.profile="{\"schema\":\"aaw.packaged-command-profile/v1\",\"policyRevision\":\"aaw.packaged-command-policy/v1\",\"installationRoot\":"+Json(roots.installationRoot)+",\"runtimeRoot\":"+Json(roots.runtimeRoot)+",\"storageRoot\":"+Json(roots.storageRoot)+",\"dataRoot\":"+Json(roots.dataRoot)+",\"systemRoot\":"+Json(roots.systemRoot)+",\"userSidSha256\":\""+sidHash+"\",\"shellVersion\":\"5.1\",\"systemFiles\":"+files
    +",\"node\":{\"bytes\":93381448,\"sha256\":\"5c976096e04e5c2c1f091938926234cc9fbebfe9787ddd149351b3b0ecc707b5\"},\"license\":{\"bytes\":160555,\"sha256\":\"ed34dd8e3f0a78dbaf00d0444ce8e285b015b765379c2e17880455f70370f8e9\"},\"bootstrap\":{\"bytes\":"+std::to_string(profile::bootstrapBytes)+",\"sha256\":\""+profile::bootstrapSha256+"\"}}";
  result.revision=HashText(result.profile);return result;
}
