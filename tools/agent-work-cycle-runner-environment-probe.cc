#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <userenv.h>
#include <aclapi.h>
#include <bcrypt.h>
#include <sddl.h>
#include <combaseapi.h>
#include <cstring>
#include <string>
#include <vector>
#include <iostream>
#include <stdexcept>

struct Handle { HANDLE h = nullptr; ~Handle() { if (h && h != INVALID_HANDLE_VALUE) CloseHandle(h); } };
void Check(BOOL ok, const char* stage) { if (!ok) throw std::runtime_error(std::string(stage) + ":" + std::to_string(GetLastError())); }
const std::wstring recoveryRoot = L"C:\\work\\analog_ai_workbench\\.local\\agent-work-cycle-runner\\probe-03\\";
std::string Utf8(const std::wstring& text) {
  if (text.empty()) return {};
  const int count = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), nullptr, 0, nullptr, nullptr);
  if (count <= 0) throw std::runtime_error("utf8");
  std::string value(static_cast<size_t>(count), 0);
  Check(WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), value.data(), count, nullptr, nullptr) == count, "utf8"); return value;
}
std::string Json(const std::wstring& text) {
  std::string value = "\"";
  for (const unsigned char ch : Utf8(text)) {
    if (ch == '\\' || ch == '"') { value.push_back('\\'); value.push_back(static_cast<char>(ch)); }
    else if (ch < 32) throw std::runtime_error("json_control");
    else value.push_back(static_cast<char>(ch));
  }
  return value + "\"";
}
void Record(const std::wstring& name, const std::string& text) {
  Handle file{CreateFileW((recoveryRoot + name + L".json").c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr)};
  Check(file.h != INVALID_HANDLE_VALUE, "record_create");
  DWORD written = 0; Check(WriteFile(file.h, text.data(), static_cast<DWORD>(text.size()), &written, nullptr) && written == text.size(), "record_write");
  Check(FlushFileBuffers(file.h), "record_flush");
}
struct SavedGrant { HANDLE handle; PSECURITY_DESCRIPTOR descriptor; SECURITY_DESCRIPTOR_CONTROL control; FILE_ID_INFO identity; std::wstring path; };
std::vector<SavedGrant> grants;
void Grant(const std::wstring& name, PSID sid, DWORD mask) {
  if (name.rfind(recoveryRoot, 0) != 0) throw std::runtime_error("path");
  Handle file{CreateFileW(name.c_str(), READ_CONTROL | WRITE_DAC | FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr)};
  Check(file.h != INVALID_HANDLE_VALUE, "open");
  FILE_ATTRIBUTE_TAG_INFO tag{}; FILE_ID_INFO identity{};
  Check(GetFileInformationByHandleEx(file.h, FileAttributeTagInfo, &tag, sizeof(tag)), "tag");
  Check(GetFileInformationByHandleEx(file.h, FileIdInfo, &identity, sizeof(identity)), "identity");
  if (tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) throw std::runtime_error("reparse");
  PACL oldAcl = nullptr, newAcl = nullptr; PSECURITY_DESCRIPTOR descriptor = nullptr;
  if (GetSecurityInfo(file.h, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr, &oldAcl, nullptr, &descriptor) != ERROR_SUCCESS) throw std::runtime_error("get_acl");
  SECURITY_DESCRIPTOR_CONTROL control{}; DWORD revision = 0;
  Check(GetSecurityDescriptorControl(descriptor, &control, &revision), "acl_control");
  LPWSTR sddl = nullptr;
  Check(ConvertSecurityDescriptorToStringSecurityDescriptorW(descriptor, SDDL_REVISION_1, DACL_SECURITY_INFORMATION, &sddl, nullptr), "acl_sddl");
  const std::wstring savedSddl(sddl); LocalFree(sddl);
  std::string fileId;
  for (const unsigned char part : identity.FileId.Identifier) { fileId.push_back("0123456789abcdef"[part >> 4]); fileId.push_back("0123456789abcdef"[part & 15]); }
  try { Record(L"acl-" + std::to_wstring(grants.size()), "{\"path\":" + Json(name) + ",\"volume\":" + std::to_string(identity.VolumeSerialNumber) + ",\"fileId\":\"" + fileId + "\",\"sddl\":" + Json(savedSddl) + ",\"control\":" + std::to_string(control) + "}"); }
  catch (...) { LocalFree(descriptor); throw; }
  grants.push_back({file.h, descriptor, control, identity, name}); file.h = nullptr;
  EXPLICIT_ACCESSW access{}; access.grfAccessPermissions = mask; access.grfAccessMode = GRANT_ACCESS;
  access.grfInheritance = NO_INHERITANCE; access.Trustee.TrusteeForm = TRUSTEE_IS_SID; access.Trustee.ptstrName = static_cast<LPWSTR>(sid);
  if (SetEntriesInAclW(1, &access, oldAcl, &newAcl) != ERROR_SUCCESS) throw std::runtime_error("make_acl");
  const DWORD applied = SetSecurityInfo(grants.back().handle, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, nullptr, nullptr, newAcl, nullptr);
  LocalFree(newAcl); if (applied != ERROR_SUCCESS) throw std::runtime_error("set_acl");
}
bool RestoreGrants() {
  bool okay = true;
  for (auto it = grants.rbegin(); it != grants.rend(); ++it) {
    FILE_ID_INFO identity{};
    bool restored = GetFileInformationByHandleEx(it->handle, FileIdInfo, &identity, sizeof(identity)) && std::memcmp(&identity, &it->identity, sizeof(identity)) == 0;
    const SECURITY_INFORMATION flags = DACL_SECURITY_INFORMATION | ((it->control & SE_DACL_PROTECTED) ? PROTECTED_DACL_SECURITY_INFORMATION : UNPROTECTED_DACL_SECURITY_INFORMATION);
    if (restored) restored = SetKernelObjectSecurity(it->handle, flags, it->descriptor) != FALSE;
    PACL current = nullptr, previous = nullptr; PSECURITY_DESCRIPTOR readback = nullptr; BOOL present = FALSE, defaulted = FALSE;
    if (restored) restored = GetSecurityInfo(it->handle, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr, &current, nullptr, &readback) == ERROR_SUCCESS;
    SECURITY_DESCRIPTOR_CONTROL control{}; DWORD revision = 0;
    if (restored) restored = GetSecurityDescriptorDacl(it->descriptor, &present, &previous, &defaulted) && GetSecurityDescriptorControl(readback, &control, &revision)
      && ((control ^ it->control) & (SE_DACL_PROTECTED | SE_DACL_AUTO_INHERITED)) == 0
      && current && previous && current->AclSize == previous->AclSize && std::memcmp(current, previous, current->AclSize) == 0;
    if (readback) LocalFree(readback);
    if (!restored) okay = false;
    CloseHandle(it->handle); LocalFree(it->descriptor);
  }
  grants.clear(); return okay;
}
std::vector<unsigned char> Info(HANDLE token, TOKEN_INFORMATION_CLASS kind) {
  DWORD bytes = 0; GetTokenInformation(token, kind, nullptr, 0, &bytes);
  if (!bytes || bytes > 65536) throw std::runtime_error("token_size");
  std::vector<unsigned char> value(bytes);
  Check(GetTokenInformation(token, kind, value.data(), bytes, &bytes), "token_info"); return value;
}
int wmain() {
  PSID sid = nullptr; Handle job; bool profileCreated = false; bool restoredGrants = false; bool aclFailure = false; std::wstring moniker;
  auto cleanup = [&]() -> bool {
    if (job.h) {
      if (!TerminateJobObject(job.h, 125)) return false;
      JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
      bool empty = false;
      for (int retry = 0; retry < 500; ++retry) {
        if (!QueryInformationJobObject(job.h, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), nullptr)) return false;
        if (accounting.ActiveProcesses == 0) { empty = true; break; } Sleep(10);
      }
      if (!empty) return false;
      CloseHandle(job.h); job.h = nullptr;
    }
    const bool restored = RestoreGrants(); if (!restored) aclFailure = true; restoredGrants = !aclFailure;
    if (profileCreated) {
      if (FAILED(DeleteAppContainerProfile(moniker.c_str()))) return false;
      profileCreated = false;
    }
    return !aclFailure;
  };
  try {
    const std::wstring base = L"C:\\work\\analog_ai_workbench\\.local\\agent-work-cycle-runner\\probe-03\\";
    const std::wstring runtime = base + L"runtime\\node.exe", input = base + L"input", output = base + L"output";
    unsigned char nonce[16]{};
    if (BCryptGenRandom(nullptr, nonce, sizeof(nonce), BCRYPT_USE_SYSTEM_PREFERRED_RNG) != 0) throw std::runtime_error("random");
    moniker = L"AAW.C1.Analysis.Probe.";
    for (const auto value : nonce) { moniker.push_back(L"0123456789abcdef"[value >> 4]); moniker.push_back(L"0123456789abcdef"[value & 15]); }
    Record(L"intent", "{\"phase\":\"profile_intent\",\"profile\":" + Json(moniker) + ",\"capabilities\":0}");
    const HRESULT createdProfile = CreateAppContainerProfile(moniker.c_str(), moniker.c_str(), L"AAW C1 temporary synthetic analysis probe", nullptr, 0, &sid);
    if (createdProfile != S_OK) throw std::runtime_error("create_profile_" + std::to_string(static_cast<unsigned long>(createdProfile)));
    profileCreated = true;
    Record(L"owned", "{\"phase\":\"profile_created\",\"profile\":" + Json(moniker) + "}");
    Grant(base + L"runtime", sid, FILE_GENERIC_READ | FILE_GENERIC_EXECUTE);
    Grant(runtime, sid, FILE_GENERIC_READ | FILE_GENERIC_EXECUTE);
    Grant(input, sid, FILE_GENERIC_READ | FILE_GENERIC_EXECUTE);
    Grant(output, sid, FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE | FILE_DELETE_CHILD);
    job.h = CreateJobObjectW(nullptr, nullptr); Check(job.h != nullptr, "job");
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
    LPWSTR sidText = nullptr; PWSTR profileFolder = nullptr;
    Check(ConvertSidToStringSidW(sid, &sidText), "sid_string");
    const HRESULT folderResult = GetAppContainerFolderPath(sidText, &profileFolder); LocalFree(sidText);
    if (FAILED(folderResult) || !profileFolder) throw std::runtime_error("profile_folder");
    const std::wstring profilePath(profileFolder); CoTaskMemFree(profileFolder);
    Record(L"environment", "{\"profile\":" + Json(moniker) + ",\"profileFolder\":" + Json(profilePath) + ",\"hostEnvironmentInherited\":false}");
    const std::vector<std::wstring> values{
      L"AAW_INPUT_DIR=" + input, L"AAW_OUTPUT_DIR=" + output, L"APPDATA=" + profilePath,
      L"ComSpec=C:\\Windows\\System32\\cmd.exe", L"HOMEDRIVE=C:", L"HOMEPATH=" + profilePath.substr(2),
      L"LOCALAPPDATA=" + profilePath, L"PATH=" + base + L"runtime;C:\\Windows\\System32",
      L"PATHEXT=.COM;.EXE;.BAT;.CMD", L"SystemDrive=C:", L"SystemRoot=C:\\Windows",
      L"TEMP=" + output, L"TMP=" + output, L"USERPROFILE=" + profilePath, L"windir=C:\\Windows"};
    std::wstring env; for (const auto& item : values) { env += item; env.push_back(0); } env.push_back(0);
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
    if (!cleanup()) throw std::runtime_error("cleanup");
    Record(L"closed", "{\"profileDeleted\":true,\"aclRestored\":true,\"activeProcesses\":0}");
    std::cout << "{\"profileCreated\":true,\"profileDeleted\":true,\"aclRestored\":true,\"appContainer\":true,\"networkCapabilities\":0,\"atomicJob\":true,\"lowIntegrity\":true,\"activeProcesses\":0,\"exitCode\":0}" << std::endl;
    FreeSid(sid); return 0;
  } catch (const std::exception& error) { const bool cleaned = cleanup(); if (sid) FreeSid(sid); try { Record(L"failed-closed", std::string("{\"cleanupConfirmed\":") + (cleaned ? "true" : "false") + ",\"profileDeleted\":" + (profileCreated ? "false" : "true") + ",\"aclRestored\":" + (restoredGrants ? "true" : "false") + "}"); } catch (...) {} std::cerr << error.what() << "; aclRestored=" << restoredGrants << "; cleanupConfirmed=" << cleaned << std::endl; std::wcerr << L"ownedProfile=" << moniker << std::endl; return 1; }
}
