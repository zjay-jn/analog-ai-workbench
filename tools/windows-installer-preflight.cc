#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <shlobj.h>
#include <shellapi.h>
#include <algorithm>
#include <array>
#include <cstring>
#include <iterator>
#include <set>
#include <string>
#include <vector>
#include "installer-files.h"

// This executable only observes paths. It never writes files, ACLs or registry.
// Exit codes are intentionally fixed; no user path or identifier is printed.
namespace {
enum Code { Good=0, Arguments=2, KnownFolder=3, WrongRoot=10, UnsafePath=11,
  NotLocalFixed=12, InvalidMarker=13, OccupiedRoot=14, WrongType=15,
  HardLink=16, Unreadable=17, InvalidInventory=18, ChangedMarker=19, Busy=20 };
struct Failure { int code; };
void Need(bool okay,int code){if(!okay)throw Failure{code};}
struct Handle {
  HANDLE value=INVALID_HANDLE_VALUE;
  explicit Handle(HANDLE handle=INVALID_HANDLE_VALUE):value(handle){}
  Handle(const Handle&)=delete;Handle& operator=(const Handle&)=delete;
  Handle(Handle&& other) noexcept:value(other.value){other.value=INVALID_HANDLE_VALUE;}
  ~Handle(){if(value!=INVALID_HANDLE_VALUE)CloseHandle(value);}
};
bool Same(const std::wstring& a,const std::wstring& b){return CompareStringOrdinal(a.data(),static_cast<int>(a.size()),b.data(),static_cast<int>(b.size()),TRUE)==CSTR_EQUAL;}
std::wstring Fold(std::wstring value){if(!value.empty())Need(CharLowerBuffW(value.data(),static_cast<DWORD>(value.size()))==value.size(),UnsafePath);return value;}
bool Segment(const std::wstring& value){
  if(value.empty()||value==L"."||value==L".."||value.back()==L'.'||value.back()==L' ')return false;
  for(const auto ch:value)if(ch<32||ch==127||std::wstring(L"\\/:<>\"|?*").find(ch)!=std::wstring::npos)return false;
  const auto base=Fold(value.substr(0,value.find(L'.')));
  return base!=L"con"&&base!=L"prn"&&base!=L"aux"&&base!=L"nul"&&!(base.size()==4&&(base.rfind(L"com",0)==0||base.rfind(L"lpt",0)==0)&&((base[3]>=L'1'&&base[3]<=L'9')||base[3]==0x00b9||base[3]==0x00b2||base[3]==0x00b3));
}
std::wstring Absolute(const std::wstring& input){
  Need(input.size()>3&&input.size()<30000&&((input[0]>=L'A'&&input[0]<=L'Z')||(input[0]>=L'a'&&input[0]<=L'z'))&&input[1]==L':'&&input[2]==L'\\',UnsafePath);
  size_t start=3;for(size_t end=3;end<=input.size();++end)if(end==input.size()||input[end]==L'\\'){Need(Segment(input.substr(start,end-start)),UnsafePath);start=end+1;}
  std::vector<wchar_t> output(32768);const DWORD count=GetFullPathNameW(input.c_str(),static_cast<DWORD>(output.size()),output.data(),nullptr);
  Need(count>0&&count<output.size(),UnsafePath);const std::wstring result(output.data(),count);Need(Same(input,result),UnsafePath);return result;
}
std::wstring Relative(const wchar_t* raw){
  Need(raw!=nullptr,InvalidInventory);const std::wstring input(raw);Need(!input.empty()&&input.size()<2048,InvalidInventory);
  size_t start=0;for(size_t end=0;end<=input.size();++end)if(end==input.size()||input[end]==L'/'){Need(Segment(input.substr(start,end-start)),InvalidInventory);start=end+1;}
  auto result=input;std::replace(result.begin(),result.end(),L'/',L'\\');return result;
}
std::wstring Extended(const std::wstring& path){return L"\\\\?\\"+path;}
std::wstring Final(HANDLE handle){
  std::vector<wchar_t> value(32768);const DWORD count=GetFinalPathNameByHandleW(handle,value.data(),static_cast<DWORD>(value.size()),FILE_NAME_NORMALIZED|VOLUME_NAME_DOS);
  Need(count>0&&count<value.size(),UnsafePath);std::wstring result(value.data(),count);Need(result.rfind(L"\\\\?\\",0)==0,UnsafePath);return result.substr(4);
}
std::wstring LocalData(){
#ifdef AAW_INSTALLER_PREFLIGHT_TEST
  // A separate test executable contains a literal UUID-owned fixture root.
  // Production never reads an environment or command-line root override.
  return Absolute(aaw_installer::testLocalAppData);
#else
  HANDLE raw=nullptr;Need(OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY|TOKEN_IMPERSONATE|TOKEN_DUPLICATE,&raw),KnownFolder);Handle token(raw);
  const HRESULT com=CoInitializeEx(nullptr,COINIT_MULTITHREADED);Need(SUCCEEDED(com)||com==RPC_E_CHANGED_MODE,KnownFolder);
  PWSTR value=nullptr;const HRESULT status=SHGetKnownFolderPath(FOLDERID_LocalAppData,KF_FLAG_DONT_VERIFY,token.value,&value);
  std::wstring result;if(SUCCEEDED(status)&&value)result=value;CoTaskMemFree(value);if(SUCCEEDED(com))CoUninitialize();
  Need(!result.empty(),KnownFolder);return Absolute(result);
#endif
}
struct Observations {
  std::vector<Handle> pins;
  // A missing tail is permitted for a fresh installation. Every existing
  // ancestor and object is opened without following a reparse point.
  bool Inspect(const std::wstring& absolute,bool directory){
    bool missing=false;std::vector<std::wstring> chain{absolute.substr(0,3)};
    for(size_t i=3;i<absolute.size();++i)if(absolute[i]==L'\\')chain.push_back(absolute.substr(0,i));chain.push_back(absolute);
    for(size_t i=0;i<chain.size();++i){
      if(missing)continue;const auto& part=chain[i];
      Handle handle(CreateFileW(Extended(part).c_str(),FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT|FILE_FLAG_BACKUP_SEMANTICS,nullptr));
      if(handle.value==INVALID_HANDLE_VALUE){const DWORD error=GetLastError();if(error==ERROR_FILE_NOT_FOUND||error==ERROR_PATH_NOT_FOUND){missing=true;continue;}throw Failure{Unreadable};}
      FILE_ATTRIBUTE_TAG_INFO tag{};FILE_STANDARD_INFO standard{};
      Need(GetFileInformationByHandleEx(handle.value,FileAttributeTagInfo,&tag,sizeof(tag))&&GetFileInformationByHandleEx(handle.value,FileStandardInfo,&standard,sizeof(standard)),Unreadable);
      Need(!(tag.FileAttributes&(FILE_ATTRIBUTE_REPARSE_POINT|FILE_ATTRIBUTE_DEVICE|FILE_ATTRIBUTE_OFFLINE)),UnsafePath);
      const bool expectedDirectory=i+1<chain.size()||directory;Need(!!standard.Directory==expectedDirectory,WrongType);
      if(!expectedDirectory)Need(standard.NumberOfLinks==1,HardLink);
      Need(Same(Final(handle.value),part),UnsafePath);pins.push_back(std::move(handle));
    }
    return !missing;
  }
};
constexpr char marker[]="aaw.windows-installation/v1\nAnalogAIWorkbench\n";
bool Marker(const std::wstring& root,Observations& observed){
  const auto file=root+L"\\.aaw-installation";if(!observed.Inspect(file,false))return false;
  Handle handle(CreateFileW(Extended(file).c_str(),GENERIC_READ,FILE_SHARE_READ,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,nullptr));Need(handle.value!=INVALID_HANDLE_VALUE,Unreadable);
  FILE_STANDARD_INFO before{},after{};FILE_ID_INFO first{},last{};
  Need(GetFileInformationByHandleEx(handle.value,FileStandardInfo,&before,sizeof(before))&&GetFileInformationByHandleEx(handle.value,FileIdInfo,&first,sizeof(first)),Unreadable);
  Need(before.NumberOfLinks==1&&before.EndOfFile.QuadPart==static_cast<LONGLONG>(sizeof(marker)-1),InvalidMarker);
  std::array<char,sizeof(marker)> bytes{};DWORD count=0;Need(ReadFile(handle.value,bytes.data(),static_cast<DWORD>(bytes.size()),&count,nullptr),Unreadable);
  Need(count==sizeof(marker)-1&&std::memcmp(bytes.data(),marker,sizeof(marker)-1)==0,InvalidMarker);
  Need(GetFileInformationByHandleEx(handle.value,FileStandardInfo,&after,sizeof(after))&&GetFileInformationByHandleEx(handle.value,FileIdInfo,&last,sizeof(last)),Unreadable);
  Need(after.NumberOfLinks==1&&before.EndOfFile.QuadPart==after.EndOfFile.QuadPart&&first.VolumeSerialNumber==last.VolumeSerialNumber&&std::memcmp(first.FileId.Identifier,last.FileId.Identifier,16)==0,ChangedMarker);
  return true;
}
bool Empty(const std::wstring& root){
  WIN32_FIND_DATAW item{};const HANDLE search=FindFirstFileW((Extended(root)+L"\\*").c_str(),&item);
  if(search==INVALID_HANDLE_VALUE){Need(GetLastError()==ERROR_FILE_NOT_FOUND,Unreadable);return true;}
  bool empty=true;DWORD finalError=ERROR_SUCCESS;
  do{if(std::wstring(item.cFileName)!=L"."&&std::wstring(item.cFileName)!=L".."){empty=false;break;}}while(FindNextFileW(search,&item));
  if(empty)finalError=GetLastError();FindClose(search);Need(!empty||finalError==ERROR_NO_MORE_FILES,Unreadable);return empty;
}
void WritableWithoutSharing(const std::wstring& file){
  // OPEN_EXISTING never creates/truncates anything. Taking a write-capable
  // exclusive handle detects an image or payload still held by another app;
  // no WriteFile, attributes, ACL or other mutation is performed.
  Handle handle(CreateFileW(Extended(file).c_str(),GENERIC_WRITE,0,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,nullptr));
  if(handle.value==INVALID_HANDLE_VALUE){const DWORD code=GetLastError();throw Failure{code==ERROR_SHARING_VIOLATION||code==ERROR_LOCK_VIOLATION||code==ERROR_ACCESS_DENIED?Busy:Unreadable};}
  FILE_ATTRIBUTE_TAG_INFO tag{};FILE_STANDARD_INFO standard{};
  Need(GetFileInformationByHandleEx(handle.value,FileAttributeTagInfo,&tag,sizeof(tag))&&GetFileInformationByHandleEx(handle.value,FileStandardInfo,&standard,sizeof(standard)),Unreadable);
  Need(!(tag.FileAttributes&(FILE_ATTRIBUTE_REPARSE_POINT|FILE_ATTRIBUTE_DEVICE|FILE_ATTRIBUTE_OFFLINE))&&!standard.Directory&&Same(Final(handle.value),file),UnsafePath);
  Need(standard.NumberOfLinks==1,HardLink);
}
int Validate(const std::wstring& verb,const std::wstring& supplied){
  Need(verb==L"validate-install"||verb==L"validate-uninstall",Arguments);
  const auto root=Absolute(supplied),expected=LocalData()+L"\\Programs\\AnalogAIWorkbench";Need(Same(root,expected),WrongRoot);
  Need(GetDriveTypeW(root.substr(0,3).c_str())==DRIVE_FIXED,NotLocalFixed);
  std::set<std::wstring> names;std::vector<std::wstring> files,directories;
  for(const auto* raw:aaw_installer::packageFiles){auto file=Relative(raw);Need(names.insert(Fold(file)).second,InvalidInventory);files.push_back(std::move(file));}
  for(const auto* raw:aaw_installer::packageDirectories){auto file=Relative(raw);Need(names.insert(Fold(file)).second,InvalidInventory);directories.push_back(std::move(file));}
  Need(!files.empty(),InvalidInventory);
  Observations observed;const bool exists=observed.Inspect(root,true);
  if(!exists){Need(verb==L"validate-install",InvalidMarker);return Good;}
  const bool owned=Marker(root,observed);
  if(verb==L"validate-uninstall")Need(owned,InvalidMarker);else Need(owned||Empty(root),OccupiedRoot);
  for(const auto& directory:directories)observed.Inspect(root+L"\\"+directory,true);
  for(const auto& file:files){const auto absolute=root+L"\\"+file;if(observed.Inspect(absolute,false))WritableWithoutSharing(absolute);}
  return Good;
}
} // namespace
int WINAPI wWinMain(HINSTANCE,HINSTANCE,PWSTR,int){
  int count=0;LPWSTR* arguments=CommandLineToArgvW(GetCommandLineW(),&count);if(!arguments)return Arguments;
  int result=Arguments;try{if(count==3)result=Validate(arguments[1],arguments[2]);}catch(const Failure& error){result=error.code;}catch(...){result=Unreadable;}
  LocalFree(arguments);return result;
}
