# Roadmap

The product focus is circuit interaction. OpenCode remains responsible for the generic Agent lifecycle.

| Priority | Outcome | Acceptance evidence |
| --- | --- | --- |
| P0 | Public source provenance and reproducible source checks | Cleared manifests, no private assets, clean independent build and offline core CI |
| P0 | Portable desktop startup | Configurable installation/data roots; pinned engine and helper setup; clean Windows launch |
| P1 | Redistributable circuit query example | Synthetic example, independent connectivity facts, answer↔schematic location checks |
| P1 | Selectable real project adapter | Explicit user-selected source, version identity, configurable WSL/EDA integration, no private defaults |
| P2 | Controlled circuit modifications | Reviewable change plan, isolated copy, validated connectivity, explicit save and recovery evidence |

Command execution and diagnostic recording have been exercised in the internal environment. Real circuit querying currently covers one historical saved copy. These observations do not establish arbitrary-project support, live GUI synchronization or editing capability.
