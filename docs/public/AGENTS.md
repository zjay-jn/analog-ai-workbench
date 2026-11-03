# Development instructions

- Read README.md and docs/DEVELOPMENT.md before changing the project. Use the versions in package.json and the lockfile.
- OpenCode owns the Agent loop, persistent history and compaction. Keep circuit facts, capabilities and presentation in explicit adapters; do not introduce a second loop or arbitrary conversation caps.
- Renderer has no Node, filesystem or shell access. Validate callers, inputs, identities and path boundaries in main through narrow typed preload APIs.
- Reviewed schematics are read-only. Display geometry does not establish electrical connectivity or an unknown terminal role.
- Keep sources and evidence separate. Never commit .local, node_modules, dist, credentials, chats, real circuits, PDKs, model data or simulation results.
- Use synthetic fixtures for default checks. Real APIs, WSL/Cadence and private project integrations require explicitly configured environments and are not part of the public core suite.
- Preserve other contributors' work. Use apply_patch for text edits. Run the checks appropriate to the change; report the exact tested scope and remaining limitations.
- Record third-party provenance and permission before importing code or data. Do not infer redistribution rights from access to an internal asset.
- Do not commit, push, tag, create a remote or publish unless the user asks for that action.
