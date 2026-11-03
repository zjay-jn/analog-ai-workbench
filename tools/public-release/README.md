# Public source preparation

This tool prepares an exact candidate inventory without staging, committing,
publishing, invoking models, running WSL, or opening excluded private data.
`plan` is the default and is read-only. `audit` also returns exit code 1 when
blocked. Plans contain file hashes and rule/path/line findings, never matched
credential text. This bounded heuristic scan is not a full secret audit.

```powershell
node tools/public-release/index.mjs plan
node tools/public-release/index.mjs audit
node --test tests/public-release.test.mjs
```

`policy.json` selects root files and source trees, permits only listed text
extensions, rejects links, binary content, unknown extensions and overlarge
files, and excludes generated/private paths before opening them. Public root
documents come from `docs/public/`; the working README, AGENTS and internal docs
are never copied. The selected public templates also remain at `docs/public/`
in the export, so a plan can be audited again from that copy with the same hash.
Additional public documentation and the CI workflow are explicitly listed.
All listed public documents, including the dependency license inventory, are
required: omitting one blocks export. These `docs/public/` files are templates
for their exported locations; links in root-document templates use repository
root context. Read the exported root documents for their normal navigation.
Sensitive payload names or binary/private file extensions inside selected source
trees block the export as well as being excluded; their absence is not silently
treated as a complete runnable source tree.

An export needs an absolute, nonexistent destination outside the source tree,
an existing parent without symlink/junction ancestors, a matching plan hash,
and zero blockers. Every source hash is checked again before the destination
is created; copied bytes are verified. Existing files are never overwritten.
Unexpected write failures may leave a partial new directory for inspection;
the tool does not recursively delete it or claim success.

```powershell
node tools/public-release/index.mjs export --destination C:\path\to\new-directory --plan-sha256 <reviewed-plan-hash>
```

The policy blocks unresolved source grants; there is no command-line bypass.
On 2026-11-03 the project owner confirmed copyright ownership and authorized
the two named Lab-derived display modules and internal synthetic fixtures under
MIT. The exact scope is recorded in the required public SOURCE_PERMISSIONS.md
and in the policy's resolvedRights entries. Fixture manifests and the matching
schema are updated to reflect that grant. Real circuit and private runtime data
remain excluded. A future unresolved source needs its own documented permission
or replacement; changing a license label alone does not establish ownership.

Heuristic secret findings are blockers even under `tests/`. A false positive
can only be recorded as an explicit `secretExceptions` entry tied to the entire
file SHA-256, rule, exact match count, a reason and a review reference. Any file
change invalidates that exception. Never put credential values in an exception.

## Synthetic token review 2026-11-03

The initial review found 51 model-token-shaped literals across 25 test files.
Each was reviewed through redacted surrounding test code and test-owned data
flow. These are static synthetic markers injected through fake providers,
credential callbacks, simulated events, or assertions, rather than values read
from a user credential source. The credential-file test writes its own fake
marker into a temporary fixture before reading it. The independent security
test uses test-local constants and fake transport; the client event test uses
an explicitly labelled synthetic private-content sentinel. The policy records
each file hash, finding count and its review basis. This is an exact exception
set, not a rule exempting all tests. Altering one of these files restores its
findings until reviewed again. The report exposes only metadata and a hash of
the review reference, never exception prose that could accidentally quote a key.

Export readiness only covers inventory, byte integrity and these checks. It
does not prove that a clean clone installs, compiles or runs. Reproducible setup,
dependency notices, default tests, and optional EDA integrations need separate
verification before publishing to GitHub.
