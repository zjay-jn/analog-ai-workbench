# Third-party components and source provenance

The root MIT license covers this project's own code. It does not replace the licenses of dependencies, imported code or data.

## OpenCode

The current integration pins OpenCode `v1.18.17`, source commit `02546dfc2e4515a4f90aaf9ceb3890df2ac2b479` from `anomalyco/opencode`.

- Source: https://github.com/anomalyco/opencode/tree/v1.18.17
- License: https://github.com/anomalyco/opencode/blob/v1.18.17/LICENSE (MIT).
- The source tree excludes executable payloads. The Windows installer bundles this fixed upstream executable and its MIT notice. Its embedded Bun runtime reports version `1.3.14`; Bun and its linked WebKit/JavaScriptCore and other libraries retain their upstream licenses. Matching upstream notices and source/relinking references are in `tools/runtime-licenses` and are copied into the installer under `resources/app/licenses/runtime`.

## Binary installation components

The installer includes Node.js `24.20.0` with its complete `LICENSE`, and Electron `43.4.0` with `LICENSE` and `LICENSES.chromium.html`. Installed npm packages' available license/notice texts accompany the bundled JavaScript. Development-only packages may appear in that notice collection without being linked into the installed program.

NSIS `3.13` is a build tool. Its compiler and SDK are not installed on the user's computer. The installer/uninstaller include NSIS runtime stubs and compression code; their upstream `COPYING` is included. Source and license information: https://nsis.sourceforge.io/License and https://sourceforge.net/projects/nsis/files/NSIS%203/3.13/ .

## JavaScript dependencies

Exact versions and npm package integrity hashes are in `package-lock.json`. Electron, React, Vite, TypeScript, CodeMirror and Ajv retain their own licenses. Transitive dependency licenses must be reviewed too; not every dependency uses MIT. `lightningcss` is one dependency recorded under MPL-2.0. The [lockfile-derived inventory](docs/DEPENDENCY_LICENSES.json) lists all 78 locked packages and their declared licenses. Regenerate it with `npm run licenses:inventory` when the lockfile changes. Metadata is an inventory aid, not a substitute for the license texts required by an eventual binary bundle.

## Cleared project-owned display code and synthetic samples

The two adapted display modules, `packages/schematic-workbench/src/folded-adapter.ts` and `packages/schematic-workbench/src/viewer/reviewed-port-display.ts`, originate from the team's Analog AI Lab viewer. On 2026-11-03 the project owner explicitly confirmed that the owner/team holds the copyright and authorized these modules and the existing internal synthetic samples for public redistribution under MIT. See the exact scope in [SOURCE_PERMISSIONS](docs/SOURCE_PERMISSIONS.md).

The cloud-demo schematic and the approved synthetic Agent event manifest now declare MIT in accordance with that grant. The earlier internal/test-only labels are superseded for these named synthetic assets. Original provenance and upstream attribution remain recorded; the grant does not extend to real circuit data.

Real reviewed circuit payloads, OA/PDK/model/license files, simulation data and user content are excluded. Access to those assets does not establish redistribution rights.
