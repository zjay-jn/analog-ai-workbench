# Contributing

This is an early source preview. Before a large implementation, describe the concrete user behavior and proposed scope in an issue or draft change.

Use the locked Node/npm versions and follow [DEVELOPMENT](docs/DEVELOPMENT.md). Keep the lockfile when installing dependencies. Avoid unrelated formatting and dependency updates.

Useful contributions include portable installation, synthetic circuit examples, circuit query contracts, clear execution presentation and reproducible bug reports. Keep OpenCode responsible for the Agent lifecycle; circuit-specific capabilities belong in adapters.

For a pull request, explain what changes for the user, why it changes, which checks ran and what remains unverified. Use synthetic data for reproduction. Never attach API keys, personal chats, customer circuits, PDK/model files or raw private logs.

New code must have a source and redistribution permission compatible with its declared license. Keep upstream notices. New fixture manifests must state their own license rather than relying on the repository's root license to override an internal-use declaration.

For security problems, follow [SECURITY](SECURITY.md) instead of posting private data in a public issue.
