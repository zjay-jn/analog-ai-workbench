#include <node_api.h>

#include <windows.h>
#include <bcrypt.h>

#include <algorithm>
#include <array>
#include <charconv>
#include <cmath>
#include <cstdint>
#include <cwctype>
#include <iomanip>
#include <iterator>
#include <limits>
#include <memory>
#include <set>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

namespace {

constexpr std::size_t kMaximumTextBytes = 2U * 1024U * 1024U;
constexpr std::size_t kMaximumPathCodeUnits = 32767U;
constexpr std::size_t kMaximumRelativeSegments = 24U;
constexpr std::size_t kMaximumSegmentCodeUnits = 255U;
constexpr std::size_t kSha256Bytes = 32U;

class ScopedHandle final {
 public:
  explicit ScopedHandle(HANDLE handle = INVALID_HANDLE_VALUE) noexcept
      : handle_(handle) {}
  ~ScopedHandle() { Reset(); }
  ScopedHandle(const ScopedHandle&) = delete;
  ScopedHandle& operator=(const ScopedHandle&) = delete;
  ScopedHandle(ScopedHandle&& other) noexcept : handle_(other.Release()) {}
  ScopedHandle& operator=(ScopedHandle&& other) noexcept {
    if (this != &other) Reset(other.Release());
    return *this;
  }
  [[nodiscard]] HANDLE Get() const noexcept { return handle_; }
  [[nodiscard]] bool IsValid() const noexcept {
    return handle_ != nullptr && handle_ != INVALID_HANDLE_VALUE;
  }
  HANDLE Release() noexcept {
    const HANDLE released = handle_;
    handle_ = INVALID_HANDLE_VALUE;
    return released;
  }
  void Reset(HANDLE replacement = INVALID_HANDLE_VALUE) noexcept {
    if (IsValid()) CloseHandle(handle_);
    handle_ = replacement;
  }

 private:
  HANDLE handle_;
};

struct NativeSnapshot final {
  ULONGLONG volume_serial_number{};
  FILE_ID_128 file_id{};
  DWORD file_attributes{};
  DWORD reparse_tag{};
  DWORD number_of_links{};
  LONGLONG file_size{};
  LONGLONG last_write_time{};
  bool is_directory{};
  std::string content_sha256;
  std::string dacl_sha256;
};

struct RootContext final {
  ScopedHandle handle;
  std::wstring final_path;
  NativeSnapshot snapshot;
  bool closed{false};
};

struct OpenedRelative final {
  std::vector<ScopedHandle> handles;
  NativeSnapshot final_snapshot;
};

void ThrowCode(napi_env env, const char* code, const char* message) {
  napi_value message_value{};
  napi_value error_value{};
  napi_value code_value{};
  if (napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &message_value) !=
          napi_ok ||
      napi_create_error(env, nullptr, message_value, &error_value) != napi_ok ||
      napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &code_value) !=
          napi_ok ||
      napi_set_named_property(env, error_value, "code", code_value) != napi_ok ||
      napi_throw(env, error_value) != napi_ok) {
    napi_throw_error(env, "INTERNAL", "The native filesystem boundary failed.");
  }
}

void ThrowSaveSystemError(napi_env env, DWORD error,
                          const char* fallback_code,
                          const char* fallback_message) {
  if (error == ERROR_DISK_FULL || error == ERROR_HANDLE_DISK_FULL ||
      error == ERROR_DISK_QUOTA_EXCEEDED) {
    ThrowCode(env, "SAVE_DISK_FULL",
              "The document could not be saved because storage is unavailable.");
    return;
  }
  if (error == ERROR_ACCESS_DENIED || error == ERROR_WRITE_PROTECT ||
      error == ERROR_PRIVILEGE_NOT_HELD) {
    ThrowCode(env, "SAVE_PERMISSION_DENIED",
              "The document could not be saved with current permissions.");
    return;
  }
  ThrowCode(env, fallback_code, fallback_message);
}

bool CheckStatus(napi_env env, napi_status status) {
  if (status == napi_ok) return true;
  ThrowCode(env, "INTERNAL", "The native filesystem boundary failed.");
  return false;
}

bool RequireObject(napi_env env, napi_value value) {
  napi_valuetype type{};
  if (!CheckStatus(env, napi_typeof(env, value, &type))) return false;
  if (type != napi_object || value == nullptr) {
    ThrowCode(env, "INVALID_ARGUMENT", "The native request is invalid.");
    return false;
  }
  return true;
}

bool GetUtf8String(napi_env env, napi_value value, std::string* output) {
  napi_valuetype type{};
  if (!CheckStatus(env, napi_typeof(env, value, &type))) return false;
  if (type != napi_string) {
    ThrowCode(env, "INVALID_ARGUMENT", "The native request is invalid.");
    return false;
  }
  std::size_t length = 0U;
  if (!CheckStatus(
          env,
          napi_get_value_string_utf8(env, value, nullptr, 0U, &length))) {
    return false;
  }
  std::vector<char> buffer(length + 1U, '\0');
  std::size_t written = 0U;
  if (!CheckStatus(env,
                   napi_get_value_string_utf8(env, value, buffer.data(),
                                              buffer.size(), &written))) {
    return false;
  }
  output->assign(buffer.data(), written);
  return true;
}

bool IsWellFormedUtf16(const std::wstring& value) {
  for (std::size_t index = 0U; index < value.size(); ++index) {
    const wchar_t current = value[index];
    if (current >= 0xD800 && current <= 0xDBFF) {
      if (index + 1U >= value.size()) return false;
      const wchar_t next = value[index + 1U];
      if (next < 0xDC00 || next > 0xDFFF) return false;
      ++index;
    } else if (current >= 0xDC00 && current <= 0xDFFF) {
      return false;
    }
  }
  return true;
}

bool GetWideString(napi_env env, napi_value value, std::wstring* output,
                   std::size_t maximum_code_units) {
  napi_valuetype type{};
  if (!CheckStatus(env, napi_typeof(env, value, &type))) return false;
  if (type != napi_string) {
    ThrowCode(env, "INVALID_ARGUMENT", "The native request is invalid.");
    return false;
  }
  std::size_t length = 0U;
  if (!CheckStatus(
          env,
          napi_get_value_string_utf16(env, value, nullptr, 0U, &length))) {
    return false;
  }
  if (length == 0U || length > maximum_code_units) {
    ThrowCode(env, "INVALID_PATH", "The requested path is unavailable.");
    return false;
  }
  std::vector<char16_t> buffer(length + 1U, u'\0');
  std::size_t written = 0U;
  if (!CheckStatus(env,
                   napi_get_value_string_utf16(env, value, buffer.data(),
                                               buffer.size(), &written))) {
    return false;
  }
  output->clear();
  output->reserve(written);
  for (std::size_t index = 0U; index < written; ++index) {
    output->push_back(static_cast<wchar_t>(buffer[index]));
  }
  if (!IsWellFormedUtf16(*output) ||
      std::any_of(output->begin(), output->end(), [](wchar_t character) {
        return character == L'\0' || character < 0x20 || character == 0x7F;
      })) {
    ThrowCode(env, "INVALID_PATH", "The requested path is unavailable.");
    return false;
  }
  return true;
}

bool RequireExactProperties(napi_env env, napi_value object,
                            const std::set<std::string>& allowed) {
  napi_value names{};
  if (!CheckStatus(env, napi_get_all_property_names(
                            env, object, napi_key_own_only,
                            napi_key_all_properties, napi_key_keep_numbers,
                            &names))) {
    return false;
  }
  uint32_t length = 0U;
  if (!CheckStatus(env, napi_get_array_length(env, names, &length))) {
    return false;
  }
  if (static_cast<std::size_t>(length) != allowed.size()) {
    ThrowCode(env, "INVALID_ARGUMENT", "The native request is invalid.");
    return false;
  }
  std::set<std::string> actual;
  for (uint32_t index = 0U; index < length; ++index) {
    napi_value name{};
    if (!CheckStatus(env, napi_get_element(env, names, index, &name))) {
      return false;
    }
    std::string property;
    if (!GetUtf8String(env, name, &property)) return false;
    if (allowed.find(property) == allowed.end()) {
      ThrowCode(env, "INVALID_ARGUMENT", "The native request is invalid.");
      return false;
    }
    actual.insert(property);
  }
  if (actual != allowed) {
    ThrowCode(env, "INVALID_ARGUMENT", "The native request is invalid.");
    return false;
  }
  return true;
}

bool GetNamedProperty(napi_env env, napi_value object, const char* name,
                      napi_value* output) {
  napi_value key{};
  if (!CheckStatus(
          env, napi_create_string_utf8(env, name, NAPI_AUTO_LENGTH, &key))) {
    return false;
  }
  bool has_property = false;
  if (!CheckStatus(
          env, napi_has_own_property(env, object, key, &has_property))) {
    return false;
  }
  if (!has_property) {
    ThrowCode(env, "INVALID_ARGUMENT", "The native request is invalid.");
    return false;
  }
  return CheckStatus(env, napi_get_named_property(env, object, name, output));
}

bool GetSingleArgument(napi_env env, napi_callback_info info,
                       napi_value* argument) {
  std::array<napi_value, 2U> arguments{};
  std::size_t argc = arguments.size();
  if (!CheckStatus(env, napi_get_cb_info(env, info, &argc, arguments.data(),
                                         nullptr, nullptr))) {
    return false;
  }
  if (argc != 1U || !RequireObject(env, arguments[0])) {
    if (argc != 1U) {
      ThrowCode(env, "INVALID_ARGUMENT", "The native request is invalid.");
    }
    return false;
  }
  *argument = arguments[0];
  return true;
}

bool SetNamedString(napi_env env, napi_value object, const char* name,
                    const std::string& value) {
  napi_value encoded{};
  return CheckStatus(
             env, napi_create_string_utf8(env, value.c_str(), value.size(),
                                          &encoded)) &&
         CheckStatus(env, napi_set_named_property(env, object, name, encoded));
}

bool SetNamedBoolean(napi_env env, napi_value object, const char* name,
                     bool value) {
  napi_value encoded{};
  return CheckStatus(env, napi_get_boolean(env, value, &encoded)) &&
         CheckStatus(env, napi_set_named_property(env, object, name, encoded));
}

bool SetNamedUint32(napi_env env, napi_value object, const char* name,
                    uint32_t value) {
  napi_value encoded{};
  return CheckStatus(env, napi_create_uint32(env, value, &encoded)) &&
         CheckStatus(env, napi_set_named_property(env, object, name, encoded));
}

bool GetBoolean(napi_env env, napi_value value, bool* output) {
  napi_valuetype type{};
  if (!CheckStatus(env, napi_typeof(env, value, &type))) return false;
  if (type != napi_boolean ||
      !CheckStatus(env, napi_get_value_bool(env, value, output))) {
    if (type != napi_boolean) {
      ThrowCode(env, "INVALID_ARGUMENT", "The native request is invalid.");
    }
    return false;
  }
  return true;
}

bool GetUint32(napi_env env, napi_value value, uint32_t* output) {
  napi_valuetype type{};
  if (!CheckStatus(env, napi_typeof(env, value, &type))) return false;
  if (type != napi_number) {
    ThrowCode(env, "INVALID_ARGUMENT", "The native request is invalid.");
    return false;
  }
  double number = 0.0;
  if (!CheckStatus(env, napi_get_value_double(env, value, &number))) {
    return false;
  }
  if (!std::isfinite(number) || number < 0.0 || std::floor(number) != number ||
      number > static_cast<double>(std::numeric_limits<uint32_t>::max())) {
    ThrowCode(env, "INVALID_ARGUMENT", "The native request is invalid.");
    return false;
  }
  *output = static_cast<uint32_t>(number);
  return true;
}

template <typename Integer>
bool ParseCanonicalDecimal(const std::string& value, Integer* output) {
  if (value.empty() || (value.size() > 1U && value.front() == '0') ||
      value.front() == '+' || value == "-0") {
    return false;
  }
  Integer parsed{};
  const auto result =
      std::from_chars(value.data(), value.data() + value.size(), parsed, 10);
  if (result.ec != std::errc{} || result.ptr != value.data() + value.size()) {
    return false;
  }
  *output = parsed;
  return true;
}

int HexDigit(char value) {
  if (value >= '0' && value <= '9') return value - '0';
  if (value >= 'a' && value <= 'f') return value - 'a' + 10;
  return -1;
}

bool ParseFileId(const std::string& value, FILE_ID_128* output) {
  if (value.size() != 32U) return false;
  for (std::size_t index = 0U; index < 16U; ++index) {
    const int high = HexDigit(value[index * 2U]);
    const int low = HexDigit(value[index * 2U + 1U]);
    if (high < 0 || low < 0) return false;
    output->Identifier[index] =
        static_cast<unsigned char>((high << 4U) | low);
  }
  return true;
}

bool IsLowercaseSha256(const std::string& value) {
  return value.size() == kSha256Bytes * 2U &&
         std::all_of(value.begin(), value.end(),
                     [](char character) { return HexDigit(character) >= 0; });
}

bool IsOperationId(const std::string& value) {
  return value.size() == 32U &&
         std::all_of(value.begin(), value.end(), [](char character) {
           return (character >= '0' && character <= '9') ||
                  (character >= 'a' && character <= 'f');
         });
}

std::wstring WidenAscii(const std::string& value) {
  return std::wstring(value.begin(), value.end());
}

bool HashBytes(const std::vector<unsigned char>& bytes, std::string* output) {
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  BCRYPT_HASH_HANDLE hash = nullptr;
  DWORD object_length = 0U;
  DWORD hash_length = 0U;
  DWORD actual = 0U;
  std::vector<unsigned char> hash_object;
  std::array<unsigned char, kSha256Bytes> digest{};
  bool success = false;
  if (!BCRYPT_SUCCESS(BCryptOpenAlgorithmProvider(
          &algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0U))) {
    goto cleanup;
  }
  if (!BCRYPT_SUCCESS(BCryptGetProperty(
          algorithm, BCRYPT_OBJECT_LENGTH,
          reinterpret_cast<PUCHAR>(&object_length), sizeof(object_length),
          &actual, 0U)) ||
      actual != sizeof(object_length) || object_length == 0U) {
    goto cleanup;
  }
  if (!BCRYPT_SUCCESS(BCryptGetProperty(
          algorithm, BCRYPT_HASH_LENGTH,
          reinterpret_cast<PUCHAR>(&hash_length), sizeof(hash_length), &actual,
          0U)) ||
      actual != sizeof(hash_length) || hash_length != digest.size()) {
    goto cleanup;
  }
  hash_object.resize(object_length);
  if (!BCRYPT_SUCCESS(BCryptCreateHash(
          algorithm, &hash, hash_object.data(),
          static_cast<ULONG>(hash_object.size()), nullptr, 0U, 0U))) {
    goto cleanup;
  }
  for (std::size_t offset = 0U; offset < bytes.size();) {
    const ULONG chunk = static_cast<ULONG>(std::min<std::size_t>(
        bytes.size() - offset,
        static_cast<std::size_t>(std::numeric_limits<ULONG>::max())));
    if (!BCRYPT_SUCCESS(
            BCryptHashData(hash, const_cast<PUCHAR>(bytes.data() + offset),
                           chunk, 0U))) {
      goto cleanup;
    }
    offset += chunk;
  }
  if (!BCRYPT_SUCCESS(BCryptFinishHash(hash, digest.data(),
                                       static_cast<ULONG>(digest.size()),
                                       0U))) {
    goto cleanup;
  }
  {
    std::ostringstream stream;
    stream << std::hex << std::setfill('0');
    for (const unsigned char byte : digest) {
      stream << std::setw(2) << static_cast<unsigned int>(byte);
    }
    *output = stream.str();
  }
  success = true;

cleanup:
  if (hash != nullptr) BCryptDestroyHash(hash);
  if (algorithm != nullptr) BCryptCloseAlgorithmProvider(algorithm, 0U);
  return success;
}

bool HashHandleDacl(HANDLE handle, std::string* output) {
  DWORD required = 0U;
  SetLastError(ERROR_SUCCESS);
  if (GetKernelObjectSecurity(handle, DACL_SECURITY_INFORMATION, nullptr, 0U,
                              &required) != FALSE ||
      GetLastError() != ERROR_INSUFFICIENT_BUFFER || required == 0U ||
      required > 64U * 1024U) {
    return false;
  }
  std::vector<unsigned char> descriptor(required, 0U);
  if (GetKernelObjectSecurity(
          handle, DACL_SECURITY_INFORMATION,
          reinterpret_cast<PSECURITY_DESCRIPTOR>(descriptor.data()),
          static_cast<DWORD>(descriptor.size()), &required) == FALSE ||
      required == 0U || required > descriptor.size()) {
    return false;
  }
  descriptor.resize(required);
  return HashBytes(descriptor, output);
}

std::string FileIdToHex(const FILE_ID_128& file_id) {
  std::ostringstream stream;
  stream << std::hex << std::setfill('0');
  for (const unsigned char byte : file_id.Identifier) {
    stream << std::setw(2) << static_cast<unsigned int>(byte);
  }
  return stream.str();
}

bool SnapshotHandle(HANDLE handle, NativeSnapshot* output) {
  if (GetFileType(handle) != FILE_TYPE_DISK) return false;
  FILE_ATTRIBUTE_TAG_INFO attribute_tag{};
  FILE_ID_INFO file_id{};
  FILE_STANDARD_INFO standard{};
  FILE_BASIC_INFO basic{};
  if (!GetFileInformationByHandleEx(handle, FileAttributeTagInfo,
                                    &attribute_tag,
                                    sizeof(attribute_tag)) ||
      !GetFileInformationByHandleEx(handle, FileIdInfo, &file_id,
                                    sizeof(file_id)) ||
      !GetFileInformationByHandleEx(handle, FileStandardInfo, &standard,
                                    sizeof(standard)) ||
      !GetFileInformationByHandleEx(handle, FileBasicInfo, &basic,
                                    sizeof(basic))) {
    return false;
  }
  output->volume_serial_number = file_id.VolumeSerialNumber;
  output->file_id = file_id.FileId;
  output->file_attributes = attribute_tag.FileAttributes;
  output->reparse_tag = attribute_tag.ReparseTag;
  output->number_of_links = standard.NumberOfLinks;
  output->file_size = standard.EndOfFile.QuadPart;
  output->last_write_time = basic.LastWriteTime.QuadPart;
  output->is_directory = standard.Directory != FALSE;
  return true;
}

bool SameFileId(const NativeSnapshot& left, const NativeSnapshot& right) {
  return left.volume_serial_number == right.volume_serial_number &&
         std::equal(std::begin(left.file_id.Identifier),
                    std::end(left.file_id.Identifier),
                    std::begin(right.file_id.Identifier));
}

bool SameSnapshot(const NativeSnapshot& left, const NativeSnapshot& right) {
  return SameFileId(left, right) &&
         left.file_attributes == right.file_attributes &&
         left.reparse_tag == right.reparse_tag &&
         left.number_of_links == right.number_of_links &&
         left.file_size == right.file_size &&
         left.last_write_time == right.last_write_time &&
         left.is_directory == right.is_directory;
}

bool SameContentSnapshot(const NativeSnapshot& left,
                         const NativeSnapshot& right) {
  return SameSnapshot(left, right) && !left.content_sha256.empty() &&
         left.content_sha256 == right.content_sha256;
}

bool SameDacl(const NativeSnapshot& left, const NativeSnapshot& right) {
  return !left.dacl_sha256.empty() &&
         left.dacl_sha256 == right.dacl_sha256;
}

std::wstring TrimTrailingSeparators(std::wstring value) {
  while (value.size() > 3U &&
         (value.back() == L'\\' || value.back() == L'/')) {
    value.pop_back();
  }
  return value;
}

bool EqualPathOrdinalIgnoreCase(const std::wstring& left,
                                const std::wstring& right) {
  const std::wstring normalized_left = TrimTrailingSeparators(left);
  const std::wstring normalized_right = TrimTrailingSeparators(right);
  if (normalized_left.size() > static_cast<std::size_t>(INT_MAX) ||
      normalized_right.size() > static_cast<std::size_t>(INT_MAX)) {
    return false;
  }
  return CompareStringOrdinal(
             normalized_left.c_str(), static_cast<int>(normalized_left.size()),
             normalized_right.c_str(),
             static_cast<int>(normalized_right.size()), TRUE) == CSTR_EQUAL;
}

bool GetFinalPath(HANDLE handle, std::wstring* output) {
  const DWORD flags = FILE_NAME_NORMALIZED | VOLUME_NAME_DOS;
  const DWORD required = GetFinalPathNameByHandleW(handle, nullptr, 0U, flags);
  if (required == 0U || required > kMaximumPathCodeUnits) return false;
  std::vector<wchar_t> buffer(static_cast<std::size_t>(required) + 1U, L'\0');
  const DWORD written = GetFinalPathNameByHandleW(
      handle, buffer.data(), static_cast<DWORD>(buffer.size()), flags);
  if (written == 0U || static_cast<std::size_t>(written) >= buffer.size()) {
    return false;
  }
  output->assign(buffer.data(), written);
  return true;
}

bool IsAbsoluteDosPath(const std::wstring& path) {
  const bool normal =
      path.size() >= 3U && std::iswalpha(path[0]) != 0 && path[1] == L':' &&
      (path[2] == L'\\' || path[2] == L'/');
  const bool extended =
      path.size() >= 7U && path.rfind(L"\\\\?\\", 0U) == 0U &&
      std::iswalpha(path[4]) != 0 && path[5] == L':' && path[6] == L'\\';
  return normal || extended;
}

bool GetFullPath(const std::wstring& input, std::wstring* output) {
  const DWORD required = GetFullPathNameW(input.c_str(), 0U, nullptr, nullptr);
  if (required == 0U || required > kMaximumPathCodeUnits) return false;
  std::vector<wchar_t> buffer(static_cast<std::size_t>(required) + 1U, L'\0');
  const DWORD written = GetFullPathNameW(
      input.c_str(), static_cast<DWORD>(buffer.size()), buffer.data(), nullptr);
  if (written == 0U || static_cast<std::size_t>(written) >= buffer.size()) {
    return false;
  }
  output->assign(buffer.data(), written);
  return IsAbsoluteDosPath(*output);
}

bool IsFixedDriveType(UINT drive_type) { return drive_type == DRIVE_FIXED; }

bool IsReservedDeviceName(const std::wstring& segment) {
  const std::size_t dot = segment.find(L'.');
  std::wstring base = segment.substr(0U, dot);
  std::transform(base.begin(), base.end(), base.begin(),
                 [](wchar_t character) {
                   return static_cast<wchar_t>(std::towupper(character));
                 });
  if (base == L"CON" || base == L"PRN" || base == L"AUX" ||
      base == L"NUL") {
    return true;
  }
  return base.size() == 4U &&
         (base.rfind(L"COM", 0U) == 0U ||
          base.rfind(L"LPT", 0U) == 0U) &&
         base[3] >= L'1' && base[3] <= L'9';
}

bool IsValidSegment(const std::wstring& segment) {
  if (segment.empty() || segment.size() > kMaximumSegmentCodeUnits ||
      segment == L"." || segment == L".." || !IsWellFormedUtf16(segment) ||
      segment.back() == L'.' || segment.back() == L' ' ||
      IsReservedDeviceName(segment)) {
    return false;
  }
  return std::none_of(segment.begin(), segment.end(), [](wchar_t character) {
    return character == L'\\' || character == L'/' || character == L':' ||
           character == L'\0' || character < 0x20 || character == 0x7F;
  });
}

bool ReadRelativeSegments(napi_env env, napi_value value,
                          std::vector<std::wstring>* output) {
  bool is_array = false;
  if (!CheckStatus(env, napi_is_array(env, value, &is_array))) return false;
  if (!is_array) {
    ThrowCode(env, "INVALID_ARGUMENT", "The native request is invalid.");
    return false;
  }
  uint32_t length = 0U;
  if (!CheckStatus(env, napi_get_array_length(env, value, &length))) {
    return false;
  }
  if (length == 0U || length > kMaximumRelativeSegments) {
    ThrowCode(env, "INVALID_PATH", "The requested path is unavailable.");
    return false;
  }
  output->clear();
  output->reserve(length);
  std::size_t total = 0U;
  for (uint32_t index = 0U; index < length; ++index) {
    bool present = false;
    if (!CheckStatus(env, napi_has_element(env, value, index, &present))) {
      return false;
    }
    if (!present) {
      ThrowCode(env, "INVALID_ARGUMENT", "The native request is invalid.");
      return false;
    }
    napi_value item{};
    if (!CheckStatus(env, napi_get_element(env, value, index, &item))) {
      return false;
    }
    std::wstring segment;
    if (!GetWideString(env, item, &segment, kMaximumSegmentCodeUnits)) {
      return false;
    }
    if (!IsValidSegment(segment)) {
      ThrowCode(env, "INVALID_PATH", "The requested path is unavailable.");
      return false;
    }
    total += segment.size() + 1U;
    if (total > 1024U) {
      ThrowCode(env, "INVALID_PATH", "The requested path is unavailable.");
      return false;
    }
    output->push_back(std::move(segment));
  }
  return true;
}

napi_value SnapshotToValue(napi_env env, const NativeSnapshot& snapshot) {
  napi_value value{};
  if (!CheckStatus(env, napi_create_object(env, &value)) ||
      !SetNamedString(env, value, "volumeSerialNumber",
                      std::to_string(snapshot.volume_serial_number)) ||
      !SetNamedString(env, value, "fileId", FileIdToHex(snapshot.file_id)) ||
      !SetNamedUint32(env, value, "fileAttributes",
                      snapshot.file_attributes) ||
      !SetNamedUint32(env, value, "reparseTag", snapshot.reparse_tag) ||
      !SetNamedString(env, value, "numberOfLinks",
                      std::to_string(snapshot.number_of_links)) ||
      !SetNamedString(env, value, "fileSize",
                      std::to_string(snapshot.file_size)) ||
      !SetNamedString(env, value, "lastWriteTime",
                      std::to_string(snapshot.last_write_time)) ||
      !SetNamedBoolean(env, value, "isDirectory", snapshot.is_directory) ||
      !SetNamedString(env, value, "contentSha256", snapshot.content_sha256)) {
    return nullptr;
  }
  return value;
}

bool ParseSnapshot(napi_env env, napi_value value, NativeSnapshot* output) {
  if (!RequireObject(env, value) ||
      !RequireExactProperties(
          env, value,
          {"contentSha256", "fileAttributes", "fileId", "fileSize",
           "isDirectory", "lastWriteTime", "numberOfLinks", "reparseTag",
           "volumeSerialNumber"})) {
    return false;
  }
  napi_value volume_value{};
  napi_value file_id_value{};
  napi_value attributes_value{};
  napi_value tag_value{};
  napi_value links_value{};
  napi_value size_value{};
  napi_value time_value{};
  napi_value directory_value{};
  napi_value hash_value{};
  std::string volume;
  std::string file_id;
  std::string links;
  std::string size;
  std::string time;
  std::string hash;
  ULONGLONG parsed_links = 0U;
  uint32_t parsed_attributes = 0U;
  uint32_t parsed_tag = 0U;
  if (!GetNamedProperty(env, value, "volumeSerialNumber", &volume_value) ||
      !GetNamedProperty(env, value, "fileId", &file_id_value) ||
      !GetNamedProperty(env, value, "fileAttributes", &attributes_value) ||
      !GetNamedProperty(env, value, "reparseTag", &tag_value) ||
      !GetNamedProperty(env, value, "numberOfLinks", &links_value) ||
      !GetNamedProperty(env, value, "fileSize", &size_value) ||
      !GetNamedProperty(env, value, "lastWriteTime", &time_value) ||
      !GetNamedProperty(env, value, "isDirectory", &directory_value) ||
      !GetNamedProperty(env, value, "contentSha256", &hash_value) ||
      !GetUtf8String(env, volume_value, &volume) ||
      !GetUtf8String(env, file_id_value, &file_id) ||
      !GetUint32(env, attributes_value, &parsed_attributes) ||
      !GetUint32(env, tag_value, &parsed_tag) ||
      !GetUtf8String(env, links_value, &links) ||
      !GetUtf8String(env, size_value, &size) ||
      !GetUtf8String(env, time_value, &time) ||
      !GetBoolean(env, directory_value, &output->is_directory) ||
      !GetUtf8String(env, hash_value, &hash)) {
    return false;
  }
  if (!ParseCanonicalDecimal(volume, &output->volume_serial_number) ||
      !ParseFileId(file_id, &output->file_id) ||
      !ParseCanonicalDecimal(links, &parsed_links) ||
      parsed_links > std::numeric_limits<DWORD>::max() ||
      !ParseCanonicalDecimal(size, &output->file_size) ||
      output->file_size < 0 ||
      !ParseCanonicalDecimal(time, &output->last_write_time) ||
      output->last_write_time < 0 || !IsLowercaseSha256(hash)) {
    ThrowCode(env, "INVALID_ARGUMENT", "The native request is invalid.");
    return false;
  }
  output->number_of_links = static_cast<DWORD>(parsed_links);
  output->file_attributes = static_cast<DWORD>(parsed_attributes);
  output->reparse_tag = static_cast<DWORD>(parsed_tag);
  output->content_sha256 = std::move(hash);
  return true;
}

bool RejectReparse(napi_env env, const NativeSnapshot& snapshot) {
  if ((snapshot.file_attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0U ||
      snapshot.reparse_tag != 0U) {
    ThrowCode(env, "REPARSE_POINT", "The requested path is unavailable.");
    return false;
  }
  return true;
}

bool OpenRelative(napi_env env, RootContext* root,
                  const std::vector<std::wstring>& segments,
                  bool require_directory, bool for_read,
                  OpenedRelative* output) {
  if (root == nullptr || root->closed || !root->handle.IsValid()) {
    ThrowCode(env, "CAPABILITY_UNAVAILABLE",
              "The native root capability is unavailable.");
    return false;
  }
  NativeSnapshot current_root{};
  std::wstring current_root_path;
  if (!SnapshotHandle(root->handle.Get(), &current_root) ||
      !GetFinalPath(root->handle.Get(), &current_root_path) ||
      !SameFileId(current_root, root->snapshot) ||
      !EqualPathOrdinalIgnoreCase(current_root_path, root->final_path)) {
    ThrowCode(env, "DOCUMENT_CONFLICT",
              "The requested path changed during validation.");
    return false;
  }
  if (!RejectReparse(env, current_root)) return false;

  output->handles.clear();
  output->handles.reserve(segments.size());
  std::wstring candidate = root->final_path;
  for (std::size_t index = 0U; index < segments.size(); ++index) {
    candidate.push_back(L'\\');
    candidate.append(segments[index]);
    const bool is_final = index + 1U == segments.size();
    const DWORD desired_access =
        FILE_READ_ATTRIBUTES | SYNCHRONIZE |
        ((is_final && for_read) ? (GENERIC_READ | READ_CONTROL) : 0U);
    const DWORD share_mode =
        is_final && for_read ? FILE_SHARE_READ
                             : (FILE_SHARE_READ | FILE_SHARE_WRITE);
    ScopedHandle handle(CreateFileW(
        candidate.c_str(), desired_access, share_mode, nullptr, OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    if (!handle.IsValid()) {
      ThrowCode(env, "PATH_UNAVAILABLE", "The requested path is unavailable.");
      return false;
    }
    NativeSnapshot snapshot{};
    std::wstring final_path;
    if (!SnapshotHandle(handle.Get(), &snapshot) ||
        !GetFinalPath(handle.Get(), &final_path)) {
      ThrowCode(env, "IO_FAILED", "The requested file could not be read.");
      return false;
    }
    if (!RejectReparse(env, snapshot)) return false;
    if (snapshot.volume_serial_number != root->snapshot.volume_serial_number ||
        !EqualPathOrdinalIgnoreCase(final_path, candidate)) {
      ThrowCode(env, "PATH_ESCAPE", "The requested path is unavailable.");
      return false;
    }
    if (!is_final && !snapshot.is_directory) {
      ThrowCode(env, "NOT_REGULAR_FILE",
                "The requested file is unavailable.");
      return false;
    }
    if (is_final) {
      if (require_directory != snapshot.is_directory) {
        ThrowCode(env, "NOT_REGULAR_FILE",
                  "The requested file is unavailable.");
        return false;
      }
      if (!snapshot.is_directory && snapshot.number_of_links != 1U) {
        ThrowCode(env, "HARD_LINK", "The requested file is unavailable.");
        return false;
      }
      output->final_snapshot = snapshot;
    }
    output->handles.push_back(std::move(handle));
  }
  return true;
}

bool ReadAllHandle(HANDLE handle, std::size_t maximum,
                   std::vector<unsigned char>* output) {
  NativeSnapshot before{};
  if (!SnapshotHandle(handle, &before) || before.file_size < 0 ||
      static_cast<ULONGLONG>(before.file_size) > maximum) {
    return false;
  }
  LARGE_INTEGER beginning{};
  if (!SetFilePointerEx(handle, beginning, nullptr, FILE_BEGIN)) return false;
  output->assign(static_cast<std::size_t>(before.file_size), 0U);
  std::size_t offset = 0U;
  while (offset < output->size()) {
    const DWORD requested = static_cast<DWORD>(std::min<std::size_t>(
        output->size() - offset,
        static_cast<std::size_t>(std::numeric_limits<DWORD>::max())));
    DWORD actual = 0U;
    if (!ReadFile(handle, output->data() + offset, requested, &actual,
                  nullptr) ||
        actual == 0U) {
      return false;
    }
    offset += actual;
  }
  NativeSnapshot after{};
  return SnapshotHandle(handle, &after) && SameSnapshot(before, after);
}

bool OpenContentSnapshot(napi_env env, RootContext* root,
                         const std::vector<std::wstring>& segments,
                         OpenedRelative* opened,
                         std::vector<unsigned char>* bytes) {
  if (!OpenRelative(env, root, segments, false, true, opened)) return false;
  if (opened->final_snapshot.file_size < 0 ||
      static_cast<ULONGLONG>(opened->final_snapshot.file_size) >
          kMaximumTextBytes) {
    ThrowCode(env, "DOCUMENT_TOO_LARGE", "The document is too large.");
    return false;
  }
  if (!ReadAllHandle(opened->handles.back().Get(), kMaximumTextBytes, bytes)) {
    ThrowCode(env, "IO_FAILED", "The requested file could not be read.");
    return false;
  }
  NativeSnapshot after{};
  if (!SnapshotHandle(opened->handles.back().Get(), &after) ||
      !SameSnapshot(opened->final_snapshot, after) ||
      !HashBytes(*bytes, &after.content_sha256) ||
      !HashHandleDacl(opened->handles.back().Get(), &after.dacl_sha256)) {
    ThrowCode(env, "DOCUMENT_CONFLICT",
              "The requested path changed during validation.");
    return false;
  }
  opened->final_snapshot = std::move(after);
  return true;
}

bool GetBufferCopy(napi_env env, napi_value value,
                   std::vector<unsigned char>* output) {
  bool is_buffer = false;
  if (!CheckStatus(env, napi_is_buffer(env, value, &is_buffer))) return false;
  if (!is_buffer) {
    ThrowCode(env, "INVALID_ARGUMENT", "The native request is invalid.");
    return false;
  }
  void* data = nullptr;
  std::size_t length = 0U;
  if (!CheckStatus(env, napi_get_buffer_info(env, value, &data, &length))) {
    return false;
  }
  if (length > kMaximumTextBytes || (length > 0U && data == nullptr)) {
    ThrowCode(env, "DOCUMENT_TOO_LARGE", "The document is too large.");
    return false;
  }
  const auto* begin = static_cast<const unsigned char*>(data);
  if (length == 0U) {
    output->clear();
  } else {
    output->assign(begin, begin + length);
  }
  return true;
}

bool WriteAllHandle(HANDLE handle, const std::vector<unsigned char>& bytes) {
  std::size_t offset = 0U;
  while (offset < bytes.size()) {
    const DWORD requested = static_cast<DWORD>(std::min<std::size_t>(
        bytes.size() - offset,
        static_cast<std::size_t>(std::numeric_limits<DWORD>::max())));
    DWORD actual = 0U;
    if (!WriteFile(handle, bytes.data() + offset, requested, &actual, nullptr) ||
        actual == 0U) {
      return false;
    }
    offset += actual;
  }
  return true;
}

std::wstring AbsoluteFromSegments(
    const RootContext& root, const std::vector<std::wstring>& segments) {
  std::wstring value = root.final_path;
  for (const std::wstring& segment : segments) {
    value.push_back(L'\\');
    value.append(segment);
  }
  return value;
}

bool MakeOperationSiblingPath(const RootContext& root,
                              const std::vector<std::wstring>& target_segments,
                              const wchar_t* role,
                              const std::string& operation_id,
                              std::wstring* path) {
  if (target_segments.empty()) return false;
  std::vector<std::wstring> sibling_segments(target_segments.begin(),
                                              target_segments.end() - 1);
  std::wstring segment = L".aaw-";
  segment.append(role);
  segment.push_back(L'-');
  segment.append(WidenAscii(operation_id));
  sibling_segments.push_back(std::move(segment));
  *path = AbsoluteFromSegments(root, sibling_segments);
  return path->size() <= kMaximumPathCodeUnits;
}

bool PathDoesNotExist(const std::wstring& path) {
  SetLastError(ERROR_SUCCESS);
  const DWORD attributes = GetFileAttributesW(path.c_str());
  const DWORD error = GetLastError();
  return attributes == INVALID_FILE_ATTRIBUTES &&
         (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND);
}

class ScopedDeletePath final {
 public:
  ScopedDeletePath() = default;
  explicit ScopedDeletePath(std::wstring path) : path_(std::move(path)) {}
  ~ScopedDeletePath() {
    if (active_ && !path_.empty()) DeleteFileW(path_.c_str());
  }
  ScopedDeletePath(const ScopedDeletePath&) = delete;
  ScopedDeletePath& operator=(const ScopedDeletePath&) = delete;
  void Reset(std::wstring path) {
    path_ = std::move(path);
    active_ = true;
  }
  void Release() noexcept { active_ = false; }
  [[nodiscard]] const std::wstring& Path() const noexcept { return path_; }

 private:
  std::wstring path_;
  bool active_{true};
};

bool CreateOperationTemp(const RootContext& root,
                         const std::vector<std::wstring>& target_segments,
                         const std::string& operation_id, std::wstring* path,
                         ScopedHandle* handle) {
  if (!MakeOperationSiblingPath(root, target_segments, L"temp", operation_id,
                                path)) {
    SetLastError(ERROR_INVALID_NAME);
    return false;
  }
  handle->Reset(CreateFileW(
      path->c_str(), GENERIC_READ | GENERIC_WRITE | DELETE | READ_CONTROL |
                             WRITE_DAC,
      0U, nullptr, CREATE_NEW,
      FILE_ATTRIBUTE_TEMPORARY | FILE_ATTRIBUTE_NOT_CONTENT_INDEXED, nullptr));
  return handle->IsValid();
}

bool ReadAbsoluteFile(const std::wstring& path,
                      const NativeSnapshot& root_snapshot,
                      std::vector<unsigned char>* bytes,
                      NativeSnapshot* snapshot) {
  ScopedHandle handle(CreateFileW(
      path.c_str(), GENERIC_READ | FILE_READ_ATTRIBUTES | SYNCHRONIZE |
                        READ_CONTROL,
      FILE_SHARE_READ, nullptr, OPEN_EXISTING,
      FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  std::wstring final_path;
  if (!handle.IsValid() || !SnapshotHandle(handle.Get(), snapshot) ||
      !GetFinalPath(handle.Get(), &final_path) ||
      !EqualPathOrdinalIgnoreCase(final_path, path) ||
      snapshot->volume_serial_number != root_snapshot.volume_serial_number ||
      snapshot->is_directory || snapshot->reparse_tag != 0U ||
      (snapshot->file_attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0U ||
      snapshot->number_of_links != 1U ||
      !ReadAllHandle(handle.Get(), kMaximumTextBytes, bytes) ||
      !HashBytes(*bytes, &snapshot->content_sha256) ||
      !HashHandleDacl(handle.Get(), &snapshot->dacl_sha256)) {
    return false;
  }
  return true;
}

bool VerifyAbsoluteFile(const std::wstring& path,
                        const NativeSnapshot& root_snapshot,
                        const std::vector<unsigned char>& expected_bytes,
                        const NativeSnapshot* expected_identity,
                        const NativeSnapshot* expected_security,
                        NativeSnapshot* snapshot) {
  std::vector<unsigned char> actual;
  if (!ReadAbsoluteFile(path, root_snapshot, &actual, snapshot) ||
      actual != expected_bytes) {
    return false;
  }
  return (expected_identity == nullptr ||
          SameFileId(*snapshot, *expected_identity)) &&
         (expected_security == nullptr ||
          SameDacl(*snapshot, *expected_security));
}

void RootFinalize(napi_env, void* data, void*) {
  delete static_cast<RootContext*>(data);
}

bool UnwrapRoot(napi_env env, napi_value request, RootContext** root) {
  napi_value value{};
  if (!GetNamedProperty(env, request, "root", &value) ||
      !RequireObject(env, value)) {
    return false;
  }
  void* data = nullptr;
  if (!CheckStatus(env, napi_unwrap(env, value, &data)) || data == nullptr) {
    ThrowCode(env, "CAPABILITY_UNAVAILABLE",
              "The native root capability is unavailable.");
    return false;
  }
  *root = static_cast<RootContext*>(data);
  if ((*root)->closed || !(*root)->handle.IsValid()) {
    ThrowCode(env, "CAPABILITY_UNAVAILABLE",
              "The native root capability is unavailable.");
    return false;
  }
  return true;
}

napi_value GetCapabilities(napi_env env, napi_callback_info info) {
  try {
    std::array<napi_value, 1U> arguments{};
    std::size_t argc = arguments.size();
    if (!CheckStatus(env, napi_get_cb_info(env, info, &argc, arguments.data(),
                                           nullptr, nullptr))) {
      return nullptr;
    }
    if (argc != 0U) {
      ThrowCode(env, "INVALID_ARGUMENT", "The native request is invalid.");
      return nullptr;
    }
    napi_value result{};
    napi_value capabilities{};
    if (!CheckStatus(env, napi_create_object(env, &result)) ||
        !SetNamedString(env, result, "contractVersion",
                        "aaw.windows-fs-native/v1alpha1") ||
        !SetNamedUint32(env, result, "napiVersion", NAPI_VERSION) ||
        !SetNamedString(env, result, "platform", "win32-x64") ||
        !CheckStatus(env, napi_create_object(env, &capabilities)) ||
        !SetNamedBoolean(env, capabilities, "fixedDrive", true) ||
        !SetNamedBoolean(env, capabilities, "fileId", true) ||
        !SetNamedBoolean(env, capabilities, "reparseTag", true) ||
        !SetNamedBoolean(env, capabilities, "openReparsePoint", true) ||
        !SetNamedBoolean(env, capabilities, "verifiedRead", true) ||
        !SetNamedBoolean(env, capabilities, "daclVerification", true) ||
        !SetNamedBoolean(env, capabilities, "atomicReplace", true) ||
        !CheckStatus(env, napi_set_named_property(env, result, "capabilities",
                                                 capabilities))) {
      return nullptr;
    }
    return result;
  } catch (...) {
    ThrowCode(env, "INTERNAL", "The native filesystem boundary failed.");
    return nullptr;
  }
}

napi_value OpenValidatedRoot(napi_env env, napi_callback_info info) {
  try {
    napi_value request{};
    if (!GetSingleArgument(env, info, &request) ||
        !RequireExactProperties(env, request, {"absolutePath"})) {
      return nullptr;
    }
    napi_value path_value{};
    if (!GetNamedProperty(env, request, "absolutePath", &path_value)) {
      return nullptr;
    }
    std::wstring requested_path;
    if (!GetWideString(env, path_value, &requested_path,
                       kMaximumPathCodeUnits)) {
      return nullptr;
    }
    std::wstring full_path;
    if (!GetFullPath(requested_path, &full_path) ||
        !IsAbsoluteDosPath(full_path)) {
      ThrowCode(env, "INVALID_PATH", "The requested path is unavailable.");
      return nullptr;
    }
    if (full_path.rfind(L"\\\\", 0U) == 0U &&
        full_path.rfind(L"\\\\?\\", 0U) != 0U) {
      ThrowCode(env, "NOT_FIXED_DRIVE",
                "The requested root is unavailable.");
      return nullptr;
    }
    std::vector<wchar_t> volume_path(kMaximumPathCodeUnits + 1U, L'\0');
    if (!GetVolumePathNameW(full_path.c_str(), volume_path.data(),
                            static_cast<DWORD>(volume_path.size())) ||
        !IsFixedDriveType(GetDriveTypeW(volume_path.data())) ||
        EqualPathOrdinalIgnoreCase(full_path, volume_path.data())) {
      ThrowCode(env, "NOT_FIXED_DRIVE",
                "The requested root is unavailable.");
      return nullptr;
    }
    auto root = std::make_unique<RootContext>();
    root->handle.Reset(CreateFileW(
        full_path.c_str(), FILE_READ_ATTRIBUTES | SYNCHRONIZE,
        FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    if (!root->handle.IsValid()) {
      ThrowCode(env, "PATH_UNAVAILABLE", "The requested root is unavailable.");
      return nullptr;
    }
    if (!SnapshotHandle(root->handle.Get(), &root->snapshot) ||
        !GetFinalPath(root->handle.Get(), &root->final_path)) {
      ThrowCode(env, "IO_FAILED", "The requested root is unavailable.");
      return nullptr;
    }
    if (!RejectReparse(env, root->snapshot)) return nullptr;
    if (!root->snapshot.is_directory) {
      ThrowCode(env, "NOT_REGULAR_FILE", "The requested root is unavailable.");
      return nullptr;
    }
    napi_value result{};
    if (!CheckStatus(env, napi_create_object(env, &result)) ||
        !CheckStatus(env, napi_wrap(env, result, root.get(), RootFinalize,
                                    nullptr, nullptr))) {
      return nullptr;
    }
    root.release();
    return result;
  } catch (...) {
    ThrowCode(env, "INTERNAL", "The native filesystem boundary failed.");
    return nullptr;
  }
}

napi_value InspectRelative(napi_env env, napi_callback_info info) {
  try {
    napi_value request{};
    if (!GetSingleArgument(env, info, &request) ||
        !RequireExactProperties(
            env, request, {"expectedKind", "relativeSegments", "root"})) {
      return nullptr;
    }
    RootContext* root = nullptr;
    napi_value segments_value{};
    napi_value kind_value{};
    std::vector<std::wstring> segments;
    std::string kind;
    if (!UnwrapRoot(env, request, &root) ||
        !GetNamedProperty(env, request, "relativeSegments", &segments_value) ||
        !ReadRelativeSegments(env, segments_value, &segments) ||
        !GetNamedProperty(env, request, "expectedKind", &kind_value) ||
        !GetUtf8String(env, kind_value, &kind)) {
      return nullptr;
    }
    if (kind != "file" && kind != "directory") {
      ThrowCode(env, "INVALID_ARGUMENT", "The native request is invalid.");
      return nullptr;
    }
    OpenedRelative opened;
    if (!OpenRelative(env, root, segments, kind == "directory", false,
                      &opened)) {
      return nullptr;
    }
    return SnapshotToValue(env, opened.final_snapshot);
  } catch (...) {
    ThrowCode(env, "INTERNAL", "The native filesystem boundary failed.");
    return nullptr;
  }
}

napi_value ReadVerifiedText(napi_env env, napi_callback_info info) {
  try {
    napi_value request{};
    if (!GetSingleArgument(env, info, &request) ||
        !RequireExactProperties(
            env, request, {"maxBytes", "relativeSegments", "root"})) {
      return nullptr;
    }
    RootContext* root = nullptr;
    napi_value segments_value{};
    napi_value maximum_value{};
    std::vector<std::wstring> segments;
    if (!UnwrapRoot(env, request, &root) ||
        !GetNamedProperty(env, request, "relativeSegments", &segments_value) ||
        !ReadRelativeSegments(env, segments_value, &segments) ||
        !GetNamedProperty(env, request, "maxBytes", &maximum_value)) {
      return nullptr;
    }
    napi_valuetype maximum_type{};
    double maximum_double = 0.0;
    if (!CheckStatus(env, napi_typeof(env, maximum_value, &maximum_type))) {
      return nullptr;
    }
    if (maximum_type != napi_number) {
      ThrowCode(env, "INVALID_ARGUMENT", "The native request is invalid.");
      return nullptr;
    }
    if (!CheckStatus(
            env,
            napi_get_value_double(env, maximum_value, &maximum_double))) {
      return nullptr;
    }
    if (!std::isfinite(maximum_double) || maximum_double < 0.0 ||
        std::floor(maximum_double) != maximum_double ||
        maximum_double > static_cast<double>(kMaximumTextBytes)) {
      ThrowCode(env, "INVALID_ARGUMENT", "The native request is invalid.");
      return nullptr;
    }
    const std::size_t maximum = static_cast<std::size_t>(maximum_double);
    OpenedRelative opened;
    std::vector<unsigned char> bytes;
    if (!OpenContentSnapshot(env, root, segments, &opened, &bytes)) {
      return nullptr;
    }
    if (bytes.size() > maximum) {
      ThrowCode(env, "DOCUMENT_TOO_LARGE", "The document is too large.");
      return nullptr;
    }
    napi_value result{};
    napi_value buffer{};
    napi_value snapshot = SnapshotToValue(env, opened.final_snapshot);
    const unsigned char empty_byte = 0U;
    if (snapshot == nullptr ||
        !CheckStatus(env, napi_create_object(env, &result)) ||
        !CheckStatus(env, napi_create_buffer_copy(
                              env, bytes.size(),
                              bytes.empty() ? &empty_byte : bytes.data(),
                              nullptr, &buffer)) ||
        !CheckStatus(
            env, napi_set_named_property(env, result, "bytes", buffer)) ||
        !CheckStatus(
            env, napi_set_named_property(env, result, "snapshot", snapshot))) {
      return nullptr;
    }
    return result;
  } catch (...) {
    ThrowCode(env, "INTERNAL", "The native filesystem boundary failed.");
    return nullptr;
  }
}

bool RestoreBackupAfterReplace(
    RootContext* root, const std::wstring& target_path,
    const std::wstring& backup_path, const std::wstring& rollback_path,
    const std::vector<unsigned char>& backup_bytes,
    const NativeSnapshot& backup_snapshot, bool target_exists) {
  if (target_exists) {
    if (!ReplaceFileW(target_path.c_str(), backup_path.c_str(),
                      rollback_path.c_str(), 0U, nullptr, nullptr)) {
      return false;
    }
  } else if (!MoveFileExW(backup_path.c_str(), target_path.c_str(),
                          MOVEFILE_WRITE_THROUGH)) {
    return false;
  }
  NativeSnapshot restored{};
  if (!VerifyAbsoluteFile(target_path, root->snapshot, backup_bytes,
                          &backup_snapshot, &backup_snapshot, &restored) ||
      !SameContentSnapshot(restored, backup_snapshot)) {
    return false;
  }
  if (target_exists && !DeleteFileW(rollback_path.c_str())) return false;
  return true;
}

#ifdef AAW_NATIVE_TEST_BUILD
bool OverwriteForTest(const std::wstring& target_path,
                      const std::vector<unsigned char>& bytes) {
  ScopedHandle handle(CreateFileW(target_path.c_str(), GENERIC_WRITE, 0U,
                                  nullptr, OPEN_EXISTING,
                                  FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (!handle.IsValid()) return false;
  LARGE_INTEGER beginning{};
  return SetFilePointerEx(handle.Get(), beginning, nullptr, FILE_BEGIN) &&
         WriteAllHandle(handle.Get(), bytes) && SetEndOfFile(handle.Get()) &&
         FlushFileBuffers(handle.Get());
}

[[noreturn]] void CrashProcessForTest() {
  TerminateProcess(GetCurrentProcess(), 73U);
  ExitProcess(73U);
}
#endif

napi_value ReplaceVerifiedTextCore(napi_env env, napi_value request,
                                   const std::string& fault_point) {
#ifndef AAW_NATIVE_TEST_BUILD
  (void)fault_point;
#endif
  RootContext* root = nullptr;
  napi_value segments_value{};
  napi_value expected_value{};
  napi_value bytes_value{};
  napi_value operation_value{};
  std::vector<std::wstring> segments;
  NativeSnapshot expected{};
  std::vector<unsigned char> replacement_bytes;
  std::string operation_id;
  if (!UnwrapRoot(env, request, &root) ||
      !GetNamedProperty(env, request, "relativeSegments", &segments_value) ||
      !ReadRelativeSegments(env, segments_value, &segments) ||
      !GetNamedProperty(env, request, "expectedSnapshot", &expected_value) ||
      !ParseSnapshot(env, expected_value, &expected) ||
      !GetNamedProperty(env, request, "bytes", &bytes_value) ||
      !GetBufferCopy(env, bytes_value, &replacement_bytes) ||
      !GetNamedProperty(env, request, "operationId", &operation_value) ||
      !GetUtf8String(env, operation_value, &operation_id)) {
    return nullptr;
  }
  if (!IsOperationId(operation_id)) {
    ThrowCode(env, "INVALID_ARGUMENT", "The native request is invalid.");
    return nullptr;
  }
  if (expected.is_directory || expected.reparse_tag != 0U ||
      (expected.file_attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0U ||
      expected.number_of_links != 1U) {
    ThrowCode(env, "INVALID_ARGUMENT", "The native request is invalid.");
    return nullptr;
  }

  OpenedRelative initial;
  std::vector<unsigned char> original_bytes;
  if (!OpenContentSnapshot(env, root, segments, &initial, &original_bytes)) {
    return nullptr;
  }
  if (!SameContentSnapshot(initial.final_snapshot, expected)) {
    ThrowCode(env, "DOCUMENT_CONFLICT",
              "The document changed before it could be saved.");
    return nullptr;
  }
  if ((initial.final_snapshot.file_attributes & FILE_ATTRIBUTE_READONLY) !=
      0U) {
    ThrowCode(env, "DOCUMENT_READ_ONLY", "The document is read-only.");
    return nullptr;
  }
  const NativeSnapshot original_snapshot = initial.final_snapshot;
  initial.handles.clear();

  const std::wstring target_path = AbsoluteFromSegments(*root, segments);
  std::wstring temp_path;
  ScopedHandle temp_handle;
#ifdef AAW_NATIVE_TEST_BUILD
  if (fault_point == "temp-create-access-denied") {
    ThrowSaveSystemError(env, ERROR_ACCESS_DENIED, "SAVE_FAILED",
                         "The document could not be saved.");
    return nullptr;
  }
#endif
  if (!CreateOperationTemp(*root, segments, operation_id, &temp_path,
                           &temp_handle)) {
    const DWORD create_error = GetLastError();
    if (create_error == ERROR_FILE_EXISTS ||
        create_error == ERROR_ALREADY_EXISTS) {
      ThrowCode(env, "SAVE_RECOVERY_REQUIRED",
                "A previous save operation must be reconciled.");
    } else {
      ThrowSaveSystemError(env, create_error, "SAVE_FAILED",
                           "The document could not be saved.");
    }
    return nullptr;
  }
  ScopedDeletePath temp_cleanup(temp_path);
#ifdef AAW_NATIVE_TEST_BUILD
  if (fault_point == "after-temp-create") {
    temp_handle.Reset();
    ThrowCode(env, "TEST_FAULT", "A synthetic save fault was injected.");
    return nullptr;
  }
#endif
#ifdef AAW_NATIVE_TEST_BUILD
  if (fault_point == "write-disk-full") {
    temp_handle.Reset();
    ThrowSaveSystemError(env, ERROR_DISK_FULL, "SAVE_FAILED",
                         "The document could not be saved.");
    return nullptr;
  }
#endif
  if (!WriteAllHandle(temp_handle.Get(), replacement_bytes)) {
    ThrowSaveSystemError(env, GetLastError(), "SAVE_FAILED",
                         "The document could not be saved.");
    return nullptr;
  }
#ifdef AAW_NATIVE_TEST_BUILD
  if (fault_point == "after-write") {
    temp_handle.Reset();
    ThrowCode(env, "TEST_FAULT", "A synthetic save fault was injected.");
    return nullptr;
  }
#endif
#ifdef AAW_NATIVE_TEST_BUILD
  if (fault_point == "flush-disk-full") {
    temp_handle.Reset();
    ThrowSaveSystemError(env, ERROR_HANDLE_DISK_FULL, "SAVE_FAILED",
                         "The document could not be saved.");
    return nullptr;
  }
#endif
  if (!FlushFileBuffers(temp_handle.Get())) {
    ThrowSaveSystemError(env, GetLastError(), "SAVE_FAILED",
                         "The document could not be saved.");
    return nullptr;
  }
#ifdef AAW_NATIVE_TEST_BUILD
  if (fault_point == "after-flush") {
    temp_handle.Reset();
    ThrowCode(env, "TEST_FAULT", "A synthetic save fault was injected.");
    return nullptr;
  }
#endif
  NativeSnapshot temp_snapshot{};
  std::vector<unsigned char> temp_readback;
  std::wstring temp_final_path;
  if (!SnapshotHandle(temp_handle.Get(), &temp_snapshot) ||
      !GetFinalPath(temp_handle.Get(), &temp_final_path) ||
      !EqualPathOrdinalIgnoreCase(temp_final_path, temp_path) ||
      temp_snapshot.volume_serial_number !=
          root->snapshot.volume_serial_number ||
      temp_snapshot.is_directory || temp_snapshot.reparse_tag != 0U ||
      (temp_snapshot.file_attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0U ||
      temp_snapshot.number_of_links != 1U ||
      !ReadAllHandle(temp_handle.Get(), kMaximumTextBytes, &temp_readback) ||
      temp_readback != replacement_bytes ||
      !HashBytes(temp_readback, &temp_snapshot.content_sha256) ||
      !HashHandleDacl(temp_handle.Get(), &temp_snapshot.dacl_sha256)) {
    ThrowCode(env, "SAVE_FAILED", "The document could not be saved.");
    return nullptr;
  }
  temp_handle.Reset();
#ifdef AAW_NATIVE_TEST_BUILD
  if (fault_point == "crash-before-replace") CrashProcessForTest();
  if (fault_point == "before-replace") {
    ThrowCode(env, "TEST_FAULT", "A synthetic save fault was injected.");
    return nullptr;
  }
#endif

  OpenedRelative conflict_check;
  std::vector<unsigned char> conflict_bytes;
  if (!OpenContentSnapshot(env, root, segments, &conflict_check,
                           &conflict_bytes)) {
    return nullptr;
  }
  if (!SameContentSnapshot(conflict_check.final_snapshot, expected)) {
    ThrowCode(env, "DOCUMENT_CONFLICT",
              "The document changed before it could be saved.");
    return nullptr;
  }
  // Keep every validated parent handle open through replace/readback. Closing
  // only the target avoids blocking ReplaceFileW while preventing a parent
  // directory from being renamed out from under the path-based operation.
  conflict_check.handles.pop_back();
#ifdef AAW_NATIVE_TEST_BUILD
  if (fault_point == "target-change-after-conflict" ||
      fault_point == "target-change-crash-after-replace") {
    const std::vector<unsigned char> external_bytes{
        'e', 'x', 't', 'e', 'r', 'n', 'a', 'l', ' ', 'c', 'o', 'n', 'c',
        'u', 'r', 'r', 'e', 'n', 't'};
    if (!OverwriteForTest(target_path, external_bytes)) {
      ThrowCode(env, "TEST_FAULT", "A synthetic save fault was injected.");
      return nullptr;
    }
  }
#endif

  std::wstring backup_path;
  std::wstring rollback_path;
  if (!MakeOperationSiblingPath(*root, segments, L"backup", operation_id,
                                &backup_path) ||
      !MakeOperationSiblingPath(*root, segments, L"rollback", operation_id,
                                &rollback_path) ||
      !PathDoesNotExist(backup_path) || !PathDoesNotExist(rollback_path)) {
    ThrowCode(env, "SAVE_RECOVERY_REQUIRED",
              "A previous save operation must be reconciled.");
    return nullptr;
  }
  ScopedDeletePath backup_cleanup(backup_path);
  ScopedDeletePath rollback_cleanup(rollback_path);
  const auto preserve_recovery_artifacts = [&]() {
    temp_cleanup.Release();
    backup_cleanup.Release();
    rollback_cleanup.Release();
  };

#ifdef AAW_NATIVE_TEST_BUILD
  if (fault_point == "replace-error-1175") {
    ThrowCode(env, "REPLACE_UNABLE_TO_REMOVE_REPLACED",
              "The document could not be atomically replaced.");
    return nullptr;
  }
  if (fault_point == "replace-error-1176") {
    ThrowCode(env, "REPLACE_UNABLE_TO_MOVE_REPLACEMENT",
              "The document could not be atomically replaced.");
    return nullptr;
  }
  if (fault_point == "replace-error-1177") {
    if (!MoveFileExW(target_path.c_str(), backup_path.c_str(),
                     MOVEFILE_WRITE_THROUGH) ||
        !RestoreBackupAfterReplace(root, target_path, backup_path,
                                   rollback_path, original_bytes,
                                   original_snapshot, false)) {
      preserve_recovery_artifacts();
      ThrowCode(env, "SAVE_RECOVERY_REQUIRED",
                "The document requires recovery before another save.");
      return nullptr;
    }
    ThrowCode(env, "REPLACE_PARTIAL_MOVE_RECOVERED",
              "The document was restored after an incomplete replacement.");
    return nullptr;
  }

  ScopedHandle test_lock;
  if (fault_point == "lock-target-before-replace") {
    test_lock.Reset(CreateFileW(target_path.c_str(), GENERIC_READ, 0U, nullptr,
                                OPEN_EXISTING,
                                FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    if (!test_lock.IsValid()) {
      ThrowCode(env, "TEST_FAULT", "A synthetic save fault was injected.");
      return nullptr;
    }
  }
#endif

  if (!ReplaceFileW(target_path.c_str(), temp_path.c_str(),
                    backup_path.c_str(), 0U, nullptr, nullptr)) {
    const DWORD replace_error = GetLastError();
    if (replace_error == ERROR_UNABLE_TO_REMOVE_REPLACED) {
      ThrowCode(env, "REPLACE_UNABLE_TO_REMOVE_REPLACED",
                "The document could not be atomically replaced.");
      return nullptr;
    }
    if (replace_error == ERROR_UNABLE_TO_MOVE_REPLACEMENT) {
      ThrowCode(env, "REPLACE_UNABLE_TO_MOVE_REPLACEMENT",
                "The document could not be atomically replaced.");
      return nullptr;
    }
    if (replace_error == ERROR_UNABLE_TO_MOVE_REPLACEMENT_2) {
      if (!RestoreBackupAfterReplace(root, target_path, backup_path,
                                     rollback_path, original_bytes,
                                     original_snapshot, false)) {
        preserve_recovery_artifacts();
        ThrowCode(env, "SAVE_RECOVERY_REQUIRED",
                  "The document requires recovery before another save.");
        return nullptr;
      }
      ThrowCode(env, "REPLACE_PARTIAL_MOVE_RECOVERED",
                "The document was restored after an incomplete replacement.");
      return nullptr;
    }
    ThrowSaveSystemError(env, replace_error, "SAVE_FAILED",
                         "The document could not be saved.");
    return nullptr;
  }
#ifdef AAW_NATIVE_TEST_BUILD
  if (fault_point == "crash-after-replace" ||
      fault_point == "target-change-crash-after-replace") {
    CrashProcessForTest();
  }
  if (fault_point == "rollback-restore-failure") {
    ScopedHandle rollback_marker(CreateFileW(
        rollback_path.c_str(), GENERIC_WRITE | DELETE, 0U, nullptr,
        CREATE_NEW, FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_NOT_CONTENT_INDEXED,
        nullptr));
    rollback_marker.Reset();
    preserve_recovery_artifacts();
    ThrowCode(env, "SAVE_RECOVERY_REQUIRED",
              "The document requires recovery before another save.");
    return nullptr;
  }

  if (fault_point == "corrupt-readback" &&
      !OverwriteForTest(target_path, std::vector<unsigned char>{0x21U})) {
    preserve_recovery_artifacts();
    ThrowCode(env, "SAVE_RECOVERY_REQUIRED",
              "The document requires recovery before another save.");
    return nullptr;
  }
  const bool forced_rollback = fault_point == "after-replace" ||
                               fault_point == "corrupt-readback";
#else
  constexpr bool forced_rollback = false;
#endif
  NativeSnapshot replacement_snapshot{};
  const bool replacement_verified =
      !forced_rollback &&
      VerifyAbsoluteFile(target_path, root->snapshot, replacement_bytes,
                         &temp_snapshot, &original_snapshot,
                         &replacement_snapshot);
  NativeSnapshot backup_snapshot{};
  std::vector<unsigned char> backup_bytes;
  if (!ReadAbsoluteFile(backup_path, root->snapshot, &backup_bytes,
                        &backup_snapshot)) {
    preserve_recovery_artifacts();
    ThrowCode(env, "SAVE_RECOVERY_REQUIRED",
              "The document requires recovery before another save.");
    return nullptr;
  }
  const bool backup_is_original =
      backup_bytes == original_bytes &&
      SameContentSnapshot(backup_snapshot, original_snapshot);
  if (!replacement_verified || !backup_is_original) {
    if (!RestoreBackupAfterReplace(root, target_path, backup_path,
                                   rollback_path, backup_bytes,
                                   backup_snapshot, true)) {
      preserve_recovery_artifacts();
      ThrowCode(env, "SAVE_RECOVERY_REQUIRED",
                "The document requires recovery before another save.");
      return nullptr;
    }
    ThrowCode(env,
              backup_is_original ? "SAVE_ROLLED_BACK" : "DOCUMENT_CONFLICT",
              backup_is_original
                  ? "The document was restored after save verification failed."
                  : "A newer external document version was restored.");
    return nullptr;
  }
  bool backup_deleted = false;
#ifdef AAW_NATIVE_TEST_BUILD
  if (fault_point != "backup-cleanup-failure") {
    backup_deleted = DeleteFileW(backup_path.c_str()) != FALSE;
  }
#else
  backup_deleted = DeleteFileW(backup_path.c_str()) != FALSE;
#endif
  if (!backup_deleted) {
    if (!RestoreBackupAfterReplace(root, target_path, backup_path,
                                   rollback_path, backup_bytes,
                                   backup_snapshot, true)) {
      preserve_recovery_artifacts();
      ThrowCode(env, "SAVE_RECOVERY_REQUIRED",
                "The document requires recovery before another save.");
      return nullptr;
    }
    ThrowCode(env, "SAVE_ROLLED_BACK",
              "The document was restored after save cleanup failed.");
    return nullptr;
  }
#ifdef AAW_NATIVE_TEST_BUILD
  if (fault_point == "crash-after-cleanup") CrashProcessForTest();
#endif
  return SnapshotToValue(env, replacement_snapshot);
}

napi_value ReplaceVerifiedText(napi_env env, napi_callback_info info) {
  try {
    napi_value request{};
    if (!GetSingleArgument(env, info, &request) ||
        !RequireExactProperties(
            env, request,
            {"bytes", "expectedSnapshot", "operationId", "relativeSegments",
             "root"})) {
      return nullptr;
    }
    return ReplaceVerifiedTextCore(env, request, "");
  } catch (...) {
    ThrowCode(env, "INTERNAL", "The native filesystem boundary failed.");
    return nullptr;
  }
}

bool ReadOptionalAbsolute(const std::wstring& path,
                          const NativeSnapshot& root_snapshot, bool* exists,
                          std::vector<unsigned char>* bytes,
                          NativeSnapshot* snapshot) {
  if (PathDoesNotExist(path)) {
    *exists = false;
    bytes->clear();
    *snapshot = NativeSnapshot{};
    return true;
  }
  *exists = true;
  return ReadAbsoluteFile(path, root_snapshot, bytes, snapshot);
}

napi_value ReconcileResultToValue(napi_env env, const char* outcome,
                                  const NativeSnapshot& snapshot) {
  napi_value result{};
  napi_value snapshot_value = SnapshotToValue(env, snapshot);
  if (snapshot_value == nullptr ||
      !CheckStatus(env, napi_create_object(env, &result)) ||
      !SetNamedString(env, result, "outcome", outcome) ||
      !CheckStatus(
          env, napi_set_named_property(env, result, "snapshot", snapshot_value))) {
    return nullptr;
  }
  return result;
}

napi_value ReconcileVerifiedText(napi_env env, napi_callback_info info) {
  try {
    napi_value request{};
    if (!GetSingleArgument(env, info, &request) ||
        !RequireExactProperties(
            env, request,
            {"expectedSnapshot", "operationId", "relativeSegments",
             "replacementContentSha256", "root"})) {
      return nullptr;
    }
    RootContext* root = nullptr;
    napi_value segments_value{};
    napi_value expected_value{};
    napi_value operation_value{};
    napi_value replacement_hash_value{};
    std::vector<std::wstring> segments;
    NativeSnapshot expected{};
    std::string operation_id;
    std::string replacement_hash;
    if (!UnwrapRoot(env, request, &root) ||
        !GetNamedProperty(env, request, "relativeSegments", &segments_value) ||
        !ReadRelativeSegments(env, segments_value, &segments) ||
        !GetNamedProperty(env, request, "expectedSnapshot", &expected_value) ||
        !ParseSnapshot(env, expected_value, &expected) ||
        !GetNamedProperty(env, request, "operationId", &operation_value) ||
        !GetUtf8String(env, operation_value, &operation_id) ||
        !GetNamedProperty(env, request, "replacementContentSha256",
                          &replacement_hash_value) ||
        !GetUtf8String(env, replacement_hash_value, &replacement_hash)) {
      return nullptr;
    }
    if (!IsOperationId(operation_id) ||
        !IsLowercaseSha256(replacement_hash)) {
      ThrowCode(env, "INVALID_ARGUMENT", "The native request is invalid.");
      return nullptr;
    }
    const std::wstring target_path = AbsoluteFromSegments(*root, segments);
    std::wstring temp_path;
    std::wstring backup_path;
    std::wstring rollback_path;
    if (!MakeOperationSiblingPath(*root, segments, L"temp", operation_id,
                                  &temp_path) ||
        !MakeOperationSiblingPath(*root, segments, L"backup", operation_id,
                                  &backup_path) ||
        !MakeOperationSiblingPath(*root, segments, L"rollback", operation_id,
                                  &rollback_path)) {
      ThrowCode(env, "INVALID_ARGUMENT", "The native request is invalid.");
      return nullptr;
    }
    if (!PathDoesNotExist(rollback_path)) {
      ThrowCode(env, "SAVE_RECOVERY_REQUIRED",
                "The save operation requires manual recovery.");
      return nullptr;
    }

    bool target_exists = false;
    bool backup_exists = false;
    bool temp_exists = false;
    std::vector<unsigned char> target_bytes;
    std::vector<unsigned char> backup_bytes;
    std::vector<unsigned char> temp_bytes;
    NativeSnapshot target_snapshot{};
    NativeSnapshot backup_snapshot{};
    NativeSnapshot temp_snapshot{};
    if (!ReadOptionalAbsolute(target_path, root->snapshot, &target_exists,
                              &target_bytes, &target_snapshot) ||
        !ReadOptionalAbsolute(backup_path, root->snapshot, &backup_exists,
                              &backup_bytes, &backup_snapshot) ||
        !ReadOptionalAbsolute(temp_path, root->snapshot, &temp_exists,
                              &temp_bytes, &temp_snapshot)) {
      ThrowCode(env, "SAVE_RECOVERY_REQUIRED",
                "The save operation requires manual recovery.");
      return nullptr;
    }

    const bool target_is_original =
        target_exists && SameContentSnapshot(target_snapshot, expected);
    const bool target_is_replacement =
        target_exists && target_snapshot.content_sha256 == replacement_hash;
    const bool backup_is_original =
        backup_exists && SameContentSnapshot(backup_snapshot, expected);
    const bool temp_is_replacement =
        temp_exists && temp_snapshot.content_sha256 == replacement_hash;

    if (backup_exists) {
      const bool backup_is_external = !backup_is_original;
      if (!RestoreBackupAfterReplace(root, target_path, backup_path,
                                     rollback_path, backup_bytes,
                                     backup_snapshot, target_exists)) {
        ThrowCode(env, "SAVE_RECOVERY_REQUIRED",
                  "The save operation requires manual recovery.");
        return nullptr;
      }
      if (temp_exists && !DeleteFileW(temp_path.c_str())) {
        ThrowCode(env, "SAVE_RECOVERY_REQUIRED",
                  "The save operation requires manual recovery.");
        return nullptr;
      }
      NativeSnapshot restored{};
      std::vector<unsigned char> restored_bytes;
      if (!ReadAbsoluteFile(target_path, root->snapshot, &restored_bytes,
                            &restored)) {
        ThrowCode(env, "SAVE_RECOVERY_REQUIRED",
                  "The save operation requires manual recovery.");
        return nullptr;
      }
      if (target_is_replacement && !backup_is_external) {
        // The replacement committed, but no durable caller acknowledgement
        // exists. Conservatively restore the original and report rollback.
        return ReconcileResultToValue(env, "rolled_back", restored);
      }
      return ReconcileResultToValue(
          env, backup_is_external ? "conflict_rolled_back" : "rolled_back",
          restored);
    }

    if (!target_exists) {
      ThrowCode(env, "SAVE_RECOVERY_REQUIRED",
                "The save operation requires manual recovery.");
      return nullptr;
    }
    if (temp_exists) {
      if (!temp_is_replacement || !DeleteFileW(temp_path.c_str())) {
        ThrowCode(env, "SAVE_RECOVERY_REQUIRED",
                  "The save operation requires manual recovery.");
        return nullptr;
      }
    }
    if (target_is_replacement) {
      return ReconcileResultToValue(env, "committed", target_snapshot);
    }
    if (target_is_original) {
      return ReconcileResultToValue(env, "not_committed", target_snapshot);
    }
    return ReconcileResultToValue(env, "conflict_not_committed",
                                  target_snapshot);
  } catch (...) {
    ThrowCode(env, "INTERNAL", "The native filesystem boundary failed.");
    return nullptr;
  }
}

#ifdef AAW_NATIVE_TEST_BUILD
napi_value ClassifyDriveTypeTest(napi_env env, napi_callback_info info) {
  try {
    napi_value request{};
    if (!GetSingleArgument(env, info, &request) ||
        !RequireExactProperties(env, request, {"driveType"})) {
      return nullptr;
    }
    napi_value drive_type_value{};
    uint32_t drive_type = 0U;
    if (!GetNamedProperty(env, request, "driveType", &drive_type_value) ||
        !GetUint32(env, drive_type_value, &drive_type)) {
      return nullptr;
    }
    napi_value result{};
    if (!CheckStatus(env, napi_get_boolean(
                             env, IsFixedDriveType(drive_type), &result))) {
      return nullptr;
    }
    return result;
  } catch (...) {
    ThrowCode(env, "INTERNAL", "The native filesystem boundary failed.");
    return nullptr;
  }
}

napi_value RejectReparseMetadataTest(napi_env env, napi_callback_info info) {
  try {
    napi_value request{};
    if (!GetSingleArgument(env, info, &request) ||
        !RequireExactProperties(env, request,
                                {"fileAttributes", "reparseTag"})) {
      return nullptr;
    }
    napi_value attributes_value{};
    napi_value tag_value{};
    uint32_t attributes = 0U;
    uint32_t tag = 0U;
    if (!GetNamedProperty(env, request, "fileAttributes",
                          &attributes_value) ||
        !GetNamedProperty(env, request, "reparseTag", &tag_value) ||
        !GetUint32(env, attributes_value, &attributes) ||
        !GetUint32(env, tag_value, &tag)) {
      return nullptr;
    }
    NativeSnapshot snapshot{};
    snapshot.file_attributes = attributes;
    snapshot.reparse_tag = tag;
    if (!RejectReparse(env, snapshot)) return nullptr;
    napi_value result{};
    if (!CheckStatus(env, napi_get_undefined(env, &result))) return nullptr;
    return result;
  } catch (...) {
    ThrowCode(env, "INTERNAL", "The native filesystem boundary failed.");
    return nullptr;
  }
}

napi_value ReplaceVerifiedTextTest(napi_env env, napi_callback_info info) {
  try {
    napi_value request{};
    if (!GetSingleArgument(env, info, &request) ||
        !RequireExactProperties(
            env, request,
            {"bytes", "expectedSnapshot", "faultPoint", "operationId",
             "relativeSegments", "root"})) {
      return nullptr;
    }
    napi_value fault_value{};
    std::string fault;
    if (!GetNamedProperty(env, request, "faultPoint", &fault_value) ||
        !GetUtf8String(env, fault_value, &fault)) {
      return nullptr;
    }
    const std::set<std::string> allowed{
        "after-temp-create", "after-write",       "after-flush",
        "before-replace",    "after-replace",     "corrupt-readback",
        "target-change-after-conflict",
        "target-change-crash-after-replace",
        "lock-target-before-replace",
        "temp-create-access-denied", "write-disk-full",
        "flush-disk-full", "backup-cleanup-failure",
        "rollback-restore-failure",
        "crash-before-replace", "crash-after-replace",
        "crash-after-cleanup",
        "replace-error-1175", "replace-error-1176", "replace-error-1177"};
    if (allowed.find(fault) == allowed.end()) {
      ThrowCode(env, "INVALID_ARGUMENT", "The native request is invalid.");
      return nullptr;
    }
    return ReplaceVerifiedTextCore(env, request, fault);
  } catch (...) {
    ThrowCode(env, "INTERNAL", "The native filesystem boundary failed.");
    return nullptr;
  }
}
#endif

napi_value CloseRoot(napi_env env, napi_callback_info info) {
  try {
    napi_value request{};
    if (!GetSingleArgument(env, info, &request) ||
        !RequireExactProperties(env, request, {"root"})) {
      return nullptr;
    }
    napi_value root_value{};
    if (!GetNamedProperty(env, request, "root", &root_value) ||
        !RequireObject(env, root_value)) {
      return nullptr;
    }
    void* data = nullptr;
    if (!CheckStatus(env, napi_unwrap(env, root_value, &data)) ||
        data == nullptr) {
      ThrowCode(env, "CAPABILITY_UNAVAILABLE",
                "The native root capability is unavailable.");
      return nullptr;
    }
    auto* root = static_cast<RootContext*>(data);
    if (!root->closed) {
      root->handle.Reset();
      root->closed = true;
    }
    napi_value undefined{};
    if (!CheckStatus(env, napi_get_undefined(env, &undefined))) return nullptr;
    return undefined;
  } catch (...) {
    ThrowCode(env, "INTERNAL", "The native filesystem boundary failed.");
    return nullptr;
  }
}

napi_value Init(napi_env env, napi_value exports) {
#ifdef AAW_NATIVE_TEST_BUILD
  const std::array<napi_property_descriptor, 10U> descriptors{{
#else
  const std::array<napi_property_descriptor, 7U> descriptors{{
#endif
      {"getCapabilities", nullptr, GetCapabilities, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"openValidatedRoot", nullptr, OpenValidatedRoot, nullptr, nullptr,
       nullptr, napi_default, nullptr},
      {"inspectRelative", nullptr, InspectRelative, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"readVerifiedText", nullptr, ReadVerifiedText, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"replaceVerifiedText", nullptr, ReplaceVerifiedText, nullptr, nullptr,
       nullptr, napi_default, nullptr},
      {"reconcileVerifiedText", nullptr, ReconcileVerifiedText, nullptr,
       nullptr, nullptr, napi_default, nullptr},
#ifdef AAW_NATIVE_TEST_BUILD
      {"classifyDriveTypeTest", nullptr, ClassifyDriveTypeTest, nullptr,
       nullptr, nullptr, napi_default, nullptr},
      {"rejectReparseMetadataTest", nullptr, RejectReparseMetadataTest,
       nullptr, nullptr, nullptr, napi_default, nullptr},
      {"replaceVerifiedTextTest", nullptr, ReplaceVerifiedTextTest, nullptr,
       nullptr, nullptr, napi_default, nullptr},
#endif
      {"closeRoot", nullptr, CloseRoot, nullptr, nullptr, nullptr, napi_default,
       nullptr},
  }};
  if (!CheckStatus(env, napi_define_properties(
                            env, exports, descriptors.size(),
                            descriptors.data()))) {
    return nullptr;
  }
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
