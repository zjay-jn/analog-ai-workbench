#include "agent-work-cycle-runner-native-security.h"
#include "runner-limits.h"
using namespace aaw;
namespace {
struct Capture {std::vector<unsigned char> bytes;ULONGLONG total=0;bool truncated=false;};
struct Request {std::wstring execution,runtime,input,output,id,signature,nonce,script,scriptHash;std::map<std::wstring,std::pair<std::string,ULONGLONG>> inputs;};
bool Uuid(const std::wstring& value){if(value.size()!=36)return false;for(size_t i=0;i<value.size();++i){if(i==8||i==13||i==18||i==23){if(value[i]!=L'-')return false;}else if(!((value[i]>=L'0'&&value[i]<=L'9')||(value[i]>=L'a'&&value[i]<=L'f')))return false;}return true;}
Request Parse(int argc,wchar_t** argv){
  Require(argc>=11&&argc<=10+static_cast<int>(limits::files),"arguments");Request r{argv[1],argv[2],argv[3],argv[4],argv[5],argv[6],argv[7],argv[8],argv[9],{}};
  Require(r.id.rfind(L"wce-",0)==0&&Uuid(r.id.substr(4)),"execution_id");
  Require(IsHex(r.signature,64)&&IsHex(r.nonce,32)&&IsHex(r.scriptHash,64)&&Relative(r.script)&&r.script.size()>3&&r.script.substr(r.script.size()-3)==L".js","request_identity");
  const auto testPrefix=productLocal+L"agent-work-cycle-runner\\native-tests\\";
  bool scoped=r.execution==productLocal+L"agent-work-cycle-runner\\executions\\"+r.id;
  if(r.execution.rfind(testPrefix,0)==0){const auto tail=r.execution.substr(testPrefix.size());scoped=tail.size()>=36&&Uuid(tail.substr(0,36))&&tail==tail.substr(0,36)+L"\\executions\\"+r.id;}
  Require(scoped&&r.runtime==r.execution+L"\\runtime","execution_scope");
  Require(Within(r.input,productLocal)&&r.input.size()>6&&r.input.substr(r.input.size()-6)==L"\\input"&&r.output==r.input.substr(0,r.input.size()-6)+L"\\output","snapshot_scope");
  const auto parent=r.input.substr(0,r.input.size()-6);Require(parent.size()>r.id.size()&&parent.substr(parent.size()-r.id.size())==r.id,"snapshot_identity");
  std::set<std::wstring> names;ULONGLONG total=0;
  for(int i=10;i<argc;++i){const std::wstring entry(argv[i]);const auto first=entry.find(L':'),second=entry.find(L':',first==std::wstring::npos?0:first+1);
    Require(first==64&&second!=std::wstring::npos&&IsHex(entry.substr(0,64),64),"input_identity");const auto number=entry.substr(first+1,second-first-1),name=entry.substr(second+1);
    Require(!number.empty()&&number.size()<10&&std::all_of(number.begin(),number.end(),[](wchar_t ch){return ch>=L'0'&&ch<=L'9';})&&Relative(name)&&names.insert(Lower(name)).second,"input_identity");
    const auto size=std::stoull(number);Require(size<=limits::fileBytes,"input_size");total+=size;r.inputs.emplace(name,std::make_pair(Utf8(entry.substr(0,64)),size));
  }
  Require(total<=limits::workspaceBytes&&r.inputs.contains(r.script)&&r.inputs.at(r.script).first==Utf8(r.scriptHash),"script_identity");return r;
}
void InputAcl(const Request& r,PSID sid){
  auto root=Grant(r.input,true,sid,FILE_GENERIC_READ|FILE_GENERIC_EXECUTE,false);(void)root;
  std::vector<TreeEntry> entries;Walk(r.input,L"",entries);size_t files=0;
  for(const auto& entry:entries){const auto name=r.input+L"\\"+NativeRelative(entry.relative);
    if(entry.directory){Grant(name,true,sid,FILE_GENERIC_READ|FILE_GENERIC_EXECUTE,false);continue;}
    ++files;const auto expected=r.inputs.find(entry.relative);Require(expected!=r.inputs.end()&&entry.bytes==expected->second.second,"unexpected_input");
    const auto handle=Grant(name,false,sid,FILE_GENERIC_READ,true);Require(Hash(handle,entry.bytes)==expected->second.first,"input_changed");
  }Require(files==r.inputs.size(),"input_missing");
}
void RuntimeAcl(const Request& r,PSID sid){
  Grant(r.runtime,true,sid,FILE_GENERIC_READ|FILE_GENERIC_EXECUTE,false);
  std::vector<TreeEntry> entries;Walk(r.runtime,L"",entries);Require(entries.size()==3,"runtime_contents");
  const std::array<std::pair<std::wstring,std::pair<ULONGLONG,std::string>>,3> expected{{
    {L"node.exe",{93381448ULL,"5c976096e04e5c2c1f091938926234cc9fbebfe9787ddd149351b3b0ecc707b5"}},
    {L"LICENSE",{160555ULL,"ed34dd8e3f0a78dbaf00d0444ce8e285b015b765379c2e17880455f70370f8e9"}},
    {L"program.cjs",{r.inputs.at(r.script).second,Utf8(r.scriptHash)}}}};
  for(const auto& item:expected){const auto found=std::find_if(entries.begin(),entries.end(),[&](const TreeEntry& entry){return entry.relative==item.first&&!entry.directory;});
    Require(found!=entries.end(),"runtime_contents");const auto file=Grant(r.runtime+L"\\"+item.first,false,sid,FILE_GENERIC_READ|(item.first==L"node.exe"?FILE_GENERIC_EXECUTE:0),true);
    Require(Hash(file,item.second.first)==item.second.second,"runtime_changed");
  }
}
bool OutputLimit(const std::wstring& output){
  try{std::vector<TreeEntry> entries;Walk(output,L"",entries);ULONGLONG total=0;size_t files=0;
    for(const auto& entry:entries){if(entry.directory)continue;total+=entry.bytes;++files;if(entry.bytes>limits::fileBytes||total>limits::outputBytes||files>limits::artifactsPerExecution)return true;}return false;
  }catch(...){return true;}
}
void Drain(HANDLE pipe,Capture& capture){
  // Bounded work per turn keeps cancellation/deadline checks responsive during a log flood.
  for(unsigned turn=0;turn<16;++turn){DWORD available=0;
    if(!PeekNamedPipe(pipe,nullptr,0,nullptr,&available,nullptr)){Require(GetLastError()==ERROR_BROKEN_PIPE,"log_pipe");return;}
    if(!available)return;std::array<unsigned char,4096> chunk{};DWORD read=0;
    Check(ReadFile(pipe,chunk.data(),std::min<DWORD>(available,static_cast<DWORD>(chunk.size())),&read,nullptr),"log_read");
    capture.total+=read;const size_t keep=std::min<size_t>(read,limits::logBytes-capture.bytes.size());capture.bytes.insert(capture.bytes.end(),chunk.begin(),chunk.begin()+keep);if(keep<read)capture.truncated=true;
  }
}
bool Cancelled(HANDLE pipe){
  DWORD available=0;if(!PeekNamedPipe(pipe,nullptr,0,nullptr,&available,nullptr)){const DWORD error=GetLastError();Require(error==ERROR_BROKEN_PIPE||error==ERROR_NO_DATA,"control_pipe");return true;}
  if(!available)return false;std::array<char,16> bytes{};DWORD read=0;Check(ReadFile(pipe,bytes.data(),std::min<DWORD>(available,static_cast<DWORD>(bytes.size())),&read,nullptr),"control_read");
  Require(std::all_of(bytes.begin(),bytes.begin()+read,[](char ch){return ch=='C';}),"control_command");return true;
}
std::wstring Environment(const Request& r,PSID sid){
  LPWSTR sidText=nullptr;PWSTR folder=nullptr;Check(ConvertSidToStringSidW(sid,&sidText),"sid_string");
  const HRESULT result=GetAppContainerFolderPath(sidText,&folder);LocalFree(sidText);
  Require(SUCCEEDED(result)&&folder,"profile_folder");const std::wstring profile(folder);CoTaskMemFree(folder);
  const auto normalized=Lower(profile),suffix=L"\\packages\\aaw.c1.analysis."+r.nonce+L"\\ac";
#ifdef AAW_PORTABLE_RUNTIME
  Require(normalized.size()>3&&normalized[1]==L':'&&normalized[2]==L'\\'&&normalized.size()>suffix.size()&&normalized.ends_with(suffix),"profile_identity");
  const std::wstring systemRoot=portable_runtime::systemRoot;
#else
  Require(normalized.rfind(L"c:\\",0)==0&&normalized.size()>suffix.size()&&normalized.ends_with(suffix),"profile_identity");
  const std::wstring systemRoot=L"C:\\Windows";
#endif
  Record(L"environment","{\"profileFolder\":"+Json(profile)+",\"hostEnvironmentInherited\":false}");
  const std::vector<std::wstring> values{L"AAW_INPUT_DIR="+r.input,L"AAW_OUTPUT_DIR="+r.output,L"APPDATA="+profile,
    L"ComSpec="+systemRoot+L"\\System32\\cmd.exe",L"HOMEDRIVE="+profile.substr(0,2),L"HOMEPATH="+profile.substr(2),L"LOCALAPPDATA="+profile,
    L"PATH="+r.runtime+L";"+systemRoot+L"\\System32",L"PATHEXT=.COM;.EXE;.BAT;.CMD",L"SystemDrive="+systemRoot.substr(0,2),L"SystemRoot="+systemRoot,
    L"TEMP="+r.output,L"TMP="+r.output,L"USERPROFILE="+profile,L"windir="+systemRoot};
  std::wstring block;for(const auto& item:values){block+=item;block.push_back(0);}block.push_back(0);return block;
}
void PrepareHostEnvironment(){
  // The launcher's own profile APIs need these two current-user OS locations. They are never inherited by the child.
  PWSTR folder=nullptr;Check(SHGetKnownFolderPath(FOLDERID_LocalAppData,0,nullptr,&folder)==S_OK&&folder,"host_localappdata");
  const std::wstring local(folder);CoTaskMemFree(folder);Check(SetEnvironmentVariableW(L"LOCALAPPDATA",local.c_str()),"host_localappdata");
  folder=nullptr;Check(SHGetKnownFolderPath(FOLDERID_Profile,0,nullptr,&folder)==S_OK&&folder,"host_profile");
  const std::wstring profile(folder);CoTaskMemFree(folder);Check(SetEnvironmentVariableW(L"USERPROFILE",profile.c_str()),"host_profile");
}
} // namespace
int wmain(int argc,wchar_t** argv){
  Request request;PSID sid=nullptr;Handle job,child,thread,stdoutRead,stdoutWrite,stderrRead,stderrWrite,stdinRead,stdinWrite;
  std::wstring moniker;bool profileCreated=false,profileDeleted=false,aclRestored=false,appContainer=false,atomicJob=false,lowIntegrity=false,cleanupConfirmed=false,aclFailure=false;
  bool claimed=false;DWORD activeProcesses=0;std::string termination="isolation_failed";DWORD exitCode=0;bool hasExitCode=false;ULONGLONG began=0,duration=0;Capture out,err;
  auto cleanup=[&](){
    bool empty=true;
    if(job.h){if(!TerminateJobObject(job.h,125))empty=false;
      const ULONGLONG end=GetTickCount64()+limits::cleanupMs;
      for(;;){JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};if(!QueryInformationJobObject(job.h,JobObjectBasicAccountingInformation,&accounting,sizeof(accounting),nullptr)){empty=false;break;}
        activeProcesses=accounting.ActiveProcesses;if(!activeProcesses)break;if(GetTickCount64()>=end){empty=false;break;}Sleep(10);}
      if(empty)job.Reset();
    }
    if(!empty)return false;
    const bool restored=RestoreGrants();if(!restored)aclFailure=true;
    const bool normalized=request.output.empty()||NormalizeOutput(request.output);if(!normalized)aclFailure=true;
    RecordAclCleanupDiagnostics(restored,normalized);
    aclRestored=!aclFailure;ReleaseGrants();
    if(profileCreated){if(FAILED(DeleteAppContainerProfile(moniker.c_str())))return false;profileCreated=false;profileDeleted=true;}else if(!claimed)profileDeleted=true;
    return aclRestored&&profileDeleted;
  };
  try{
    request=Parse(argc,argv);LockAncestors(request.execution);LockAncestors(request.runtime);LockAncestors(request.input);LockAncestors(request.output);
    auto exec=Open(request.execution,true);auto output=Open(request.output,true);auto runtime=Open(request.runtime,true);(void)exec;(void)output;(void)runtime;
    recoveryRoot=request.execution;
    Record(L"native-claim","{\"executionId\":"+Json(request.id)+",\"signature\":"+Json(request.signature)+",\"nonce\":"+Json(request.nonce)+"}");claimed=true;
    std::vector<TreeEntry> empty;Walk(request.output,L"",empty);Require(empty.empty(),"output_not_empty");
    Handle ownToken;Check(OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&ownToken.h),"own_token");userInfo=TokenInfo(ownToken.h,TokenUser);
    PrepareHostEnvironment();
    moniker=L"AAW.C1.Analysis."+request.nonce;
    Record(L"profile-intent","{\"executionId\":"+Json(request.id)+",\"signature\":"+Json(request.signature)+",\"profile\":"+Json(moniker)+",\"capabilities\":0}");
    const HRESULT made=CreateAppContainerProfile(moniker.c_str(),moniker.c_str(),L"AAW C1 temporary task analysis",nullptr,0,&sid);
    Require(made==S_OK,"create_profile");profileCreated=true;
    Record(L"profile-owned","{\"executionId\":"+Json(request.id)+",\"signature\":"+Json(request.signature)+",\"profile\":"+Json(moniker)+"}");
    RuntimeAcl(request,sid);InputAcl(request,sid);
    Grant(request.output,true,sid,FILE_GENERIC_READ|FILE_GENERIC_WRITE|FILE_GENERIC_EXECUTE|DELETE|FILE_DELETE_CHILD,false);
    job.Reset(CreateJobObjectW(nullptr,nullptr));Check(job.h!=nullptr,"job");
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION jobLimits{};
    jobLimits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE|JOB_OBJECT_LIMIT_ACTIVE_PROCESS|JOB_OBJECT_LIMIT_PROCESS_MEMORY|JOB_OBJECT_LIMIT_JOB_MEMORY|JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
    jobLimits.BasicLimitInformation.ActiveProcessLimit=static_cast<DWORD>(limits::processes);
    jobLimits.ProcessMemoryLimit=limits::processMemoryBytes;jobLimits.JobMemoryLimit=limits::jobMemoryBytes;
    Check(SetInformationJobObject(job.h,JobObjectExtendedLimitInformation,&jobLimits,sizeof(jobLimits)),"job_limits");
    SECURITY_ATTRIBUTES inheritable{sizeof(inheritable),nullptr,TRUE};
    Check(CreatePipe(&stdoutRead.h,&stdoutWrite.h,&inheritable,0)&&CreatePipe(&stderrRead.h,&stderrWrite.h,&inheritable,0)&&CreatePipe(&stdinRead.h,&stdinWrite.h,&inheritable,0),"stdio_pipe");
    Check(SetHandleInformation(stdoutRead.h,HANDLE_FLAG_INHERIT,0)&&SetHandleInformation(stderrRead.h,HANDLE_FLAG_INHERIT,0)&&SetHandleInformation(stdinWrite.h,HANDLE_FLAG_INHERIT,0),"stdio_inheritance");
    SIZE_T count=0;InitializeProcThreadAttributeList(nullptr,4,0,&count);std::vector<unsigned char> memory(count);auto attrs=reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(memory.data());
    Check(InitializeProcThreadAttributeList(attrs,4,0,&count),"attribute_list");
    SECURITY_CAPABILITIES capabilities{};capabilities.AppContainerSid=sid;HANDLE handles[]{stdinRead.h,stdoutWrite.h,stderrWrite.h};
    Check(UpdateProcThreadAttribute(attrs,0,PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,&capabilities,sizeof(capabilities),nullptr,nullptr),"capabilities");
    Check(UpdateProcThreadAttribute(attrs,0,PROC_THREAD_ATTRIBUTE_JOB_LIST,&job.h,sizeof(job.h),nullptr,nullptr),"atomic_job");
    Check(UpdateProcThreadAttribute(attrs,0,PROC_THREAD_ATTRIBUTE_HANDLE_LIST,handles,sizeof(handles),nullptr,nullptr),"stdio_handles");
    DWORD childPolicy=PROCESS_CREATION_CHILD_PROCESS_RESTRICTED;
    Check(UpdateProcThreadAttribute(attrs,0,PROC_THREAD_ATTRIBUTE_CHILD_PROCESS_POLICY,&childPolicy,sizeof(childPolicy),nullptr,nullptr),"child_process_policy");
    STARTUPINFOEXW startup{};startup.StartupInfo.cb=sizeof(startup);startup.StartupInfo.dwFlags=STARTF_USESTDHANDLES;startup.StartupInfo.hStdInput=stdinRead.h;startup.StartupInfo.hStdOutput=stdoutWrite.h;startup.StartupInfo.hStdError=stderrWrite.h;startup.lpAttributeList=attrs;
    const std::wstring executable=request.runtime+L"\\node.exe";
    // Native already pins every no-link path component; the JS loader must not re-stat ungranted drive ancestors.
    std::wstring command=L"\""+executable+L"\" --no-addons --no-global-search-paths --preserve-symlinks-main \""+request.runtime+L"\\program.cjs\"";std::wstring environment=Environment(request,sid);
    // No console allocation: even a hidden conhost would violate the one-process child policy.
    PROCESS_INFORMATION info{};const BOOL created=CreateProcessW(executable.c_str(),command.data(),nullptr,nullptr,TRUE,EXTENDED_STARTUPINFO_PRESENT|CREATE_SUSPENDED|DETACHED_PROCESS|CREATE_UNICODE_ENVIRONMENT,environment.data(),request.input.c_str(),&startup.StartupInfo,&info);
    const DWORD createError=GetLastError();DeleteProcThreadAttributeList(attrs);SetLastError(createError);Check(created,"create_process");
    child.Reset(info.hProcess);thread.Reset(info.hThread);stdoutWrite.Reset();stderrWrite.Reset();stdinWrite.Reset();stdinRead.Reset();
    Handle token;Check(OpenProcessToken(child.h,TOKEN_QUERY,&token.h),"child_token");
    const auto app=TokenInfo(token.h,TokenIsAppContainer),caps=TokenInfo(token.h,TokenCapabilities),identity=TokenInfo(token.h,TokenAppContainerSid),integrity=TokenInfo(token.h,TokenIntegrityLevel);
    Require(*reinterpret_cast<const DWORD*>(app.data())==1&&reinterpret_cast<const TOKEN_GROUPS*>(caps.data())->GroupCount==0&&EqualSid(reinterpret_cast<const TOKEN_APPCONTAINER_INFORMATION*>(identity.data())->TokenAppContainer,sid),"appcontainer_identity");appContainer=true;
    const auto label=reinterpret_cast<const TOKEN_MANDATORY_LABEL*>(integrity.data());
    Require(*GetSidSubAuthority(label->Label.Sid,*GetSidSubAuthorityCount(label->Label.Sid)-1)<=SECURITY_MANDATORY_LOW_RID,"integrity");lowIntegrity=true;
    BOOL inJob=FALSE;Check(IsProcessInJob(child.h,job.h,&inJob)&&inJob,"job_identity");atomicJob=true;
    PROCESS_MITIGATION_CHILD_PROCESS_POLICY verifiedChildPolicy{};
    Check(GetProcessMitigationPolicy(child.h,ProcessChildProcessPolicy,&verifiedChildPolicy,sizeof(verifiedChildPolicy))&&verifiedChildPolicy.NoChildProcessCreation,"child_policy_verify");
    Record(L"started","{\"executionId\":"+Json(request.id)+",\"signature\":"+Json(request.signature)+",\"pid\":"+std::to_string(info.dwProcessId)+",\"appContainer\":true,\"capabilityCount\":0,\"atomicJob\":true,\"lowIntegrity\":true}");
    began=GetTickCount64();
    const HANDLE control=GetStdHandle(STD_INPUT_HANDLE);Require(control&&control!=INVALID_HANDLE_VALUE&&GetFileType(control)==FILE_TYPE_PIPE,"control_handle");
    if(Cancelled(control)){termination="cancelled";Check(TerminateJobObject(job.h,125),"cancel_before_resume");}
    else{
      Check(ResumeThread(thread.h)!=static_cast<DWORD>(-1),"resume");
      for(;;){
        Drain(stdoutRead.h,out);Drain(stderrRead.h,err);
        if(Cancelled(control)){termination="cancelled";break;}
        if(out.total+err.total>limits::outputBytes||OutputLimit(request.output)){termination="limit";break;}
        const DWORD waiting=WaitForSingleObject(child.h,0);if(waiting==WAIT_OBJECT_0){termination="exited";break;}Check(waiting==WAIT_TIMEOUT,"process_wait");
        if(GetTickCount64()-began>=limits::executionMs){termination="timed_out";break;}Sleep(10);
      }
    }
    duration=std::min<ULONGLONG>(GetTickCount64()-began,limits::nativeCallMs);
    if(termination!="exited")Check(TerminateJobObject(job.h,termination=="timed_out"?124:125),"terminate_job");
    Check(WaitForSingleObject(child.h,static_cast<DWORD>(limits::cleanupMs))==WAIT_OBJECT_0,"child_exit");
    Check(GetExitCodeProcess(child.h,&exitCode),"exit_code");hasExitCode=true;
    // Kill any descendants still alive after the entry process exits before draining and artifact inspection.
    Check(TerminateJobObject(job.h,125),"terminate_descendants");
    Drain(stdoutRead.h,out);Drain(stderrRead.h,err);
    cleanupConfirmed=cleanup();
    Record(L"cleanup",std::string("{\"executionId\":")+Json(request.id)+",\"signature\":"+Json(request.signature)+",\"cleanupConfirmed\":"+(cleanupConfirmed?"true":"false")+",\"aclRestored\":"+(aclRestored?"true":"false")+",\"profileDeleted\":"+(profileDeleted?"true":"false")+",\"activeProcesses\":"+std::to_string(activeProcesses)+"}");
  }catch(const std::exception& error){
    std::cerr<<error.what()<<std::endl;termination="isolation_failed";if(began)duration=std::min<ULONGLONG>(GetTickCount64()-began,limits::nativeCallMs);
    cleanupConfirmed=cleanup();
    if(claimed){try{Record(L"cleanup-failed",std::string("{\"executionId\":")+Json(request.id)+",\"signature\":"+Json(request.signature)+",\"cleanupConfirmed\":"+(cleanupConfirmed?"true":"false")+",\"aclRestored\":"+(aclRestored?"true":"false")+",\"profileDeleted\":"+(profileDeleted?"true":"false")+",\"activeProcesses\":"+std::to_string(activeProcesses)+"}");}catch(...){}}
  }
  if(sid)FreeSid(sid);
  const std::string report=std::string("{\"version\":1,\"executionId\":")+Json(request.id)+",\"signature\":"+Json(request.signature)+",\"termination\":\""+termination+"\",\"exitCode\":"+(hasExitCode?std::to_string(exitCode):"null")+",\"durationMs\":"+std::to_string(duration)
    +",\"stdoutHex\":\""+Hex(out.bytes.data(),out.bytes.size())+"\",\"stderrHex\":\""+Hex(err.bytes.data(),err.bytes.size())+"\",\"stdoutTruncated\":"+(out.truncated?"true":"false")+",\"stderrTruncated\":"+(err.truncated?"true":"false")
    +",\"cleanupConfirmed\":"+(cleanupConfirmed?"true":"false")+",\"appContainer\":"+(appContainer?"true":"false")+",\"capabilityCount\":0,\"atomicJob\":"+(atomicJob?"true":"false")+",\"lowIntegrity\":"+(lowIntegrity?"true":"false")
    +",\"profileDeleted\":"+(profileDeleted?"true":"false")+",\"aclRestored\":"+(aclRestored?"true":"false")+",\"activeProcesses\":"+std::to_string(activeProcesses)+"}";
  std::cout<<report<<std::endl;return 0;
}
