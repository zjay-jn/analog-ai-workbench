# Security

The alpha is under active development; no stable release support window is promised yet.

Report a vulnerability through the repository's GitHub **Security → Report a vulnerability** entry when private reporting is enabled. If that entry is unavailable, open a public issue that only requests a private reporting channel, without exploit details or sensitive data. The maintainers must enable a private channel before a public release.

Useful reports identify the version/commit, affected boundary and a minimal synthetic reproduction. Redact credentials, chats, project content and personal paths. Do not upload a complete `.local` directory or private EDA data.

Relevant boundaries include renderer/preload/main, project directory traversal and links, tool result validation, process ownership/cleanup, credential storage and circuit reference identity. A successful build or core test run is not a complete security audit.
