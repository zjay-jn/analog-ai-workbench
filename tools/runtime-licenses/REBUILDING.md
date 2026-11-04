# Bundled runtime sources

The Workbench communicates with the unmodified OpenCode executable as a separate process. Its MIT license does not replace the licenses of the runtime linked into that executable.

- OpenCode `1.18.17`, source revision `02546dfc2e4515a4f90aaf9ceb3890df2ac2b479`: https://github.com/anomalyco/opencode/tree/v1.18.17
- The fixed OpenCode executable reports Bun `1.3.14` when invoked with the upstream `BUN_BE_BUN=1` runtime switch: https://github.com/oven-sh/bun/tree/bun-v1.3.14
- Bun's matching upstream licensing and relinking instructions are reproduced in `BUN-1.3.14-LICENSE.md`. They identify its patched WebKit/JavaScriptCore sources and the other linked libraries. Preserve those notices and their licenses when redistributing the executable.
- Workbench's source repository includes the native build recipes and integrity constants. Recipients may modify the sources and rebuild to use modified runtimes; the integrity checks are not a restriction on the license permissions to study, modify, rebuild or relink software.

The binary package also contains Node's complete `LICENSE`, Electron's `LICENSE` and `LICENSES.chromium.html`, the installed npm packages' available license/notice texts, and NSIS's `COPYING`.
