# Architecture

Analog AI Workbench separates three responsibilities:

1. OpenCode manages Agent sessions, model/tool progression, history and compaction.
2. Electron main validates capabilities, project identities, filesystem boundaries, command receipts and circuit facts.
3. The React renderer presents chat, execution summaries, documents and schematics through narrow typed preload APIs.

The renderer cannot invoke a raw shell or arbitrary filesystem path. A tool request reaches a broker/adapter, receives an execution identity and validated result, and is projected into the chat. Command launch acknowledgement and confirmed process completion remain distinct. Diagnostics preserve the original failure separately from cleanup failures.

Schematic references bind an object to a reviewed document/version. Geometry is display evidence; electrical membership comes from structured source facts. Unknown names, terminal roles and anchors stay unknown. Selecting a circuit object or highlighting it does not edit or save the circuit.

Public synthetic samples demonstrate contracts without private EDA assets. The existing real OA adapter was verified against one historical local copy; its environment configuration and broader project support remain separate integration work.
