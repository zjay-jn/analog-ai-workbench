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

`test:public` is an explicitly selected offline core suite, not the full historical test matrix. It must not require a private circuit export, model token, installed OpenCode or WSL/Cadence. Its runner prints the selected tests. `check:public-source` builds to its own `.local/public-source-check` directory. Neither command installs a desktop build.

`npm test` retains the development workspace's broader tests. Some currently require private reviewed fixtures or pinned native integration resources and are not the public CI entry point. `.integration.mjs`, native helper, real provider and WSL/EDA checks need their own explicit environment; do not silently substitute public synthetic results for those checks.

## Desktop runtime

Follow [INSTALLATION](INSTALLATION.md) for the locked Windows source installation. `npm run setup:desktop` prepares the fixed OpenCode/Electron SDKs, builds native helpers with Python/VS C++/Windows SDK, exercises native isolation and cleanup, and only then admits command execution. `npm start` builds and launches the production cloud entry.

Installation assets live below the checkout's `.local/runtime`; mutable stores and the Chromium profile default to `%APPDATA%/AnalogAIWorkbench/.local`. Main configures these roots before capabilities are constructed. Explicit `--storage-root=<absolute>` must match between setup and startup. Paths, links, file identities, hashes, generated root bindings and native results remain checked. Relocating installed native files requires rerunning setup rather than copying an old manifest.

Production starts without legacy credential-file loading or a private OA source. Configure model keys in the existing settings UI. The synthetic schematic works without credentials, WSL or Cadence. Real OA/WSL integration is optional work that requires an explicitly configured environment; the earlier private example is not a default installed asset.

The installation does not provide a binary release or automatically migrate another installation's conversations/keys. Some full historical tests still require their original integrations. Native command verification uses fixed synthetic commands, never project instructions. Diagnostic `doctor` is read-only and must not trigger an Electron download.

## Release preparation tools

```powershell
node tools/public-release/index.mjs plan
node tools/public-release/index.mjs audit
node --test tests/public-release.test.mjs
```

The plan records exact paths/hashes, curated documentation mappings and blockers without copying files. Export requires a new destination and the reviewed plan hash. It fails before creating that destination if a license, secret or source consistency check fails. Keep plan/evidence files outside the public source tree. Review the generated manifest and staged files again before uploading.
