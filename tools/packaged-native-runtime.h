#pragma once

// Installed helpers derive their two roots from Windows and their own image.
// No environment variable, manifest or command argument can select another root.
namespace packaged_runtime {
struct Pin {
  HANDLE handle=INVALID_HANDLE_VALUE;
  explicit Pin(HANDLE value):handle(value){}
  Pin(const Pin&)=delete;Pin& operator=(const Pin&)=delete;
  Pin(Pin&& other) noexcept:handle(other.handle){other.handle=INVALID_HANDLE_VALUE;}
  ~Pin(){if(handle!=INVALID_HANDLE_VALUE)CloseHandle(handle);}
};
struct Roots {std::wstring installationRoot,runtimeRoot,storageRoot,dataRoot,systemRoot;};
inline Roots roots;
inline std::vector<Pin> pins;
inline bool initialized=false;
inline void Need(bool okay,const char* stage){if(!okay)throw std::runtime_error(stage);}
inline std::wstring Fold(std::wstring value){std::transform(value.begin(),value.end(),value.begin(),[](wchar_t ch){return static_cast<wchar_t>(towlower(ch));});return value;}
inline std::wstring Dos(std::wstring value){
  if(value.rfind(L"\\\\?\\",0)==0)value=value.substr(4);
  Need(value.size()>3&&value.size()<1024&&((value[0]>=L'A'&&value[0]<=L'Z')||(value[0]>=L'a'&&value[0]<=L'z'))&&value[1]==L':'&&value[2]==L'\\',"packaged_dos_path");
  if(value.back()==L'\\')value.pop_back();size_t start=3;
  for(size_t end=3;end<=value.size();++end){if(end<value.size()&&value[end]!=L'\\')continue;const auto part=value.substr(start,end-start);
    Need(!part.empty()&&part!=L"."&&part!=L".."&&part.back()!=L'.'&&part.back()!=L' '&&part.find_first_of(L"/:<>\"|?*")==std::wstring::npos,"packaged_path_part");
    Need(std::none_of(part.begin(),part.end(),[](wchar_t ch){return ch<32||ch==127;}),"packaged_path_part");start=end+1;}
  Need(GetDriveTypeW(value.substr(0,3).c_str())==DRIVE_FIXED,"packaged_fixed_drive");return value;
}
inline std::wstring Final(HANDLE handle){std::array<wchar_t,32768> buffer{};const DWORD count=GetFinalPathNameByHandleW(handle,buffer.data(),static_cast<DWORD>(buffer.size()),FILE_NAME_NORMALIZED|VOLUME_NAME_DOS);Need(count>0&&count<buffer.size(),"packaged_final_path");return Dos(std::wstring(buffer.data(),count));}
inline void PinChain(const std::wstring& name,bool file=false,bool allowMissing=false){
  const auto path=Dos(name);for(size_t end=3;end<=path.size();++end){if(end<path.size()&&path[end]!=L'\\')continue;const auto part=path.substr(0,end);const bool leaf=end==path.size();
    const HANDLE raw=CreateFileW((L"\\\\?\\"+part).c_str(),FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE,nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr);
    if(raw==INVALID_HANDLE_VALUE){const DWORD code=GetLastError();if(allowMissing&&(code==ERROR_FILE_NOT_FOUND||code==ERROR_PATH_NOT_FOUND))return;throw std::runtime_error("packaged_path_open");}
    Pin pin(raw);FILE_ATTRIBUTE_TAG_INFO tag{};FILE_STANDARD_INFO standard{};Need(GetFileInformationByHandleEx(raw,FileAttributeTagInfo,&tag,sizeof(tag))&&GetFileInformationByHandleEx(raw,FileStandardInfo,&standard,sizeof(standard)),"packaged_path_metadata");
    Need(!(tag.FileAttributes&(FILE_ATTRIBUTE_REPARSE_POINT|FILE_ATTRIBUTE_OFFLINE|FILE_ATTRIBUTE_DEVICE))&&!!standard.Directory==!(leaf&&file)&&(!(leaf&&file)||standard.NumberOfLinks==1)&&Fold(Final(raw))==Fold(part),"packaged_path_alias");pins.push_back(std::move(pin));
  }
}
inline const Roots& Initialize(const wchar_t* expectedImage){
  if(initialized)return roots;
  std::array<wchar_t,32768> buffer{};const DWORD size=GetModuleFileNameW(nullptr,buffer.data(),static_cast<DWORD>(buffer.size()));Need(size>0&&size<buffer.size(),"packaged_module_path");
  const auto image=Dos(std::wstring(buffer.data(),size));PinChain(image,true);
  const std::wstring suffix=L"\\.local\\runtime\\native\\"+std::wstring(expectedImage);Need(image.size()>suffix.size()&&Fold(image.substr(image.size()-suffix.size()))==Fold(suffix),"packaged_image_layout");
  Roots next;next.installationRoot=image.substr(0,image.size()-suffix.size());Need(Fold(next.installationRoot).ends_with(L"\\resources\\app"),"packaged_installation_layout");next.runtimeRoot=next.installationRoot+L"\\.local\\runtime";
  HANDLE token=nullptr;Need(OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY|TOKEN_IMPERSONATE|TOKEN_DUPLICATE,&token),"packaged_profile_token");Pin tokenPin(token);
  const HRESULT com=CoInitializeEx(nullptr,COINIT_MULTITHREADED);Need(SUCCEEDED(com)||com==RPC_E_CHANGED_MODE,"packaged_com");PWSTR folder=nullptr;const HRESULT result=SHGetKnownFolderPath(FOLDERID_RoamingAppData,0,token,&folder);
  std::wstring roaming;if(SUCCEEDED(result)&&folder)roaming=folder;CoTaskMemFree(folder);if(SUCCEEDED(com))CoUninitialize();if(roaming.empty())throw std::runtime_error("packaged_known_folder:"+std::to_string(static_cast<DWORD>(result)));
  roaming=Dos(roaming);next.storageRoot=roaming+L"\\AnalogAIWorkbench";next.dataRoot=next.storageRoot+L"\\.local";PinChain(next.dataRoot,false,true);
  const UINT windows=GetSystemWindowsDirectoryW(buffer.data(),static_cast<UINT>(buffer.size()));Need(windows>0&&windows<buffer.size(),"packaged_windows_directory");next.systemRoot=Dos(std::wstring(buffer.data(),windows));PinChain(next.systemRoot);
  const auto data=Fold(next.dataRoot+L"\\"),install=Fold(next.runtimeRoot+L"\\");Need(!data.starts_with(install)&&!install.starts_with(data),"packaged_disjoint_roots");
  roots=std::move(next);initialized=true;return roots;
}
} // namespace packaged_runtime
