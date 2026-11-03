#include "agent-work-cycle-runner-native-security.h"
#include <cstdio>
using namespace aaw;
namespace {
const std::wstring engineImage=productLocal+L"agent-engine-candidate-v1.18.17\\opencode.exe";
constexpr char engineSha[]="2d8ed451c4c3e4dd69b9dec026030ec5bd00814b8f2b81483f8d80e35d8dce54";
constexpr ULONGLONG engineBytes=178721160,cleanupMs=2000;
std::string stage="arguments";
void Stage(const char* name){stage=name;SetLastError(ERROR_SUCCESS);}
struct LifecycleFailure:std::runtime_error {DWORD code;LifecycleFailure(const char* operation,DWORD value):std::runtime_error(std::string(operation)+":"+std::to_string(value)),code(value){}};
void LifecycleCheck(bool okay,const char* operation){if(!okay)throw LifecycleFailure(operation,GetLastError());}
const char* B(bool value){return value?"true":"false";}
std::string Quote(const std::string& text){return Json(std::wstring(text.begin(),text.end()));}
std::string Now(){SYSTEMTIME t{};GetSystemTime(&t);char value[32]{};sprintf_s(value,"%04u-%02u-%02uT%02u:%02u:%02u.%03uZ",t.wYear,t.wMonth,t.wDay,t.wHour,t.wMinute,t.wSecond,t.wMilliseconds);return value;}
bool Uuid(const std::wstring& value){
  if(value.size()!=36||value[14]!=L'4'||std::wstring(L"89ab").find(value[19])==std::wstring::npos)return false;
  for(size_t i=0;i<value.size();++i){if(i==8||i==13||i==18||i==23){if(value[i]!=L'-')return false;}else if(!IsHex(value.substr(i,1),1))return false;}return true;
}
DWORD Port(const std::wstring& value){Require(!value.empty()&&value.size()<=5&&value[0]!=L'0',"port");DWORD result=0;for(const auto ch:value){Require(ch>=L'0'&&ch<=L'9',"port");result=result*10+static_cast<DWORD>(ch-L'0');}Require(result>=1024&&result<=65535,"port");return result;}
std::string Creation(HANDLE process){FILETIME created{},exit{},kernel{},user{};Check(GetProcessTimes(process,&created,&exit,&kernel,&user),"process_creation");return std::to_string((static_cast<ULONGLONG>(created.dwHighDateTime)<<32)|created.dwLowDateTime);}
std::wstring Image(HANDLE process){std::array<wchar_t,32768> value{};DWORD count=static_cast<DWORD>(value.size());Check(QueryFullProcessImageNameW(process,0,value.data(),&count),"process_image");return std::wstring(value.data(),count);}
std::string Identity(HANDLE process,DWORD pid,bool engine){return "{\"pid\":"+std::to_string(pid)+",\"creationTime100ns\":"+Quote(Creation(process))+",\"image\":"+Json(Image(process))+(engine?",\"sha256\":"+Quote(engineSha):"")+"}";}
void AtomicRecord(const std::wstring& name,const std::string& text){
  Record(name+L"-pending",text);
  Check(MoveFileExW(Win32Path(recoveryRoot+L"\\"+name+L"-pending.json").c_str(),Win32Path(recoveryRoot+L"\\"+name+L".json").c_str(),MOVEFILE_WRITE_THROUGH),"record_publish");
}
std::string Control(HANDLE pipe){
  DWORD available=0;if(!PeekNamedPipe(pipe,nullptr,0,nullptr,&available,nullptr)){const auto error=GetLastError();Require(error==ERROR_BROKEN_PIPE||error==ERROR_NO_DATA,"control_pipe");return "parent_lost";}
  if(!available)return "";std::array<char,16> bytes{};DWORD count=0;Check(ReadFile(pipe,bytes.data(),std::min<DWORD>(available,static_cast<DWORD>(bytes.size())),&count,nullptr),"control_read");
  Require(count>0&&std::all_of(bytes.begin(),bytes.begin()+count,[](char ch){return ch=='C';}),"control_command");return "requested";
}
Handle Inheritable(HANDLE source){
  Handle target;Require(source&&source!=INVALID_HANDLE_VALUE&&GetFileType(source)==FILE_TYPE_PIPE,"diagnostic_pipe");
  Check(DuplicateHandle(GetCurrentProcess(),source,GetCurrentProcess(),&target.h,0,TRUE,DUPLICATE_SAME_ACCESS),"duplicate_diagnostic");return target;
}
// Main supplies its existing explicit environment to this helper. It is passed unchanged
// to the fixed engine only; never serialize environment/configuration/auth tokens.
struct Environment {LPWCH value=GetEnvironmentStringsW();~Environment(){if(value)FreeEnvironmentStringsW(value);}};
struct Attributes {std::vector<unsigned char> memory;LPPROC_THREAD_ATTRIBUTE_LIST value=nullptr;~Attributes(){if(value)DeleteProcThreadAttributeList(value);}
  void Initialize(){SIZE_T size=0;InitializeProcThreadAttributeList(nullptr,2,0,&size);memory.resize(size);auto candidate=reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(memory.data());Check(InitializeProcThreadAttributeList(candidate,2,0,&size),"attribute_list");value=candidate;}};
}
int wmain(int argc,wchar_t** argv){
  Handle job,child,thread,enginePin,cwdPin,rootPin,controlPin,nullInput,out,err;
  std::wstring root,nonce;DWORD port=0,enginePid=0,active=0,exitCode=0,errorCode=0;
  bool launched=false,engineExited=false,emptyConfirmed=false,jobClosed=false,cleanupConfirmed=false;
  std::string ownIdentity="null",engineIdentity="null",termination="fault",errorStage;
  ULONGLONG cleanupDeadline=0;
  const HANDLE parentControl=GetStdHandle(STD_INPUT_HANDLE);
  auto remainingCleanup=[&](){const auto now=GetTickCount64();if(!cleanupDeadline)cleanupDeadline=now+cleanupMs;return static_cast<DWORD>(now<cleanupDeadline?cleanupDeadline-now:0);};
  auto closeJob=[&](){
    if(!job.h){jobClosed=true;if(!launched)emptyConfirmed=true;return emptyConfirmed;}
    remainingCleanup();if(!TerminateJobObject(job.h,125))return false;
    do{JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info{};if(!QueryInformationJobObject(job.h,JobObjectBasicAccountingInformation,&info,sizeof(info),nullptr))return false;
      active=info.ActiveProcesses;if(active==0){emptyConfirmed=true;job.Reset();jobClosed=true;return true;}const auto remaining=remainingCleanup();if(!remaining){SetLastError(ERROR_TIMEOUT);return false;}Sleep(std::min<DWORD>(10,remaining));
    }while(true);
  };
  auto awaitEngine=[&](){
    if(engineExited)return true;if(!child.h)return !launched;
    const DWORD wait=WaitForSingleObject(child.h,remainingCleanup());
    if(wait==WAIT_TIMEOUT){SetLastError(ERROR_TIMEOUT);return false;}
    if(wait==WAIT_FAILED)return false;
    if(wait!=WAIT_OBJECT_0){SetLastError(ERROR_INVALID_DATA);return false;}
    if(!GetExitCodeProcess(child.h,&exitCode))return false;engineExited=true;return true;
  };
  try{
    Require(argc==3,"arguments");root=argv[1];const auto prefix=productLocal+L"agent-engine-pilot\\native\\";
    Require(root.rfind(prefix,0)==0&&Uuid(root.substr(prefix.size())),"engine_root");nonce=root.substr(prefix.size());port=Port(argv[2]);
    Stage("paths");LockAncestors(root+L"\\cwd");LockAncestors(engineImage);rootPin=Open(root,true);cwdPin=Open(root+L"\\cwd",true);
    const auto controlRoot=root+L"\\guardian-control";Check(CreateDirectoryW(Win32Path(controlRoot).c_str(),nullptr),"fresh_control");controlPin=Open(controlRoot,true);recoveryRoot=controlRoot;
    ownIdentity=Identity(GetCurrentProcess(),GetCurrentProcessId(),false);
    Require(parentControl&&parentControl!=INVALID_HANDLE_VALUE&&GetFileType(parentControl)==FILE_TYPE_PIPE,"parent_control");
    Stage("engine_pin");enginePin=Open(engineImage,false,GENERIC_READ,true);Require(Hash(enginePin.h,engineBytes)==engineSha,"engine_hash");
    AtomicRecord(L"intent","{\"schema\":\"aaw.engine.guardian.intent.v1\",\"nonce\":"+Json(nonce)+",\"root\":"+Json(root)+",\"port\":"+std::to_string(port)+",\"guardian\":"+ownIdentity+",\"engineImage\":"+Json(engineImage)+",\"engineSha256\":"+Quote(engineSha)+",\"hostCapabilityBoundaryChanged\":false}");
    Stage("job");job.Reset(CreateJobObjectW(nullptr,nullptr));Check(job.h!=nullptr,"job_create");JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    Check(SetInformationJobObject(job.h,JobObjectExtendedLimitInformation,&limits,sizeof(limits)),"job_limits");
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION actual{};Check(QueryInformationJobObject(job.h,JobObjectExtendedLimitInformation,&actual,sizeof(actual),nullptr),"job_readback");
    Require(actual.BasicLimitInformation.LimitFlags==JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,"job_policy");
    Stage("stdio");SECURITY_ATTRIBUTES inherit{sizeof(inherit),nullptr,TRUE};nullInput.Reset(CreateFileW(L"NUL",GENERIC_READ,FILE_SHARE_READ|FILE_SHARE_WRITE,&inherit,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,nullptr));Check(nullInput.h!=INVALID_HANDLE_VALUE,"nul_stdin");
    out=Inheritable(GetStdHandle(STD_OUTPUT_HANDLE));err=Inheritable(GetStdHandle(STD_ERROR_HANDLE));
    Attributes attributes;attributes.Initialize();HANDLE handles[]{nullInput.h,out.h,err.h};
    Check(UpdateProcThreadAttribute(attributes.value,0,PROC_THREAD_ATTRIBUTE_JOB_LIST,&job.h,sizeof(job.h),nullptr,nullptr),"atomic_job");
    Check(UpdateProcThreadAttribute(attributes.value,0,PROC_THREAD_ATTRIBUTE_HANDLE_LIST,handles,sizeof(handles),nullptr,nullptr),"handle_list");
    STARTUPINFOEXW startup{};startup.StartupInfo.cb=sizeof(startup);startup.StartupInfo.dwFlags=STARTF_USESTDHANDLES;startup.StartupInfo.hStdInput=nullInput.h;startup.StartupInfo.hStdOutput=out.h;startup.StartupInfo.hStdError=err.h;startup.lpAttributeList=attributes.value;
    Environment environment;Check(environment.value!=nullptr,"environment");const auto before=Control(parentControl);Require(before.empty(),"parent_already_closed");
    std::wstring command=L"\""+engineImage+L"\" serve --hostname 127.0.0.1 --port "+std::to_wstring(port)+L" --mdns=false";
    constexpr DWORD flags=EXTENDED_STARTUPINFO_PRESENT|CREATE_SUSPENDED|CREATE_NO_WINDOW|CREATE_UNICODE_ENVIRONMENT;
    Stage("create_engine");PROCESS_INFORMATION info{};Check(CreateProcessW(engineImage.c_str(),command.data(),nullptr,nullptr,TRUE,flags,environment.value,(root+L"\\cwd").c_str(),&startup.StartupInfo,&info),"create_process");
    child.Reset(info.hProcess);thread.Reset(info.hThread);enginePid=info.dwProcessId;launched=true;active=1;nullInput.Reset();out.Reset();err.Reset();
    BOOL inJob=FALSE;Check(IsProcessInJob(child.h,job.h,&inJob)&&inJob,"engine_job");Require(Lower(Image(child.h))==Lower(engineImage),"engine_process_image");engineIdentity=Identity(child.h,enginePid,true);
    Stage("ready");AtomicRecord(L"ready","{\"schema\":\"aaw.engine.guardian.ready.v1\",\"nonce\":"+Json(nonce)+",\"root\":"+Json(root)+",\"port\":"+std::to_string(port)+",\"startedAt\":"+Quote(Now())+",\"guardian\":"+ownIdentity+",\"engine\":"+engineIdentity+",\"job\":{\"atomic\":true,\"killOnClose\":true,\"breakawayAllowed\":false}}");
    termination=Control(parentControl);if(termination.empty()){
      Check(ResumeThread(thread.h)!=static_cast<DWORD>(-1),"resume");
      for(;;){Stage("monitor");termination=Control(parentControl);if(!termination.empty())break;const auto state=WaitForSingleObject(child.h,10);if(state==WAIT_OBJECT_0){termination="exited";break;}Check(state==WAIT_TIMEOUT,"engine_wait");}
    }
    Stage("cleanup");LifecycleCheck(closeJob(),"job_close");LifecycleCheck(awaitEngine(),"engine_exited");cleanupConfirmed=emptyConfirmed&&jobClosed&&engineExited;
  }catch(const std::exception& failure){const auto lifecycle=dynamic_cast<const LifecycleFailure*>(&failure);errorCode=lifecycle?lifecycle->code:GetLastError();errorStage=stage;termination="fault";const bool jobDone=closeJob(),engineDone=awaitEngine();cleanupConfirmed=jobDone&&engineDone;}
  try{
    const std::string result="{\"schema\":\"aaw.engine.guardian.result.v1\",\"nonce\":"+Json(nonce)+",\"root\":"+Json(root)+",\"port\":"+std::to_string(port)+",\"completedAt\":"+Quote(Now())+",\"guardian\":"+ownIdentity+",\"engine\":"+engineIdentity+",\"engineExited\":"+B(engineExited)+",\"engineExitCode\":"+(engineExited?std::to_string(exitCode):"null")+",\"termination\":"+Quote(termination)+",\"job\":{\"activeProcesses\":"+std::to_string(active)+",\"emptyConfirmed\":"+B(emptyConfirmed)+",\"closed\":"+B(jobClosed)+"},\"cleanupConfirmed\":"+B(cleanupConfirmed)+",\"error\":"+(errorStage.empty()?"null":"{\"stage\":"+Quote(errorStage)+",\"nativeCode\":"+std::to_string(errorCode)+"}")+"}";
    if(!recoveryRoot.empty())AtomicRecord(L"result",result);else std::cerr<<"AAW_ENGINE_GUARDIAN_ERROR "<<errorStage<<":"<<errorCode<<std::endl;
  }catch(...){return 2;}
  return cleanupConfirmed&&errorStage.empty()?0:1;
}
