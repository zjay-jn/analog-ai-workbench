# Windows installation

The supported target is Windows x64 on local fixed disks. This branch contains both an end-user installer build and the developer source installation. The installer is an unsigned alpha. This document does not claim a published download or a completed installation test.

## End-user installer

Use the supplied `AnalogAIWorkbench-<version>-windows-x64-setup.exe` and compare its SHA-256 with the accompanying `.exe.sha256` file. The package contains Electron `43.4.0`, Node.js `24.20.0`, OpenCode `1.18.17` and precompiled native components. Installing and opening it does not require a system Node/npm installation, Python, Visual Studio, Windows SDK, WSL or Cadence.

The installer works offline and installs for the current Windows user without requesting administrator elevation. Its fixed destination is:

```text
%LOCALAPPDATA%\Programs\AnalogAIWorkbench
```

Open Analog AI Workbench from its Start menu or desktop shortcut. On first launch, the application verifies the packaged files and performs fixed local isolation, command/log and cleanup checks for the current machine. It does not compile code, install SDKs, call a model or run EDA. A failed check leaves the runtime unready and reports an error code with local diagnostic evidence.

A new data root starts without provider credentials. Configure your own provider key in model settings when you want model access. The synthetic schematic works without a key. Existing settings and conversations at the default data location are retained.

## User data, upgrades and uninstall

Conversations, settings, workspaces, command logs, local admission evidence and the Chromium profile are beneath:

```text
%APPDATA%\AnalogAIWorkbench\.local
```

This is separate from the installed program files. Close the workbench before installing an update or uninstalling. The installer checks the fixed destination, product marker, path identities and known payload files before changing program files.

Uninstall through Windows Installed apps or the workbench's uninstall shortcut. Uninstall removes the known application payload, shortcuts and current-user uninstall registration. It preserves the user data directory and unknown files in the installation directory; a directory containing such files may remain.

The installed application uses fixed current-user locations; the source-only `--storage-root` option below is not an installer destination or packaged data override. A changed package or machine profile requires matching local runtime verification. Do not copy a development runtime manifest or another machine's admission into the installed application.

## Developer source installation

Source installation requires:

- Node.js `24.20.0` and npm `11.19.0`.
- Python 3.10+ and Visual Studio 2022 C++ Build Tools with the Windows SDK.
- Access to the official npm, Node, Electron and OpenCode download endpoints, or the explicit verified SDK cache inputs described below.

If Python is not discoverable on PATH, set `AAW_NATIVE_PYTHON` to the installed Python executable in the current shell. Source setup does not install Python, Visual Studio or a system-wide service.

From the cloned repository:

```powershell
npm ci
npm run setup:desktop
npm start
```

The setup step is explicit because dependency lifecycle scripts are disabled. It prepares pinned runtime SDKs, compiles the source-mode native helpers and verifies isolation, fixed exit-0/expected-exit-7 commands, logs and cleanup. A successful compiler exit alone does not admit command execution.

`npm run doctor` is read-only and applies to the source installation. Runtime readiness is separate from `buildPrerequisitesReady`: already built helpers do not need a compiler on PATH to run. Setup failures remain visible rather than falling back to another installation.

Source installation assets and build receipts live beneath the checkout's `.local/runtime`. Source and packaged modes default to the same current-user data location. To keep development data separate, use the same absolute root for setup, startup and diagnosis:

```powershell
npm run setup:desktop -- --storage-root="D:\AAWData"
npm start -- --storage-root="D:\AAWData"
npm run doctor -- --storage-root="D:\AAWData"
```

Source native root bindings are verified. Rerun source setup after changing its checkout, data root or Windows user. Data from a different custom location is not automatically migrated.

## Slow or offline source SDK downloads

Downloads have bounded size/time limits and progress output. `AAW_DOWNLOAD_TIMEOUT_MS` can select a timeout between 30 seconds and 30 minutes. Partial downloads are not accepted as installed artifacts.

Source setup accepts `--opencode-file=<absolute-exe>`, `--node-headers-archive=<absolute-tar.gz>` and `--node-lib-file=<absolute-lib>`. These inputs must match the fixed public SDK versions, ordinary-file requirements, SHA-256 and size checks. They do not import application state, credentials, circuits or an entire `.local` directory.

Source Electron setup uses the locked official installer and may reuse its installed SDK. Building the end-user package separately uses the fixed official Electron and NSIS archives; it does not package a mutable source SDK directory wholesale. See [DEVELOPMENT](DEVELOPMENT.md) for the build commands and optional verified archive inputs.

## Scope

Real model connectivity requires provider configuration; offline installation and native self-checks do not prove an API round trip. Private circuit exports and configured WSL/Cadence/OA environments are not distributed. Automated migration from another data location is not provided. Installer construction, clean-machine installation, upgrade/uninstall retention and real provider tests must each be reported with their actual evidence.
