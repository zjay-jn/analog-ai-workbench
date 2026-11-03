#pragma once
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <userenv.h>
#include <aclapi.h>
#include <bcrypt.h>
#include <sddl.h>
#include <combaseapi.h>
#include <shlobj.h>
#include "runner-limits.h"
#include <algorithm>
#include <array>
#include <cstring>
#include <iostream>
#include <map>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>
#ifdef AAW_PORTABLE_RUNTIME
#include "runtime-paths.h"
#endif

namespace aaw {
struct Handle {
  HANDLE h = nullptr;
  Handle() = default; explicit Handle(HANDLE value):h(value){}
  Handle(const Handle&) = delete; Handle& operator=(const Handle&) = delete;
  Handle(Handle&& other) noexcept:h(other.h){other.h=nullptr;}
  Handle& operator=(Handle&& other) noexcept { if(this!=&other){Reset();h=other.h;other.h=nullptr;}return *this;}
  ~Handle(){Reset();}
  void Reset(HANDLE value=nullptr){if(h && h!=INVALID_HANDLE_VALUE)CloseHandle(h);h=value;}
  HANDLE Release(){HANDLE value=h;h=nullptr;return value;}
};
void Check(bool okay,const char* stage){if(!okay)throw std::runtime_error(std::string(stage)+":"+std::to_string(GetLastError()));}
void Require(bool okay,const char* stage){if(!okay)throw std::runtime_error(stage);}
#ifdef AAW_PORTABLE_RUNTIME
const std::wstring productLocal=portable_runtime::dataLocal;
const std::wstring installationRuntime=portable_runtime::installationRuntime;
#else
const std::wstring productLocal=L"C:\\work\\analog_ai_workbench\\.local\\";
#endif
std::wstring recoveryRoot;
std::vector<Handle> ancestry;
std::wstring Lower(std::wstring value){std::transform(value.begin(),value.end(),value.begin(),[](wchar_t ch){return static_cast<wchar_t>(towlower(ch));});return value;}
bool Within(const std::wstring& value,const std::wstring& root){return Lower(value).rfind(Lower(root),0)==0;}
std::string Utf8(const std::wstring& text){
  if(text.empty())return {};
  Require(text.size()<32768,"text_size");
  const int count=WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,text.data(),static_cast<int>(text.size()),nullptr,0,nullptr,nullptr);
  Check(count>0,"utf8");std::string out(static_cast<size_t>(count),0);
  Check(WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,text.data(),static_cast<int>(text.size()),out.data(),count,nullptr,nullptr)==count,"utf8");return out;
}
std::string Json(const std::wstring& text){
  std::string out="\"";for(const unsigned char ch:Utf8(text)){if(ch=='\\'||ch=='"')out.push_back('\\');Require(ch>=32,"json_control");out.push_back(static_cast<char>(ch));}return out+"\"";
}
std::string Hex(const unsigned char* value,size_t count){
  std::string out;out.reserve(count*2);for(size_t i=0;i<count;++i){out.push_back("0123456789abcdef"[value[i]>>4]);out.push_back("0123456789abcdef"[value[i]&15]);}return out;
}
bool IsHex(const std::wstring& value,size_t length){return value.size()==length&&std::all_of(value.begin(),value.end(),[](wchar_t ch){return (ch>=L'0'&&ch<=L'9')||(ch>=L'a'&&ch<=L'f');});}
bool Relative(const std::wstring& value){
  if(value.empty()||value.size()>limits::relativePathBytes||Utf8(value).size()>limits::relativePathBytes)return false;
  size_t start=0;unsigned depth=0;
  for(size_t end=0;end<=value.size();++end){
    if(end<value.size()&&value[end]!=L'/'){const auto ch=value[end];if(ch<32||ch==127||(ch>=0xd800&&ch<=0xdfff)||std::wstring(L"\\:<>\"|?*").find(ch)!=std::wstring::npos)return false;continue;}
    const auto part=value.substr(start,end-start);if(part.empty()||part==L"."||part==L".."||part.back()==L'.'||part.back()==L' '||++depth>limits::pathDepth)return false;
    const auto name=Lower(part.substr(0,part.find(L'.')));if(name==L"con"||name==L"prn"||name==L"aux"||name==L"nul"||(name.size()==4&&(name.rfind(L"com",0)==0||name.rfind(L"lpt",0)==0)&&((name[3]>=L'1'&&name[3]<=L'9')||name[3]==0x00b9||name[3]==0x00b2||name[3]==0x00b3)))return false;start=end+1;
  }return true;
}
std::wstring NativeRelative(std::wstring value){std::replace(value.begin(),value.end(),L'/',L'\\');return value;}
// Only the Win32 API spelling changes; authorization and handle identity use the original DOS path.
std::wstring Win32Path(const std::wstring& name){
#ifdef AAW_PORTABLE_RUNTIME
  Require(name.size()>3&&name.size()<=32762&&((name[0]>=L'A'&&name[0]<=L'Z')||(name[0]>=L'a'&&name[0]<=L'z'))&&name[1]==L':'&&name[2]==L'\\',"canonical_dos_path");
#else
  Require(name.size()>3&&name.size()<=32762&&(name[0]==L'C'||name[0]==L'c')&&name[1]==L':'&&name[2]==L'\\',"canonical_dos_path");
#endif
  size_t start=3;
  for(size_t end=3;end<=name.size();++end){
    if(end<name.size()&&name[end]!=L'\\')continue;
    const auto part=name.substr(start,end-start);
    Require(part.find(L'/')==std::wstring::npos&&Relative(part),"canonical_dos_path");start=end+1;
  }
  return L"\\\\?\\"+name;
}
std::wstring FinalPath(HANDLE handle){
  std::array<wchar_t,32768> buffer{};const DWORD n=GetFinalPathNameByHandleW(handle,buffer.data(),static_cast<DWORD>(buffer.size()),FILE_NAME_NORMALIZED|VOLUME_NAME_DOS);
  Check(n>0&&n<buffer.size(),"final_path");std::wstring value(buffer.data(),n);if(value.rfind(L"\\\\?\\",0)==0)value=value.substr(4);return value;
}
Handle Open(const std::wstring& name,bool directory,DWORD extra=0,bool immutable=false){
#ifdef AAW_PORTABLE_RUNTIME
  Require(Within(name,productLocal)||Within(name,installationRuntime),"outside_product_local");
#else
  Require(Within(name,productLocal),"outside_product_local");
#endif
  Handle file(CreateFileW(Win32Path(name).c_str(),READ_CONTROL|FILE_READ_ATTRIBUTES|extra,immutable?FILE_SHARE_READ:FILE_SHARE_READ|FILE_SHARE_WRITE,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT|FILE_FLAG_BACKUP_SEMANTICS,nullptr));
  Check(file.h!=INVALID_HANDLE_VALUE,"open_object");FILE_ATTRIBUTE_TAG_INFO tag{};FILE_STANDARD_INFO standard{};
  Check(GetFileInformationByHandleEx(file.h,FileAttributeTagInfo,&tag,sizeof(tag))&&GetFileInformationByHandleEx(file.h,FileStandardInfo,&standard,sizeof(standard)),"object_metadata");
  Require(!(tag.FileAttributes&(FILE_ATTRIBUTE_REPARSE_POINT|FILE_ATTRIBUTE_OFFLINE|FILE_ATTRIBUTE_DEVICE))&&!!standard.Directory==directory&&(directory||standard.NumberOfLinks==1),"unsupported_object");
  Require(Lower(FinalPath(file.h))==Lower(name),"object_alias");return file;
}
void LockAncestors(const std::wstring& name){
#ifdef AAW_PORTABLE_RUNTIME
  Require((Within(name,productLocal)||Within(name,installationRuntime))&&name.size()<1024,"absolute_path");
#else
  Require(Within(name,productLocal)&&name.size()<1024,"absolute_path");
#endif
#ifdef AAW_PORTABLE_RUNTIME
  Require(GetDriveTypeW(name.substr(0,3).c_str())==DRIVE_FIXED,"fixed_drive");
#else
  Require(GetDriveTypeW(L"C:\\")==DRIVE_FIXED,"fixed_drive");
#endif
  for(size_t pos=3;pos<name.size();++pos){if(name[pos]!=L'\\')continue;const auto part=name.substr(0,pos);
    Handle h(CreateFileW(Win32Path(part).c_str(),FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE,nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr));
    Check(h.h!=INVALID_HANDLE_VALUE,"ancestor");FILE_ATTRIBUTE_TAG_INFO info{};
    Check(GetFileInformationByHandleEx(h.h,FileAttributeTagInfo,&info,sizeof(info)),"ancestor_metadata");
    Require((info.FileAttributes&FILE_ATTRIBUTE_DIRECTORY)&&!(info.FileAttributes&FILE_ATTRIBUTE_REPARSE_POINT)&&Lower(FinalPath(h.h))==Lower(part),"ancestor_alias");ancestry.push_back(std::move(h));
  }
}
void Record(const std::wstring& name,const std::string& text){
  Require(!recoveryRoot.empty()&&text.size()<=65536&&name.find_first_not_of(L"abcdefghijklmnopqrstuvwxyz0123456789-")==std::wstring::npos,"record_name");
  Handle file(CreateFileW(Win32Path(recoveryRoot+L"\\"+name+L".json").c_str(),GENERIC_WRITE,FILE_SHARE_READ,nullptr,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,nullptr));
  Check(file.h!=INVALID_HANDLE_VALUE,"record_create");DWORD written=0;
  Check(WriteFile(file.h,text.data(),static_cast<DWORD>(text.size()),&written,nullptr)&&written==text.size(),"record_write");Check(FlushFileBuffers(file.h),"record_flush");
}
std::vector<unsigned char> TokenInfo(HANDLE token,TOKEN_INFORMATION_CLASS kind){
  DWORD count=0;GetTokenInformation(token,kind,nullptr,0,&count);Require(count>0&&count<=65536,"token_size");std::vector<unsigned char> out(count);Check(GetTokenInformation(token,kind,out.data(),count,&count),"token_info");return out;
}
std::string Hash(HANDLE file,ULONGLONG expected){
  LARGE_INTEGER size{};Check(GetFileSizeEx(file,&size)&&size.QuadPart>=0&&static_cast<ULONGLONG>(size.QuadPart)==expected,"hash_size");
  LARGE_INTEGER zero{};Check(SetFilePointerEx(file,zero,nullptr,FILE_BEGIN),"hash_seek");
  BCRYPT_ALG_HANDLE algorithm=nullptr;BCRYPT_HASH_HANDLE hash=nullptr;ULONG objectBytes=0,got=0;std::vector<unsigned char> object;
  Require(BCryptOpenAlgorithmProvider(&algorithm,BCRYPT_SHA256_ALGORITHM,nullptr,0)==0,"hash_provider");
  try{
    Require(BCryptGetProperty(algorithm,BCRYPT_OBJECT_LENGTH,reinterpret_cast<PUCHAR>(&objectBytes),sizeof(objectBytes),&got,0)==0&&objectBytes<=65536,"hash_object");
    object.resize(objectBytes);Require(BCryptCreateHash(algorithm,&hash,object.data(),objectBytes,nullptr,0,0)==0,"hash_create");
    std::array<unsigned char,65536> chunk{};ULONGLONG total=0;
    while(total<expected){DWORD read=0;const DWORD want=static_cast<DWORD>(std::min<ULONGLONG>(chunk.size(),expected-total));Check(ReadFile(file,chunk.data(),want,&read,nullptr)&&read>0,"hash_read");total+=read;Require(BCryptHashData(hash,chunk.data(),read,0)==0,"hash_data");}
    std::array<unsigned char,32> value{};Require(BCryptFinishHash(hash,value.data(),static_cast<ULONG>(value.size()),0)==0,"hash_finish");
    BCryptDestroyHash(hash);BCryptCloseAlgorithmProvider(algorithm,0);return Hex(value.data(),value.size());
  }catch(...){if(hash)BCryptDestroyHash(hash);BCryptCloseAlgorithmProvider(algorithm,0);throw;}
}
struct GrantState {Handle handle;PSECURITY_DESCRIPTOR descriptor=nullptr;SECURITY_DESCRIPTOR_CONTROL control=0;FILE_ID_INFO identity{};std::wstring path;bool directory=false;};
std::vector<GrantState> grants;
std::vector<unsigned char> userInfo;
PSID MainUser(){return reinterpret_cast<TOKEN_USER*>(userInfo.data())->User.Sid;}
bool SameIdentity(const GrantState& item){FILE_ID_INFO now{};return GetFileInformationByHandleEx(item.handle.h,FileIdInfo,&now,sizeof(now))&&now.VolumeSerialNumber==item.identity.VolumeSerialNumber&&std::memcmp(now.FileId.Identifier,item.identity.FileId.Identifier,16)==0;}
HANDLE Grant(const std::wstring& name,bool directory,PSID sid,DWORD mask,bool immutable){
  Handle object=Open(name,directory,WRITE_DAC|(immutable?GENERIC_READ:0),immutable);
  PSECURITY_DESCRIPTOR descriptor=nullptr;PACL prior=nullptr;Check(GetSecurityInfo(object.h,SE_FILE_OBJECT,DACL_SECURITY_INFORMATION,nullptr,nullptr,&prior,nullptr,&descriptor)==ERROR_SUCCESS,"read_acl");
  GrantState state;state.handle=std::move(object);state.descriptor=descriptor;state.path=name;state.directory=directory;
  DWORD revision=0;Check(GetSecurityDescriptorControl(descriptor,&state.control,&revision),"acl_control");
  Check(GetFileInformationByHandleEx(state.handle.h,FileIdInfo,&state.identity,sizeof(state.identity)),"acl_identity");
  LPWSTR sddl=nullptr;Check(ConvertSecurityDescriptorToStringSecurityDescriptorW(descriptor,SDDL_REVISION_1,DACL_SECURITY_INFORMATION,&sddl,nullptr),"acl_sddl");
  const std::wstring previous(sddl);LocalFree(sddl);
  Record(L"acl-"+std::to_wstring(grants.size()),"{\"path\":"+Json(name)+",\"volume\":\""+std::to_string(state.identity.VolumeSerialNumber)+"\",\"fileId\":\""+Hex(state.identity.FileId.Identifier,16)+"\",\"control\":"+std::to_string(state.control)+",\"sddl\":"+Json(previous)+"}");
  grants.push_back(std::move(state));auto& saved=grants.back();
  PSID ownerRights=nullptr;Check(ConvertStringSidToSidW(L"S-1-3-4",&ownerRights),"owner_rights");
  std::array<EXPLICIT_ACCESSW,3> entries{};
  for(auto& entry:entries){entry.grfAccessMode=GRANT_ACCESS;entry.grfInheritance=NO_INHERITANCE;entry.Trustee.TrusteeForm=TRUSTEE_IS_SID;}
  entries[0].grfAccessPermissions=mask;entries[0].Trustee.ptstrName=static_cast<LPWSTR>(sid);
  entries[1].grfAccessPermissions=READ_CONTROL;entries[1].Trustee.ptstrName=static_cast<LPWSTR>(ownerRights);
  entries[2].grfAccessPermissions=FILE_ALL_ACCESS;entries[2].Trustee.ptstrName=static_cast<LPWSTR>(MainUser());
  PACL updated=nullptr;const DWORD made=SetEntriesInAclW(static_cast<ULONG>(entries.size()),entries.data(),prior,&updated);LocalFree(ownerRights);Check(made==ERROR_SUCCESS,"build_acl");
  const DWORD applied=SetSecurityInfo(saved.handle.h,SE_FILE_OBJECT,DACL_SECURITY_INFORMATION|PROTECTED_DACL_SECURITY_INFORMATION,nullptr,nullptr,updated,nullptr);LocalFree(updated);Check(applied==ERROR_SUCCESS,"grant_acl");
  return saved.handle.h;
}
bool RestoreGrants(){
  bool okay=true;
  // Parent restoration can propagate to children. Restore every object, then verify every final state.
  for(auto& item:grants){PACL prior=nullptr;BOOL present=FALSE,defaulted=FALSE;
    const auto flags=DACL_SECURITY_INFORMATION|((item.control&SE_DACL_PROTECTED)?PROTECTED_DACL_SECURITY_INFORMATION:UNPROTECTED_DACL_SECURITY_INFORMATION);
    if(!SameIdentity(item)||!GetSecurityDescriptorDacl(item.descriptor,&present,&prior,&defaulted)||!present||!prior||SetSecurityInfo(item.handle.h,SE_FILE_OBJECT,flags,nullptr,nullptr,prior,nullptr)!=ERROR_SUCCESS)okay=false;
  }
  for(auto& item:grants){PACL prior=nullptr,current=nullptr;PSECURITY_DESCRIPTOR actual=nullptr;BOOL present=FALSE,defaulted=FALSE;SECURITY_DESCRIPTOR_CONTROL control{};DWORD revision=0;
    bool equal=SameIdentity(item)&&GetSecurityDescriptorDacl(item.descriptor,&present,&prior,&defaulted)&&GetSecurityInfo(item.handle.h,SE_FILE_OBJECT,DACL_SECURITY_INFORMATION,nullptr,nullptr,&current,nullptr,&actual)==ERROR_SUCCESS;
    if(equal)equal=GetSecurityDescriptorControl(actual,&control,&revision)&&((control^item.control)&(SE_DACL_PROTECTED|SE_DACL_AUTO_INHERITED))==0&&prior&&current&&prior->AclSize==current->AclSize&&std::memcmp(prior,current,prior->AclSize)==0;
    if(actual)LocalFree(actual);if(!equal)okay=false;
  }return okay;
}
void ReleaseGrants(){for(auto& item:grants){if(item.descriptor)LocalFree(item.descriptor);item.descriptor=nullptr;}grants.clear();}
struct TreeEntry {std::wstring relative;bool directory;ULONGLONG bytes;};
void Walk(const std::wstring& root,const std::wstring& relative,std::vector<TreeEntry>& entries,unsigned depth=0){
  Require(depth<=limits::pathDepth&&entries.size()<=limits::files*limits::pathDepth,"tree_limit");
  const std::wstring current=root+(relative.empty()?L"":L"\\"+NativeRelative(relative));
  auto directory=Open(current,true);
  WIN32_FIND_DATAW info{};HANDLE raw=FindFirstFileW((Win32Path(current)+L"\\*").c_str(),&info);
  if(raw==INVALID_HANDLE_VALUE){Require(GetLastError()==ERROR_FILE_NOT_FOUND,"tree_enumeration");return;}
  try{
    do{
      const std::wstring name(info.cFileName);if(name==L"."||name==L"..")continue;
      const auto rel=relative.empty()?name:relative+L"/"+name;Require(Relative(rel)&&!(info.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT),"tree_path");
      const bool dir=!!(info.dwFileAttributes&FILE_ATTRIBUTE_DIRECTORY);auto file=Open(root+L"\\"+NativeRelative(rel),dir);
      FILE_STANDARD_INFO standard{};Check(GetFileInformationByHandleEx(file.h,FileStandardInfo,&standard,sizeof(standard)),"tree_size");
      Require(standard.EndOfFile.QuadPart>=0,"tree_size");entries.push_back({rel,dir,static_cast<ULONGLONG>(standard.EndOfFile.QuadPart)});Require(entries.size()<=limits::files*limits::pathDepth,"tree_limit");
      if(dir)Walk(root,rel,entries,depth+1);
    }while(FindNextFileW(raw,&info));
    Require(GetLastError()==ERROR_NO_MORE_FILES,"tree_enumeration");FindClose(raw);
  }catch(...){FindClose(raw);throw;}
}
bool NormalizeOutput(const std::wstring& output){
  try{
    const auto found=std::find_if(grants.begin(),grants.end(),[&](const GrantState& item){return item.path==output;});
    if(found==grants.end())return true;
    PACL baseline=nullptr;BOOL present=FALSE,defaulted=FALSE;Check(GetSecurityDescriptorDacl(found->descriptor,&present,&baseline,&defaulted)&&present&&baseline,"output_baseline");
    std::vector<TreeEntry> entries;Walk(output,L"",entries);
    for(const auto& entry:entries){auto object=Open(output+L"\\"+NativeRelative(entry.relative),entry.directory,WRITE_DAC);Check(SetSecurityInfo(object.h,SE_FILE_OBJECT,DACL_SECURITY_INFORMATION|UNPROTECTED_DACL_SECURITY_INFORMATION,nullptr,nullptr,baseline,nullptr)==ERROR_SUCCESS,"output_acl");}
    return true;
  }catch(...){return false;}
}
} // namespace aaw
