# Development

## Reproducible source checks

Use Windows x64, Node `24.20.0` and npm `11.19.0`. Run `npm ci` from the repository root. The lockfile is authoritative. Installation scripts are disabled by `.npmrc`.

The repository's `.gitattributes` disables Git line-ending conversion. Fixture admission, source exceptions and the license inventory verify exact bytes, including line endings. Preserve this policy on Windows and do not normalize a batch of files without reviewing and updating its affected hashes.

```powershell
npm run typecheck
npm run test:public
npm run test:release
npm run test:setup
npm run test:security
npm run licenses:check
npm run release:audit
npm run check:public-source
```

`test:public` is an explicitly selected offline core suite, not the full historical matrix. It must not require a private circuit, model token, installed OpenCode or WSL/Cadence. `check:public-source` builds into `.local/public-source-check`. Neither command installs a desktop build.

`npm test` retains the broader development tests. Some require private reviewed fixtures or pinned native integration resources. Integration, real provider and WSL/EDA checks need their own explicit environment; do not describe a synthetic result as proof of those integrations.

## Source desktop runtime

Follow [INSTALLATION](INSTALLATION.md) for source setup. `npm run setup:desktop` prepares fixed public SDKs, compiles native helpers and checks isolation and cleanup. `npm start` builds and launches the source cloud entry. `npm run doctor` is read-only and must not download Electron.

Assets live under the checkout's `.local/runtime`. Mutable stores default to `%APPDATA%/AnalogAIWorkbench/.local`. Source `--storage-root=<absolute>` must match across setup and startup. Moving source/native roots requires setup again; copying an old runtime manifest is not an admission.

Both source and packaged modes default to the same Windows user data location. Use a separate source data root for development when appropriate. Production does not load a legacy credential file or private OA example automatically. A new data root has no keys; configure providers in the UI. Synthetic schematics require no provider, WSL or Cadence.

## Build the Windows installer

The end-user package is an unsigned Windows x64 alpha. Users of the built installer do not need development tools. Building it requires the pinned Node/npm versions above, Python 3.10+, Visual Studio 2022 C++ Build Tools and Windows SDK, plus access to the official runtime and NSIS download endpoints.

From a clean audited checkout:

```powershell
npm ci
node tools/setup-desktop.mjs download-native
npm run package:windows
```

`download-native` prepares the fixed Node headers/import library, Node runtime/license and OpenCode inputs used by the build. A prior full source setup can also supply those inputs. The package builder obtains the fixed official Electron `43.4.0` and NSIS `3.13` ZIP archives, verifies their hashes, bundles the production main/preload/renderer and initializer, then builds generic precompiled native helpers. It does not install the generated package.

The payload includes Node `24.20.0`, OpenCode `1.18.17`, Electron and native runtime files with MIT and third-party license texts. It excludes development SDKs, source fixtures, private assets, user state, logs and prior source runtime/admission proofs. Public synthetic runtime content remains available in the compiled application.

The default build requires a clean Git worktree. `--allow-dirty` exists only for local testing:

```powershell
npm run package:windows -- --allow-dirty
```

Such a build records that the source was dirty; it is not a release-validation shortcut. The builder also accepts explicit `--nsis-archive=<absolute-zip>`, `--electron-archive=<absolute-zip>` and `--native-result=<absolute-build-result-json>` inputs. Archives must match fixed hashes; native reuse must match current source and artifact pins. These are build inputs, not paths to another machine's runtime admission.

Each build creates a fresh `.local/windows-installer/build-<UUID>` directory containing the installer, its `.exe.sha256` sidecar and private build records. The installer name is `AnalogAIWorkbench-<version>-windows-x64-setup.exe`. A `BUILT_NOT_YET_INSTALLED` receipt means construction only. This command does not upload files, change the main branch or create a GitHub Release.

## Installer and packaged-runtime validation

```powershell
npm run test:installer
npm run test:packaged
```

`test:installer` includes real C++ compilation and UUID-owned synthetic filesystem boundary tests; its Windows native cases require the build tools. They do not uninstall or alter a real installation. `test:packaged` checks packaged runtime contracts and synthetic refusal paths; these checks alone do not prove a real installed first launch or native execution.

Keep separate evidence for actual installed first launch, Electron addon loading, local fixed native/command checks, cold recovery, upgrades and uninstall retention. A clean-machine run without development tools is a separate scope from a hosted runner that already has Visual Studio. Do not mark those scopes PASS merely because bundling or unit tests succeeded.

The installed application derives current-user roots and system pins on the destination machine, and verifies local native results before admitting execution. It never imports a development machine's old PASS state. Upgrade and uninstall preserve the user data directory; deletion is limited to the installer's known payload paths. See [INSTALLATION](INSTALLATION.md) for user-facing paths and behavior.

## Release preparation tools

```powershell
node tools/public-release/index.mjs plan
node tools/public-release/index.mjs audit
node --test tests/public-release.test.mjs
```

The source plan records paths/hashes, curated document mappings and blockers without copying files. Export requires a new destination and the reviewed plan hash. It fails before creating that destination if a license, secret or consistency check fails.

Preserve exact root/document mirrors, license notices and the generated source inventory. Keep SDKs, build records, native admission, user data and diagnostics outside the published source tree. Review both source staging and the binary payload before an authorized publication. No public download or completed installer validation is asserted by these build instructions.
