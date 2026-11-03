{
  "targets": [
    {
      "target_name": "aaw_windows_fs_native",
      "sources": ["src/addon.cc"],
      "libraries": ["bcrypt.lib", "advapi32.lib"],
      "defines": [
        "_WIN32_WINNT=0x0A00",
        "WIN32_LEAN_AND_MEAN",
        "NOMINMAX",
        "UNICODE",
        "_UNICODE",
        "NAPI_VERSION=8",
        "NODE_API_NO_EXTERNAL_BUFFERS_ALLOWED"
      ],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "AdditionalOptions": ["/permissive-", "/sdl", "/guard:cf"],
          "ExceptionHandling": 1,
          "RuntimeLibrary": 2,
          "WarnAsError": "true",
          "WarningLevel": 4
        },
        "VCLinkerTool": {
          "AdditionalOptions": ["/guard:cf", "/CETCOMPAT", "/DYNAMICBASE", "/NXCOMPAT"]
        }
      }
    },
    {
      "target_name": "aaw_windows_fs_native_test",
      "sources": ["src/addon.cc"],
      "libraries": ["bcrypt.lib", "advapi32.lib"],
      "defines": [
        "_WIN32_WINNT=0x0A00",
        "WIN32_LEAN_AND_MEAN",
        "NOMINMAX",
        "UNICODE",
        "_UNICODE",
        "NAPI_VERSION=8",
        "NODE_API_NO_EXTERNAL_BUFFERS_ALLOWED",
        "AAW_NATIVE_TEST_BUILD=1"
      ],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "AdditionalOptions": ["/permissive-", "/sdl", "/guard:cf"],
          "ExceptionHandling": 1,
          "RuntimeLibrary": 2,
          "WarnAsError": "true",
          "WarningLevel": 4
        },
        "VCLinkerTool": {
          "AdditionalOptions": ["/guard:cf", "/CETCOMPAT", "/DYNAMICBASE", "/NXCOMPAT"]
        }
      }
    }
  ]
}
