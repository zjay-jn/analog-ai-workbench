#include "agent-work-cycle-runner-native-security.h"
using namespace aaw;
namespace {
constexpr ULONGLONG logLimit=1024ULL*1024, deadlineMs=15000, cleanupMs=5000;
const std::wstring evidence=productLocal+L"quality-evidence\\20260914-agent-command-native-01\\";
const std::wstring shell=L"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
struct Stream { Handle file; ULONGLONG observed=0,persisted=0; bool eof=false,limited=false; };
std::vector<Handle> processPins;
std::set<DWORD> observedPids;
std::string currentStage;
std::wstring currentPath;
DWORD currentAccess=0;
void Stage(const char* stage,const std::wstring& path,DWORD access=0){currentStage=stage;currentPath=path;currentAccess=access;}
HANDLE CheckedGrant(const std::wstring& name,bool directory,PSID package,DWORD mask,bool immutable){Stage("grant",name,WRITE_DAC|(immutable?GENERIC_READ:0));return Grant(name,directory,package,mask,immutable);}
void PrivateAcl(const std::wstring& name,bool directory,PSID package=nullptr,bool writable=false){
  // Ownership grants implicit WRITE_DAC, not WRITE_OWNER. Request only what this step needs.
  Stage("private_acl_open_dacl",name,WRITE_DAC);auto object=Open(name,directory,WRITE_DAC);
  PSID ownerRights=nullptr;Check(ConvertStringSidToSidW(L"S-1-3-4",&ownerRights),"owner_rights");
  std::array<EXPLICIT_ACCESSW,3> entries{};
  for(auto& e:entries){e.grfAccessMode=GRANT_ACCESS;e.grfInheritance=directory?SUB_CONTAINERS_AND_OBJECTS_INHERIT:NO_INHERITANCE;e.Trustee.TrusteeForm=TRUSTEE_IS_SID;}
  entries[0].grfAccessPermissions=FILE_ALL_ACCESS;entries[0].Trustee.ptstrName=static_cast<LPWSTR>(MainUser());
  entries[1].grfAccessPermissions=READ_CONTROL;entries[1].Trustee.ptstrName=static_cast<LPWSTR>(ownerRights);
  entries[2].grfAccessPermissions=writable?(FILE_GENERIC_READ|FILE_GENERIC_WRITE|FILE_GENERIC_EXECUTE|DELETE|FILE_DELETE_CHILD):(FILE_GENERIC_READ|FILE_GENERIC_EXECUTE);
  entries[2].Trustee.ptstrName=static_cast<LPWSTR>(package);
  PACL acl=nullptr;const DWORD made=SetEntriesInAclW(package?3:2,entries.data(),nullptr,&acl);LocalFree(ownerRights);Check(made==ERROR_SUCCESS,"private_acl_build");
  Stage("private_acl_apply_dacl",name,WRITE_DAC);const DWORD applied=SetSecurityInfo(object.h,SE_FILE_OBJECT,DACL_SECURITY_INFORMATION|PROTECTED_DACL_SECURITY_INFORMATION,nullptr,nullptr,acl,nullptr);LocalFree(acl);SetLastError(applied);Check(applied==ERROR_SUCCESS,"private_acl_apply");
  if(writable){Stage("private_acl_open_label",name,WRITE_OWNER);auto labelObject=Open(name,directory,WRITE_OWNER);
    PSECURITY_DESCRIPTOR sd=nullptr;Check(ConvertStringSecurityDescriptorToSecurityDescriptorW(L"S:(ML;OICI;NW;;;LW)",SDDL_REVISION_1,&sd,nullptr),"low_label_parse");
    PACL label=nullptr;BOOL present=FALSE,defaulted=FALSE;Check(GetSecurityDescriptorSacl(sd,&present,&label,&defaulted)&&present,"low_label_read");
    Stage("private_acl_apply_label",name,WRITE_OWNER);const DWORD labeled=SetSecurityInfo(labelObject.h,SE_FILE_OBJECT,LABEL_SECURITY_INFORMATION,nullptr,nullptr,nullptr,label);LocalFree(sd);SetLastError(labeled);Check(labeled==ERROR_SUCCESS,"low_label_apply");}
}
Handle PinnedShell(){
  Handle h(CreateFileW(shell.c_str(),GENERIC_READ|FILE_READ_ATTRIBUTES,FILE_SHARE_READ,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,nullptr));
  Check(h.h!=INVALID_HANDLE_VALUE,"shell_open");FILE_ATTRIBUTE_TAG_INFO tag{};Check(GetFileInformationByHandleEx(h.h,FileAttributeTagInfo,&tag,sizeof(tag)),"shell_attributes");
  Require(!(tag.FileAttributes&FILE_ATTRIBUTE_REPARSE_POINT)&&Lower(FinalPath(h.h))==Lower(shell),"shell_identity");
  Require(Hash(h.h,495616)=="8bb6fa8c283b4d92120b1ef249a9b311b0f804d4cabbe9981159976c8be76a5e","shell_hash");return h;
}
void VerifyProcess(HANDLE process,HANDLE job,PSID sid,DWORD pid){
  Handle token;Check(OpenProcessToken(process,TOKEN_QUERY,&token.h),"process_token");
  const auto app=TokenInfo(token.h,TokenIsAppContainer),caps=TokenInfo(token.h,TokenCapabilities),identity=TokenInfo(token.h,TokenAppContainerSid),integrity=TokenInfo(token.h,TokenIntegrityLevel);
  Require(*reinterpret_cast<const DWORD*>(app.data())==1&&reinterpret_cast<const TOKEN_GROUPS*>(caps.data())->GroupCount==0&&EqualSid(reinterpret_cast<const TOKEN_APPCONTAINER_INFORMATION*>(identity.data())->TokenAppContainer,sid),"appcontainer_identity");
  const auto label=reinterpret_cast<const TOKEN_MANDATORY_LABEL*>(integrity.data());Require(*GetSidSubAuthority(label->Label.Sid,*GetSidSubAuthorityCount(label->Label.Sid)-1)<=SECURITY_MANDATORY_LOW_RID,"integrity");
  BOOL inJob=FALSE;Check(IsProcessInJob(process,job,&inJob)&&inJob,"job_identity");
  FILETIME creation{},exit{},kernel{},user{};Check(GetProcessTimes(process,&creation,&exit,&kernel,&user),"process_creation");
  std::array<wchar_t,32768> executable{};DWORD size=static_cast<DWORD>(executable.size());Check(QueryFullProcessImageNameW(process,0,executable.data(),&size),"process_image");
  Record(L"process-"+std::to_wstring(pid),"{\"pid\":"+std::to_string(pid)+",\"image\":"+Json(std::wstring(executable.data(),size))+",\"creationTime100ns\":\""+std::to_string((static_cast<ULONGLONG>(creation.dwHighDateTime)<<32)|creation.dwLowDateTime)+"\",\"appContainer\":true,\"capabilityCount\":0,\"lowIntegrity\":true,\"inJob\":true}");
  observedPids.insert(pid);
}
DWORD ObserveJob(HANDLE job,PSID sid){
  alignas(JOBOBJECT_BASIC_PROCESS_ID_LIST) std::array<unsigned char,sizeof(JOBOBJECT_BASIC_PROCESS_ID_LIST)+8*sizeof(ULONG_PTR)> data{};
  auto list=reinterpret_cast<JOBOBJECT_BASIC_PROCESS_ID_LIST*>(data.data());Check(QueryInformationJobObject(job,JobObjectBasicProcessIdList,list,static_cast<DWORD>(data.size()),nullptr),"job_members");
  Require(list->NumberOfAssignedProcesses<=8&&list->NumberOfProcessIdsInList<=8,"process_limit");
  for(DWORD i=0;i<list->NumberOfProcessIdsInList;++i){const DWORD pid=static_cast<DWORD>(list->ProcessIdList[i]);if(observedPids.contains(pid))continue;
    Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION|SYNCHRONIZE,FALSE,pid));if(!process.h&&GetLastError()==ERROR_INVALID_PARAMETER)continue;Check(process.h!=nullptr,"member_open");
    DWORD code=0;Check(GetExitCodeProcess(process.h,&code),"member_exit");if(code!=STILL_ACTIVE)continue;
    VerifyProcess(process.h,job,sid,pid);processPins.push_back(std::move(process));}
  return list->NumberOfAssignedProcesses;
}
Stream Log(const std::wstring& path){Stream s;s.file.Reset(CreateFileW(Win32Path(path).c_str(),GENERIC_READ|GENERIC_WRITE,FILE_SHARE_READ,nullptr,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,nullptr));Check(s.file.h!=INVALID_HANDLE_VALUE,"log_create");return s;}
void Drain(HANDLE pipe,Stream& stream,ULONGLONG& total){
  if(stream.eof)return;
  for(unsigned turn=0;turn<16;++turn){DWORD available=0;if(!PeekNamedPipe(pipe,nullptr,0,nullptr,&available,nullptr)){Require(GetLastError()==ERROR_BROKEN_PIPE,"log_pipe");stream.eof=true;return;}if(!available)return;
    std::array<unsigned char,4096> bytes{};DWORD read=0;Check(ReadFile(pipe,bytes.data(),std::min<DWORD>(available,static_cast<DWORD>(bytes.size())),&read,nullptr),"log_read");stream.observed+=read;
    const DWORD keep=static_cast<DWORD>(std::min<ULONGLONG>(read,logLimit-total));if(keep){DWORD wrote=0;Check(WriteFile(stream.file.h,bytes.data(),keep,&wrote,nullptr)&&wrote==keep,"log_write");Check(FlushFileBuffers(stream.file.h),"log_flush");stream.persisted+=keep;total+=keep;}if(keep<read)stream.limited=true;
  }
}
bool Cancelled(HANDLE pipe){DWORD available=0;if(!PeekNamedPipe(pipe,nullptr,0,nullptr,&available,nullptr)){const DWORD code=GetLastError();Require(code==ERROR_BROKEN_PIPE||code==ERROR_NO_DATA,"control_pipe");return true;}if(!available)return false;
  std::array<char,16> bytes{};DWORD read=0;Check(ReadFile(pipe,bytes.data(),std::min<DWORD>(available,static_cast<DWORD>(bytes.size())),&read,nullptr),"control_read");Require(std::all_of(bytes.begin(),bytes.begin()+read,[](char ch){return ch=='C';}),"control_command");return true;}
std::string StreamJson(Stream& s){return "{\"observedBytes\":"+std::to_string(s.observed)+",\"persistedBytes\":"+std::to_string(s.persisted)+",\"eof\":"+(s.eof?"true":"false")+",\"coverage\":\""+(s.eof&&!s.limited?"complete":"partial")+"\",\"sha256\":\""+(s.file.h?Hash(s.file.h,s.persisted):"")+"\"}";}
}
int wmain(int argc,wchar_t** argv){
  PSID sid=nullptr;Handle job,child,thread,outRead,outWrite,errRead,errWrite,inRead,inWrite,shellPin;Stream out,err;
  std::wstring run,moniker;bool profileCreated=false,profileDeleted=false,jobClosed=false,cleanupConfirmed=false,started=false,privateGrantsRemoved=false;DWORD active=0,exitCode=0;bool hasExit=false;ULONGLONG total=0;
  std::string termination="isolation_failed",failure,failureStage;std::wstring failurePath;DWORD failureAccess=0;
  auto closeJob=[&](){if(!job.h){jobClosed=true;return true;}if(!TerminateJobObject(job.h,125))return false;const auto until=GetTickCount64()+cleanupMs;
    do{JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info{};if(!QueryInformationJobObject(job.h,JobObjectBasicAccountingInformation,&info,sizeof(info),nullptr))return false;active=info.ActiveProcesses;if(active==0){job.Reset();jobClosed=true;return true;}Sleep(10);}while(GetTickCount64()<until);return false;};
  auto cleanup=[&](){if(!closeJob())return false;const bool restored=RestoreGrants();ReleaseGrants();
    try{if(!run.empty()&&!userInfo.empty()){for(const auto& leaf:std::array<std::wstring,3>{L"work space 中文",L"home",L"temp"})PrivateAcl(run+L"\\"+leaf,true);privateGrantsRemoved=true;}}catch(...){privateGrantsRemoved=false;}
    if(profileCreated){if(FAILED(DeleteAppContainerProfile(moniker.c_str())))return false;profileCreated=false;profileDeleted=true;}else profileDeleted=true;return restored&&profileDeleted&&privateGrantsRemoved;};
  try{
    Require(argc==4&&IsHex(argv[1],32)&&IsHex(argv[2],64)&&IsHex(argv[3],64),"arguments");const std::wstring nonce=argv[1];run=evidence+L"probe-"+nonce;
    Stage("lock_ancestors",run,FILE_READ_ATTRIBUTES);LockAncestors(run+L"\\control");LockAncestors(run+L"\\runtime");LockAncestors(run+L"\\work space 中文");
    Handle own;Check(OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&own.h),"own_token");userInfo=TokenInfo(own.h,TokenUser);
    PrivateAcl(run,true);PrivateAcl(run+L"\\control",true);recoveryRoot=run+L"\\control";
    Record(L"claim","{\"schema\":\"aaw.command.probe.v1\",\"nonce\":"+Json(nonce)+",\"scope\":\"synthetic_compatibility_only\",\"processLimit\":8,\"deadlineMs\":15000,\"logLimitBytes\":1048576,\"shellSha256\":\"8bb6fa8c283b4d92120b1ef249a9b311b0f804d4cabbe9981159976c8be76a5e\"}");
    out=Log(recoveryRoot+L"\\stdout.bin");err=Log(recoveryRoot+L"\\stderr.bin");shellPin=PinnedShell();
    PWSTR host=nullptr;Check(SHGetKnownFolderPath(FOLDERID_LocalAppData,0,nullptr,&host)==S_OK&&host,"host_localappdata");Check(SetEnvironmentVariableW(L"LOCALAPPDATA",host),"host_localappdata_set");CoTaskMemFree(host);
    host=nullptr;Check(SHGetKnownFolderPath(FOLDERID_Profile,0,nullptr,&host)==S_OK&&host,"host_profile");Check(SetEnvironmentVariableW(L"USERPROFILE",host),"host_profile_set");CoTaskMemFree(host);
    moniker=L"AAW.Command."+nonce;Record(L"profile-intent","{\"profile\":"+Json(moniker)+",\"capabilities\":0}");
    const HRESULT made=CreateAppContainerProfile(moniker.c_str(),moniker.c_str(),L"AAW isolated synthetic command compatibility probe",nullptr,0,&sid);Require(made==S_OK,("create_profile:"+std::to_string(static_cast<unsigned long>(made))).c_str());profileCreated=true;
    const auto runtime=run+L"\\runtime",work=run+L"\\work space 中文",home=run+L"\\home",temp=run+L"\\temp",baseline=run+L"\\baseline";
    CheckedGrant(baseline,true,sid,FILE_GENERIC_READ|FILE_GENERIC_EXECUTE,false);
    const auto baselineFile=CheckedGrant(baseline+L"\\input.json",false,sid,FILE_GENERIC_READ,true);
    Record(L"baseline","{\"path\":"+Json(baseline+L"\\input.json")+",\"bytes\":8,\"sha256\":\""+Hash(baselineFile,8)+"\"}");
    CheckedGrant(runtime,true,sid,FILE_GENERIC_READ|FILE_GENERIC_EXECUTE,false);
    const auto node=CheckedGrant(runtime+L"\\node.exe",false,sid,FILE_GENERIC_READ|FILE_GENERIC_EXECUTE,true);Require(Hash(node,93381448)=="5c976096e04e5c2c1f091938926234cc9fbebfe9787ddd149351b3b0ecc707b5","node_hash");
    for(const auto& item:std::array<std::pair<std::wstring,std::wstring>,2>{{{L"command.ps1",argv[2]},{L"probe.cjs",argv[3]}}}){auto h=CheckedGrant(runtime+L"\\"+item.first,false,sid,FILE_GENERIC_READ,true);LARGE_INTEGER size{};Check(GetFileSizeEx(h,&size)&&size.QuadPart>=0&&size.QuadPart<=65536,"script_size");Require(Hash(h,static_cast<ULONGLONG>(size.QuadPart))==Utf8(item.second),"script_hash");}
    PrivateAcl(work,true,sid,true);PrivateAcl(home,true,sid,true);PrivateAcl(temp,true,sid,true);
    Stage("create_job",run);job.Reset(CreateJobObjectW(nullptr,nullptr));Check(job.h!=nullptr,"job_create");JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE|JOB_OBJECT_LIMIT_ACTIVE_PROCESS|JOB_OBJECT_LIMIT_PROCESS_MEMORY|JOB_OBJECT_LIMIT_JOB_MEMORY|JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
    limits.BasicLimitInformation.ActiveProcessLimit=8;limits.ProcessMemoryLimit=512ULL*1024*1024;limits.JobMemoryLimit=1024ULL*1024*1024;Check(SetInformationJobObject(job.h,JobObjectExtendedLimitInformation,&limits,sizeof(limits)),"job_limits");
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION readback{};Check(QueryInformationJobObject(job.h,JobObjectExtendedLimitInformation,&readback,sizeof(readback),nullptr),"job_limits_readback");Require(readback.BasicLimitInformation.ActiveProcessLimit==8&&!(readback.BasicLimitInformation.LimitFlags&(JOB_OBJECT_LIMIT_BREAKAWAY_OK|JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK)),"no_breakaway");
    SECURITY_ATTRIBUTES inherit{sizeof(inherit),nullptr,TRUE};Check(CreatePipe(&outRead.h,&outWrite.h,&inherit,0)&&CreatePipe(&errRead.h,&errWrite.h,&inherit,0)&&CreatePipe(&inRead.h,&inWrite.h,&inherit,0),"stdio_create");
    Check(SetHandleInformation(outRead.h,HANDLE_FLAG_INHERIT,0)&&SetHandleInformation(errRead.h,HANDLE_FLAG_INHERIT,0)&&SetHandleInformation(inWrite.h,HANDLE_FLAG_INHERIT,0),"stdio_inheritance");
    SIZE_T bytes=0;InitializeProcThreadAttributeList(nullptr,3,0,&bytes);std::vector<unsigned char> memory(bytes);auto attrs=reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(memory.data());Check(InitializeProcThreadAttributeList(attrs,3,0,&bytes),"attribute_list");
    SECURITY_CAPABILITIES capabilities{};capabilities.AppContainerSid=sid;HANDLE handles[]{inRead.h,outWrite.h,errWrite.h};
    Check(UpdateProcThreadAttribute(attrs,0,PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,&capabilities,sizeof(capabilities),nullptr,nullptr),"capabilities");Check(UpdateProcThreadAttribute(attrs,0,PROC_THREAD_ATTRIBUTE_JOB_LIST,&job.h,sizeof(job.h),nullptr,nullptr),"atomic_job");Check(UpdateProcThreadAttribute(attrs,0,PROC_THREAD_ATTRIBUTE_HANDLE_LIST,handles,sizeof(handles),nullptr,nullptr),"stdio_handles");
    STARTUPINFOEXW startup{};startup.StartupInfo.cb=sizeof(startup);startup.StartupInfo.dwFlags=STARTF_USESTDHANDLES;startup.StartupInfo.hStdInput=inRead.h;startup.StartupInfo.hStdOutput=outWrite.h;startup.StartupInfo.hStdError=errWrite.h;startup.lpAttributeList=attrs;
    std::map<std::wstring,std::wstring> vars{{L"AAW_BASELINE",baseline+L"\\input.json"},{L"AAW_CONTROL",recoveryRoot+L"\\claim.json"},{L"AAW_NODE",runtime+L"\\node.exe"},{L"AAW_SCRIPT",runtime+L"\\probe.cjs"},{L"APPDATA",home},{L"HOME",home},{L"HOMEDRIVE",L"C:"},{L"HOMEPATH",home.substr(2)},{L"LOCALAPPDATA",home},{L"PATH",runtime+L";C:\\Windows\\System32"},{L"PATHEXT",L".EXE"},{L"PSModulePath",L""},{L"SystemDrive",L"C:"},{L"SystemRoot",L"C:\\Windows"},{L"TEMP",temp},{L"TMP",temp},{L"USERPROFILE",home},{L"windir",L"C:\\Windows"}};
    std::wstring environment;for(const auto& pair:vars){environment+=pair.first+L"="+pair.second;environment.push_back(0);}environment.push_back(0);
    std::wstring command=L"\""+shell+L"\" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File \""+runtime+L"\\command.ps1\"";
    constexpr DWORD creationFlags=EXTENDED_STARTUPINFO_PRESENT|CREATE_SUSPENDED|CREATE_NO_WINDOW|CREATE_UNICODE_ENVIRONMENT;
    Record(L"launch","{\"executable\":"+Json(shell)+",\"commandLine\":"+Json(command)+",\"creationFlags\":"+std::to_string(creationFlags)+",\"nonce\":"+Json(nonce)+",\"executionPolicy\":\"RemoteSigned\",\"executionPolicyScope\":\"Process\",\"cwd\":"+Json(work)+",\"home\":"+Json(home)+",\"temp\":"+Json(temp)+",\"hostEnvironmentInherited\":false,\"networkCapabilities\":0,\"executableAllowlistEnforced\":false}");
    Stage("create_powershell",shell);PROCESS_INFORMATION info{};const BOOL created=CreateProcessW(shell.c_str(),command.data(),nullptr,nullptr,TRUE,creationFlags,environment.data(),work.c_str(),&startup.StartupInfo,&info);
    const DWORD createError=GetLastError();DeleteProcThreadAttributeList(attrs);SetLastError(createError);Check(created,"create_process");child.Reset(info.hProcess);thread.Reset(info.hThread);outWrite.Reset();errWrite.Reset();inWrite.Reset();inRead.Reset();
    VerifyProcess(child.h,job.h,sid,info.dwProcessId);Record(L"started","{\"pid\":"+std::to_string(info.dwProcessId)+",\"atomicJob\":true,\"killOnJobClose\":true,\"breakawayAllowed\":false}");started=true;
    const HANDLE control=GetStdHandle(STD_INPUT_HANDLE);Require(control&&control!=INVALID_HANDLE_VALUE&&GetFileType(control)==FILE_TYPE_PIPE,"control_handle");
    const auto began=GetTickCount64();if(Cancelled(control))termination="cancelled";else{Check(ResumeThread(thread.h)!=static_cast<DWORD>(-1),"resume");for(;;){
      active=ObserveJob(job.h,sid);Drain(outRead.h,out,total);Drain(errRead.h,err,total);
      if(Cancelled(control)){termination="cancelled";break;}if(out.limited||err.limited){termination="log_limit";break;}
      const DWORD wait=WaitForSingleObject(child.h,0);if(wait==WAIT_OBJECT_0){termination="exited";break;}Check(wait==WAIT_TIMEOUT,"child_wait");if(GetTickCount64()-began>=deadlineMs){termination="timed_out";break;}Sleep(10);
    }}
    Check(closeJob(),"job_cleanup");Check(WaitForSingleObject(child.h,static_cast<DWORD>(cleanupMs))==WAIT_OBJECT_0,"child_exit");Check(GetExitCodeProcess(child.h,&exitCode),"exit_code");hasExit=true;
    const auto drainUntil=GetTickCount64()+cleanupMs;do{Drain(outRead.h,out,total);Drain(errRead.h,err,total);if(out.eof&&err.eof)break;Sleep(10);}while(GetTickCount64()<drainUntil);
    cleanupConfirmed=cleanup();
  }catch(const std::exception& e){failure=e.what();failureStage=currentStage;failurePath=currentPath;failureAccess=currentAccess;termination="isolation_failed";cleanupConfirmed=cleanup();if(outRead.h){try{Drain(outRead.h,out,total);}catch(...){}}if(errRead.h){try{Drain(errRead.h,err,total);}catch(...){}}}
  if(sid)FreeSid(sid);
  try{const std::wstring failureWide(failure.begin(),failure.end()),stageWide(failureStage.begin(),failureStage.end());const std::string report="{\"schema\":\"aaw.command.probe.result.v1\",\"termination\":\""+termination+"\",\"failure\":"+Json(failureWide)+",\"failureStage\":"+Json(stageWide)+",\"failurePath\":"+Json(failurePath)+",\"failureRequestedAccess\":"+std::to_string(failureAccess)+",\"started\":"+(started?"true":"false")+",\"entryExitCode\":"+(hasExit?std::to_string(exitCode):"null")+",\"observedProcessCount\":"+std::to_string(observedPids.size())+",\"activeProcesses\":"+std::to_string(active)+",\"jobClosed\":"+(jobClosed?"true":"false")+",\"profileDeleted\":"+(profileDeleted?"true":"false")+",\"cleanupConfirmed\":"+(cleanupConfirmed?"true":"false")+",\"stdout\":"+StreamJson(out)+",\"stderr\":"+StreamJson(err)+"}";if(!recoveryRoot.empty())Record(L"result",report);std::cout<<report<<std::endl;}
  catch(const std::exception& e){std::cerr<<e.what()<<std::endl;return 2;}
  return termination=="exited"&&hasExit&&exitCode==0&&cleanupConfirmed&&out.eof&&err.eof&&observedPids.size()>=2?0:1;
}
