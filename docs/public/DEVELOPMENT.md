# Development

## Reproducible source checks

Use Windows x64, Node `24.20.0` and npm `11.19.0`. Run `npm ci` from the repository root. The lockfile is authoritative. Installation scripts are disabled by `.npmrc`.

The repository's `.gitattributes` disables Git line-ending conversion. Fixture admission, source exceptions and the license inventory verify exact bytes, including line endings. Preserve this policy on Windows and do not normalize a batch of files without reviewing and updating its affected hashes.

```powershell
npm run typecheck
npm run test:public
npm run test:release
npm run test:security
npm run licenses:check
npm run release:audit
npm run check:public-source
```

`test:public` is an explicitly selected offline core suite, not the full historical test matrix. It must not require a private circuit export, model token, installed OpenCode or WSL/Cadence. Its runner prints the selected tests. `check:public-source` builds to its own `.local/public-source-check` directory. Neither command installs a desktop build.

`npm test` retains the development workspace's broader tests. Some currently require private reviewed fixtures or pinned native integration resources and are not the public CI entry point. `.integration.mjs`, native helper, real provider and WSL/EDA checks need their own explicit environment; do not silently substitute public synthetic results for those checks.

## Desktop runtime migration still required

The source preview is not yet a portable desktop release. In particular:

- Cloud bootstrap and several stores/clients validate a fixed development root. Replace this consistently with an installation/data-root policy while preserving path and identity checks.
- The supervisor expects OpenCode `v1.18.17` plus a guardian binary and a historical build receipt. Native command/file helpers also require a reproducible installation/build path. Do not copy someone's entire `.local` as setup.
- The real reviewed example and OA adapter rely on a private saved circuit, fixed source hashes and a personal WSL configuration. A general configurable adapter and freely redistributable sample are needed.
- Electron's binary is not downloaded by `npm ci` because scripts are disabled. When explicitly preparing a desktop environment, `node node_modules/electron/install.js` runs the locked Electron install step. This downloads Electron but does not solve the root, engine or helper requirements above.

Do not claim `npm run start:cloud` works on a clean clone until these points and a clean-machine startup have passed. Do not change a single hardcoded path and remove the remaining checks to bypass setup.

## Release preparation tools

```powershell
node tools/public-release/index.mjs plan
node tools/public-release/index.mjs audit
node --test tests/public-release.test.mjs
```

The plan records exact paths/hashes, curated documentation mappings and blockers without copying files. Export requires a new destination and the reviewed plan hash. It fails before creating that destination if a license, secret or source consistency check fails. Keep plan/evidence files outside the public source tree. Review the generated manifest and staged files again before uploading.
