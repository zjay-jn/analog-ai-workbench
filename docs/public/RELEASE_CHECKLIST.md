# Source release checklist

Release target: `0.1.0-alpha.0` source preview. A checklist entry is complete only when its evidence exists.

- [x] Confirm public rights for imported Lab display code and internal synthetic fixture manifests. Owner confirmation recorded on 2026-11-03 in SOURCE_PERMISSIONS.md; manifests/schema updated to MIT.
- [ ] Produce a blocker-free public-source plan; review every included path and documentation mapping.
- [ ] Scan the exact included bytes for secrets; review synthetic-test exceptions by exact content hash. Do not assume a test directory is safe.
- [ ] Review lockfile license inventory and retain notices. Do not bundle an unreviewed runtime executable.
- [ ] Create a fresh export with an exact reviewed plan hash; verify its manifest hashes, absence of symlinks and excluded private state.
- [ ] From an independent dependency install, run typecheck, public core tests, static security checks and isolated builds. Record any untested install/network step.
- [ ] Review README limitations against actual public-source behavior. Do not advertise a turnkey desktop before portable startup passes.
- [ ] Choose GitHub owner, repository name and initial visibility. Enable private vulnerability reporting and normal repository protections.
- [ ] Initialize/review a new Git history for the curated export; inspect staged paths and run the scan again. Never stage the internal workspace wholesale.
- [ ] Push only the reviewed tree, verify the remote file listing and CI results, then decide on public visibility and a source release tag.

The export tool does not create a repository, commit, push, upload data or grant redistribution rights. Those actions remain separate explicit steps.
