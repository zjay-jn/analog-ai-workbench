# Source permissions

## MIT public grant recorded on 2026-11-03

The project owner explicitly confirmed ownership by the owner or their team and authorized public redistribution under MIT in response to a question naming the Lab-derived display modules and existing internal synthetic samples:

> 确认拥有版权，允许这些代码和合成样例按 MIT 公开

This updates the earlier internal-use scope for the following project-owned code and hand-authored synthetic assets. The root [MIT license](../LICENSE) applies to these assets.

| Asset | Covered scope |
| --- | --- |
| `packages/schematic-workbench/src/folded-adapter.ts` | The Lab-derived display adaptation in this repository, including its normalized display routines |
| `packages/schematic-workbench/src/viewer/reviewed-port-display.ts` | The Lab-derived port/text display adaptation in this repository |
| `packages/schematic-workbench/fixtures/cloud-demo.manifest.json` and `cloud-demo.json` in that directory | The hand-authored synthetic cloud schematic and its manifest |
| `packages/agent-adapters/fixtures/approved-synthetic-agent-fixtures.manifest.json` and the source-event files referenced by its nine entries under `fixtures/source-events/` | The existing hand-authored synthetic Agent events and manifest |

The two formerly internal fixture manifest declarations and the corresponding schema are updated to MIT. Payload identity, synthetic event meaning and circuit connectivity do not change. Other fixtures retain their own existing license declarations.

## Excluded assets and third parties

This grant does not publish real circuit payloads, OA libraries, PDKs, device models, license files, simulation results, user chats, credentials, local captures or other private project material. Private directories are excluded from the public export.

OpenCode and npm dependencies retain their own licenses and notices; see [THIRD_PARTY_NOTICES](../THIRD_PARTY_NOTICES.md). No OpenCode, Electron or native helper executable is bundled in this source preview. New third-party imports need their own provenance and permission rather than inheriting this declaration.
