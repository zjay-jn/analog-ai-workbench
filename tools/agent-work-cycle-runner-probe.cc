#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <userenv.h>
#include <aclapi.h>
#include <string>
#include <vector>
#include <iostream>
#include <stdexcept>

struct Handle { HANDLE h = nullptr; ~Handle() { if (h && h != INVALID_HANDLE_VALUE) CloseHandle(h); } };
void Check(BOOL ok, const char* stage) { if (!ok) throw std::runtime_error(std::string(stage) + ":" + std::to_string(GetLastError())); }
void Grant(const std::wstring& name, PSID sid, DWORD mask) {
  const std::wstring prefix = L"C:\\work\\analog_ai_workbench\\.local\\agent-work-cycle-runner\\probe-01\\";
  if (name.rfind(prefix, 0) != 0) throw std::runtime_error("path");
  Handle file{CreateFileW(name.c_str(), READ_CONTROL | WRITE_DAC | FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr)};
  Check(file.h != INVALID_HANDLE_VALUE, "open");
  FILE_ATTRIBUTE_TAG_INFO tag{};
  Check(GetFileInformationByHandleEx(file.h, FileAttributeTagInfo, &tag, sizeof(tag)), "tag");
  if (tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) throw std::runtime_error("reparse");
  PACL oldAcl = nullptr, newAcl = nullptr; PSECURITY_DESCRIPTOR descriptor = nullptr;
  if (GetSecurityInfo(file.h, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr, &oldAcl, nullptr, &descriptor) != ERROR_SUCCESS) throw std::runtime_error("get_acl");
  EXPLICIT_ACCESSW access{}; access.grfAccessPermissions = mask; access.grfAccessMode = GRANT_ACCESS;
  access.grfInheritance = NO_INHERITANCE; access.Trustee.TrusteeForm = TRUSTEE_IS_SID; access.Trustee.ptstrName = static_cast<LPWSTR>(sid);
  const DWORD made = SetEntriesInAclW(1, &access, oldAcl, &newAcl);
  if (made != ERROR_SUCCESS) { LocalFree(descriptor); throw std::runtime_error("make_acl"); }
  const DWORD applied = SetSecurityInfo(file.h, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, nullptr, nullptr, newAcl, nullptr);
  LocalFree(newAcl); LocalFree(descriptor);
  if (applied != ERROR_SUCCESS) throw std::runtime_error("set_acl");
}
std::vector<unsigned char> Info(HANDLE token, TOKEN_INFORMATION_CLASS kind) {
  DWORD bytes = 0; GetTokenInformation(token, kind, nullptr, 0, &bytes);
  if (!bytes || bytes > 65536) throw std::runtime_error("token_size");
  std::vector<unsigned char> value(bytes);
  Check(GetTokenInformation(token, kind, value.data(), bytes, &bytes), "token_info"); return value;
}
int wmain() {
  PSID sid = nullptr;
  try {
    const std::wstring base = L"C:\\work\\analog_ai_workbench\\.local\\agent-work-cycle-runner\\probe-01\\";
    const std::wstring runtime = base + L"runtime\\node.exe", input = base + L"input", output = base + L"output";
    const std::wstring moniker = L"AAW.C1.Probe." + std::to_wstring(GetCurrentProcessId()) + L"." + std::to_wstring(GetTickCount64());
    if (FAILED(DeriveAppContainerSidFromAppContainerName(moniker.c_str(), &sid))) throw std::runtime_error("derive_sid");
    Grant(base + L"runtime", sid, FILE_GENERIC_READ | FILE_GENERIC_EXECUTE);
    Grant(runtime, sid, FILE_GENERIC_READ | FILE_GENERIC_EXECUTE);
    Grant(input, sid, FILE_GENERIC_READ | FILE_GENERIC_EXECUTE);
    Grant(output, sid, FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE | FILE_DELETE_CHILD);
    Handle job{CreateJobObjectW(nullptr, nullptr)}; Check(job.h != nullptr, "job");
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_JOB_MEMORY;
    limits.BasicLimitInformation.ActiveProcessLimit = 4; limits.JobMemoryLimit = 512ULL * 1024 * 1024;
    Check(SetInformationJobObject(job.h, JobObjectExtendedLimitInformation, &limits, sizeof(limits)), "job_limits");
    SIZE_T bytes = 0; InitializeProcThreadAttributeList(nullptr, 2, 0, &bytes);
    std::vector<unsigned char> memory(bytes); auto attrs = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(memory.data());
    Check(InitializeProcThreadAttributeList(attrs, 2, 0, &bytes), "attribute_list");
    SECURITY_CAPABILITIES capabilities{}; capabilities.AppContainerSid = sid;
    Check(UpdateProcThreadAttribute(attrs, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, &capabilities, sizeof(capabilities), nullptr, nullptr), "capabilities");
    Check(UpdateProcThreadAttribute(attrs, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, &job.h, sizeof(job.h), nullptr, nullptr), "job_attribute");
    STARTUPINFOEXW startup{}; startup.StartupInfo.cb = sizeof(startup); startup.lpAttributeList = attrs;
    const std::wstring program = L"require('node:fs').writeFileSync(process.env.AAW_OUTPUT_DIR+'/result.json',JSON.stringify({sum:19+23}));";
    std::wstring command = L"\"" + runtime + L"\" --no-addons --no-global-search-paths -e \"" + program + L"\"";
    std::wstring env = L"AAW_OUTPUT_DIR=" + output; env.push_back(0); env += L"SystemRoot=C:\\Windows"; env.push_back(0); env += L"TEMP=" + output; env.push_back(0); env += L"TMP=" + output; env.push_back(0); env.push_back(0);
    PROCESS_INFORMATION process{};
    const BOOL created = CreateProcessW(runtime.c_str(), command.data(), nullptr, nullptr, FALSE, EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT, env.data(), input.c_str(), &startup.StartupInfo, &process);
    const DWORD createError = GetLastError(); DeleteProcThreadAttributeList(attrs); SetLastError(createError); Check(created, "create_process");
    Handle child{process.hProcess}, thread{process.hThread}, token;
    Check(OpenProcessToken(child.h, TOKEN_QUERY, &token.h), "open_token");
    const auto app = Info(token.h, TokenIsAppContainer), caps = Info(token.h, TokenCapabilities), sidInfo = Info(token.h, TokenAppContainerSid), integrity = Info(token.h, TokenIntegrityLevel);
    if (*reinterpret_cast<const DWORD*>(app.data()) != 1 || reinterpret_cast<const TOKEN_GROUPS*>(caps.data())->GroupCount != 0 || !EqualSid(reinterpret_cast<const TOKEN_APPCONTAINER_INFORMATION*>(sidInfo.data())->TokenAppContainer, sid)) throw std::runtime_error("token_identity");
    const auto label = reinterpret_cast<const TOKEN_MANDATORY_LABEL*>(integrity.data());
    if (*GetSidSubAuthority(label->Label.Sid, *GetSidSubAuthorityCount(label->Label.Sid) - 1) > SECURITY_MANDATORY_LOW_RID) throw std::runtime_error("integrity");
    BOOL inJob = FALSE; Check(IsProcessInJob(child.h, job.h, &inJob) && inJob, "job_identity");
    Check(ResumeThread(thread.h) != static_cast<DWORD>(-1), "resume");
    if (WaitForSingleObject(child.h, 10000) != WAIT_OBJECT_0) { TerminateJobObject(job.h, 124); throw std::runtime_error("timeout"); }
    DWORD exitCode = 0; Check(GetExitCodeProcess(child.h, &exitCode), "exit_code");
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
    for (int retry = 0; retry < 50; ++retry) { Check(QueryInformationJobObject(job.h, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), nullptr), "job_accounting"); if (accounting.ActiveProcesses == 0) break; Sleep(10); }
    if (accounting.ActiveProcesses != 0 || exitCode != 0) throw std::runtime_error("probe_exit_" + std::to_string(exitCode));
    std::cout << "{\"profileless\":true,\"appContainer\":true,\"networkCapabilities\":0,\"atomicJob\":true,\"lowIntegrity\":true,\"activeProcesses\":0,\"exitCode\":0}" << std::endl;
    FreeSid(sid); return 0;
  } catch (const std::exception& error) { if (sid) FreeSid(sid); std::cerr << error.what() << std::endl; return 1; }
}
