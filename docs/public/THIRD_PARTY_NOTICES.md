# Third-party components and source provenance

The root MIT license covers this project's own code. It does not replace the licenses of dependencies, imported code or data.

## OpenCode

The current integration pins OpenCode `v1.18.17`, source commit `02546dfc2e4515a4f90aaf9ceb3890df2ac2b479` from `anomalyco/opencode`.

- Source: https://github.com/anomalyco/opencode/tree/v1.18.17
- License: https://github.com/anomalyco/opencode/blob/v1.18.17/LICENSE (MIT).
- This source preview does not bundle the OpenCode executable. Preserve its upstream notices when preparing a binary distribution; this file is not a complete inventory of that executable's bundled components.

## JavaScript dependencies

Exact versions and npm package integrity hashes are in `package-lock.json`. Electron, React, Vite, TypeScript, CodeMirror and Ajv retain their own licenses. Transitive dependency licenses must be reviewed too; not every dependency uses MIT. `lightningcss` is one dependency recorded under MPL-2.0. The [lockfile-derived inventory](docs/DEPENDENCY_LICENSES.json) lists all 78 locked packages and their declared licenses. Regenerate it with `npm run licenses:inventory` when the lockfile changes. Metadata is an inventory aid, not a substitute for the license texts required by an eventual binary bundle.

## Cleared project-owned display code and synthetic samples

The two adapted display modules, `packages/schematic-workbench/src/folded-adapter.ts` and `packages/schematic-workbench/src/viewer/reviewed-port-display.ts`, originate from the team's Analog AI Lab viewer. On 2026-11-03 the project owner explicitly confirmed that the owner/team holds the copyright and authorized these modules and the existing internal synthetic samples for public redistribution under MIT. See the exact scope in [SOURCE_PERMISSIONS](docs/SOURCE_PERMISSIONS.md).

The cloud-demo schematic and the approved synthetic Agent event manifest now declare MIT in accordance with that grant. The earlier internal/test-only labels are superseded for these named synthetic assets. Original provenance and upstream attribution remain recorded; the grant does not extend to real circuit data.

Real reviewed circuit payloads, OA/PDK/model/license files, simulation data and user content are excluded. Access to those assets does not establish redistribution rights.
