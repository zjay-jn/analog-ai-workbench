#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <array>
#include <cstring>
#include <iostream>
#include <string>
#include <stdexcept>
struct Expected { const wchar_t* path; const wchar_t* sddl; const wchar_t* fileId; ULONGLONG volume; SECURITY_DESCRIPTOR_CONTROL control; };
const std::array<Expected,4> expected{{
{L"C:\\work\\analog_ai_workbench\\.local\\agent-work-cycle-runner\\probe-03\\runtime",L"D:AI(A;OICIID;0x1301bf;;;S-1-5-21-1773715031-431992736-2371066645-645060146)(A;OICIID;0x1301bf;;;S-1-5-21-1197442452-3805226789-852756491-1014)(A;OICIID;0x1301bf;;;S-1-5-21-538937900-538258331-3595327977-979063381)(A;OICIID;FA;;;BA)(A;OICIID;FA;;;SY)(A;OICIID;0x1200a9;;;BU)(A;ID;0x1301bf;;;AU)(A;OICIIOID;SDGXGWGR;;;AU)",L"c0b84300000019000000000000000000",496611344096777553ULL,33796},
{L"C:\\work\\analog_ai_workbench\\.local\\agent-work-cycle-runner\\probe-03\\runtime\\node.exe",L"D:AI(A;ID;0x1301bf;;;S-1-5-21-1773715031-431992736-2371066645-645060146)(A;ID;0x1301bf;;;S-1-5-21-1197442452-3805226789-852756491-1014)(A;ID;0x1301bf;;;S-1-5-21-538937900-538258331-3595327977-979063381)(A;ID;FA;;;BA)(A;ID;FA;;;SY)(A;ID;0x1200a9;;;BU)(A;ID;0x1301bf;;;AU)",L"c3b84300000006000000000000000000",496611344096777553ULL,33796},
{L"C:\\work\\analog_ai_workbench\\.local\\agent-work-cycle-runner\\probe-03\\input",L"D:AI(A;OICIID;0x1301bf;;;S-1-5-21-1773715031-431992736-2371066645-645060146)(A;OICIID;0x1301bf;;;S-1-5-21-1197442452-3805226789-852756491-1014)(A;OICIID;0x1301bf;;;S-1-5-21-538937900-538258331-3595327977-979063381)(A;OICIID;FA;;;BA)(A;OICIID;FA;;;SY)(A;OICIID;0x1200a9;;;BU)(A;ID;0x1301bf;;;AU)(A;OICIIOID;SDGXGWGR;;;AU)",L"c1b84300000006000000000000000000",496611344096777553ULL,33796},
{L"C:\\work\\analog_ai_workbench\\.local\\agent-work-cycle-runner\\probe-03\\output",L"D:AI(A;OICIID;0x1301bf;;;S-1-5-21-1773715031-431992736-2371066645-645060146)(A;OICIID;0x1301bf;;;S-1-5-21-1197442452-3805226789-852756491-1014)(A;OICIID;0x1301bf;;;S-1-5-21-538937900-538258331-3595327977-979063381)(A;OICIID;FA;;;BA)(A;OICIID;FA;;;SY)(A;OICIID;0x1200a9;;;BU)(A;ID;0x1301bf;;;AU)(A;OICIIOID;SDGXGWGR;;;AU)",L"c2b84300000006000000000000000000",496611344096777553ULL,33796}
}};
struct Opened { HANDLE handle = INVALID_HANDLE_VALUE; PSECURITY_DESCRIPTOR descriptor = nullptr; PACL acl = nullptr; ~Opened(){ if(handle!=INVALID_HANDLE_VALUE)CloseHandle(handle); if(descriptor)LocalFree(descriptor); } };
void Check(bool okay,const char* stage){if(!okay)throw std::runtime_error(std::string(stage)+":"+std::to_string(GetLastError()));}
bool Identity(HANDLE handle,const Expected& item) {
  FILE_ID_INFO info{}; if(!GetFileInformationByHandleEx(handle,FileIdInfo,&info,sizeof(info)) || info.VolumeSerialNumber!=item.volume)return false;
  std::wstring hex; for(const auto part:info.FileId.Identifier){hex.push_back(L"0123456789abcdef"[part>>4]);hex.push_back(L"0123456789abcdef"[part&15]);}
  return hex==item.fileId;
}
bool Verify(HANDLE handle,const Expected& item,PACL original,bool full) {
  PSECURITY_DESCRIPTOR descriptor=nullptr; PACL current=nullptr;
  if(GetSecurityInfo(handle,SE_FILE_OBJECT,DACL_SECURITY_INFORMATION,nullptr,nullptr,&current,nullptr,&descriptor)!=ERROR_SUCCESS)return false;
  SECURITY_DESCRIPTOR_CONTROL control{}; DWORD revision=0;
  const bool okay=GetSecurityDescriptorControl(descriptor,&control,&revision) && current && original && current->AclSize==original->AclSize
    && std::memcmp(current,original,current->AclSize)==0 && ((control^item.control)&(SE_DACL_PROTECTED|(full?SE_DACL_AUTO_INHERITED:0)))==0;
  LocalFree(descriptor);return okay && Identity(handle,item);
}
int wmain() {
  try {
    std::array<Opened,4> opened{};
    for(size_t i=0;i<expected.size();++i){
      auto& target=opened[i]; const auto& item=expected[i];
      target.handle=CreateFileW(item.path,READ_CONTROL|WRITE_DAC|FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE,nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr);
      Check(target.handle!=INVALID_HANDLE_VALUE,"open");
      FILE_ATTRIBUTE_TAG_INFO tag{};Check(GetFileInformationByHandleEx(target.handle,FileAttributeTagInfo,&tag,sizeof(tag)) && !(tag.FileAttributes&FILE_ATTRIBUTE_REPARSE_POINT),"tag");
      Check(Identity(target.handle,item),"identity");
      Check(ConvertStringSecurityDescriptorToSecurityDescriptorW(item.sddl,SDDL_REVISION_1,&target.descriptor,nullptr),"descriptor");
      BOOL present=FALSE,defaulted=FALSE;Check(GetSecurityDescriptorDacl(target.descriptor,&present,&target.acl,&defaulted) && present && target.acl,"dacl");
      Check(Verify(target.handle,item,target.acl,false),"precondition");
    }
    // Filesystem-specific API; finish every mutation before checking the final inherited state.
    for(size_t i=0;i<expected.size();++i){
      const auto flags=DACL_SECURITY_INFORMATION|((expected[i].control&SE_DACL_PROTECTED)?PROTECTED_DACL_SECURITY_INFORMATION:UNPROTECTED_DACL_SECURITY_INFORMATION);
      Check(SetSecurityInfo(opened[i].handle,SE_FILE_OBJECT,flags,nullptr,nullptr,opened[i].acl,nullptr)==ERROR_SUCCESS,"restore");
    }
    for(size_t i=0;i<expected.size();++i)Check(Verify(opened[i].handle,expected[i],opened[i].acl,true),"final_identity_acl_control");
    std::cout<<"{\"scope\":\"probe-03-four-recorded-objects\",\"objects\":4,\"fileIdentitiesMatch\":true,\"originalDaclBytesEqual\":true,\"protectedRestored\":true,\"autoInheritedRestored\":true,\"newProfiles\":0,\"newPrograms\":0}"<<std::endl;return 0;
  } catch(const std::exception& error){std::cerr<<error.what()<<std::endl;return 1;}
}

