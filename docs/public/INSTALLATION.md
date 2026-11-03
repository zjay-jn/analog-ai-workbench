# Windows source installation

This is a developer source installation, not a prebuilt installer. The supported target is Windows x64 on local fixed disks.

## Prerequisites

- Node.js `24.20.0` with npm `11.19.0` (the normal Windows Node distribution includes npm).
- Python 3.10+ and Visual Studio 2022 C++ Build Tools with the Windows SDK.
- Network access to the official npm, Node, Electron and OpenCode download endpoints, or the explicit verified public SDK cache options below.

If Python is not discoverable on PATH, set `AAW_NATIVE_PYTHON` to your installed Python executable in the current shell before setup. The installer does not install Python, Visual Studio or a system-wide service.

## Install and run

From the cloned repository:

```powershell
npm ci
npm run setup:desktop
npm start
```

The explicit setup step is necessary because dependency lifecycle scripts are disabled. It downloads the pinned OpenCode/Electron SDKs, verifies fixed archive/executable identities, compiles the native helpers, and runs its own harmless isolation/cleanup tests. Command execution is admitted only after fixed exit-0 and expected-exit-7 checks complete with verified logs and cleanup. A successful compiler exit alone does not mark commands ready.

`npm run doctor` is read-only. Its runtime readiness is separate from `buildPrerequisitesReady`: an already built installation can run without Python or a compiler on PATH. SDK download and native build failures remain visible rather than falling back to a previous installation.

## First launch and storage

The initial model settings have no credentials. Open model settings and enter your own provider key when you want model access. The application does not automatically read an old drive's API file. Opening the synthetic schematic does not require a model key, WSL or Cadence. Unconfigured private schematic/OA sources are not listed as available.

Installation SDKs and build receipts are beneath the checkout's `.local/runtime`. Conversations, settings, workspaces, command logs and the Chromium profile default to `%APPDATA%/AnalogAIWorkbench/.local`, separately from source code. An older installation and its data are not automatically imported or overwritten.

For an explicitly separate data location, use the same absolute root in both commands:

```powershell
npm run setup:desktop -- --storage-root="D:\AAWData"
npm start -- --storage-root="D:\AAWData"
npm run doctor -- --storage-root="D:\AAWData"
```

Native root bindings are verified. Rerun setup after changing the installation location, data root or Windows user; do not copy another installation's runtime manifest as an admission.

## Slow or offline public SDK downloads

Downloads have bounded size/time limits and progress output. `AAW_DOWNLOAD_TIMEOUT_MS` can explicitly select a timeout between 30 seconds and 30 minutes. Partial downloads are not accepted as installed artifacts.

The setup CLI accepts `--opencode-file=<absolute-exe>`, `--node-headers-archive=<absolute-tar.gz>` and `--node-lib-file=<absolute-lib>`. These are only inputs for the fixed public versions: ordinary nonlinked files must match the installer’s fixed SHA-256 and size checks. They do not import application state, credentials, circuit files or an entire `.local` directory.

Electron is installed through its locked official installer. An Electron SDK already installed by that dependency may be reused. The source tree does not contain the SDK binaries or a public offline Electron bundle.

## Scope

Real WSL/Cadence/OA integration requires its own explicitly configured environment and is not part of the default installation. The private historical circuit is not shipped. Real model connectivity needs your provider configuration; offline startup/native checks do not establish a real API round trip. A packaged end-user installer and an automated private-data migration are separate work.
