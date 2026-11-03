import type { SchematicReference } from '../schematic/reviewed-schematic';
/** Saved OA observation and facts; this module grants no filesystem or process access. */
export const OA_SNAPSHOT_SCHEMA = 'aaw.oa-saved-read.snapshot.v1' as const;
export const OA_READ_LIMITS = Object.freeze({
  wireBytes: 2 * 1024 * 1024, snapshots: 2, objects: 20000,
  requestBytes: 16384, idBytes: 256, nameBytes: 4096, valueBytes: 256 * 1024,
  cursorBytes: 1024, toolResultBytes: 12288, pageItems: 100,
});
export const OA_READ_TOOL_NAMES = Object.freeze([
  'oa_open_design', 'oa_inspect_design', 'oa_query_instances', 'oa_query_nets', 'oa_describe_device',
] as const);
export type OaReadCode = 'INVALID_REQUEST' | 'NOT_BOUND' | 'SOURCE_CHANGED' | 'CURSOR_STALE'
  | 'SCOPE_LIMIT' | 'BUSY' | 'CANCELLED' | 'OA_UNAVAILABLE' | 'OA_SNAPSHOT_UNPROVEN'
  | 'OA_OBJECT_NOT_FOUND' | 'OA_UNSUPPORTED';
export type OaLcv = Readonly<{ library: string; cell: string; view: string }>;
export type OaCollectionStatus = 'complete' | 'partial' | 'unsupported';
export type OaSourceCoverage = Readonly<{
  instances: OaCollectionStatus; nets: OaCollectionStatus; ports: OaCollectionStatus;
  parameters: OaCollectionStatus; terminals: OaCollectionStatus; netMembers: OaCollectionStatus;
  hierarchy: 'not_read'; masterContents: 'not_read'; cdf: 'not_read';
}>;
export type OaFileObservation = Readonly<{ relativePath: string; bytes: number; sha256: string }>;
export type OaSourceObservation = Readonly<{
  beforeDigest: string; afterDigest: string; copiedDigest: string;
  state: 'observed_unchanged'; transactionLock: false;
}>;
export type OaEnvelopeSource = Readonly<{
  sourceKind: 'saved_oa'; environmentBindingId: string; libraryMappingIdentity: string; lcv: OaLcv;
  capturedAt: string; readMode: 'fresh_process_read_only'; savedRevision: string;
  revisionMethod: 'copied-file-manifest-sha256-v1'; sourceObservation: OaSourceObservation;
  files: readonly OaFileObservation[]; dirty: Readonly<{ status: 'unknown'; reason: 'not_observed' }>;
}>;
export type OaParameter = Readonly<{ name: string; valueType: string; valueText: string }>;
export type OaTerminal = Readonly<{ id: string; name: string | null; role: 'unknown'; netId: string | null }>;
export type OaInstance = Readonly<{
  id: string; name: string; master: OaLcv; parameters: readonly OaParameter[]; terminals: readonly OaTerminal[];
}>;
export type OaNetMember = Readonly<{ kind: 'instance_terminal'; instanceId: string; terminalId: string }>
  | Readonly<{ kind: 'port'; portId: string }>;
export type OaNet = Readonly<{ id: string; name: string | null; members: readonly OaNetMember[] }>;
export type OaPort = Readonly<{ id: string; name: string | null; direction: string | null; netId: string | null }>;
export type OaFacts = Readonly<{ instances: readonly OaInstance[]; nets: readonly OaNet[]; ports: readonly OaPort[] }>;
export type OaSnapshotMetadata = Readonly<{
  adapterVersion: string; parameterEncoding: 'skill_stored_value_serialization'; coverage: OaSourceCoverage;
}>;
export type OaSnapshotEnvelope = Readonly<{
  schema: typeof OA_SNAPSHOT_SCHEMA; requestId: string; source: OaEnvelopeSource;
  metadata: OaSnapshotMetadata; facts: OaFacts;
}>;
export type OaDesignDescriptor = Readonly<{
  designId: string; displayName: string; environmentBindingId: string; libraryMappingIdentity: string; lcv: OaLcv;
}>;
export type OaSavedSource = Omit<OaEnvelopeSource, 'files'> & Readonly<{
  designId: string; adapterVersion: string; freshness: 'captured_snapshot';
}>;
export type OaRunBinding = Readonly<{
  runId: string; projectId: string; bindingId: string; projectIdentity: string;
  designId: string; designHandle: string;
}>;
export type OaRunRef = OaSavedSource & OaRunBinding & Readonly<{ snapshotId: string; factsDigest: string }>;
type OaObjectBinding = Readonly<{
  designHandle: string; savedRevision: string; snapshotId: string;
  objectId: string;
}>;
export type OaObjectRef = OaObjectBinding & (Readonly<{ kind: 'instance' | 'net' | 'port' }>
  | Readonly<{ kind: 'terminal'; instanceId: string }>);
export type OaBound = Readonly<{ designHandle: string; savedRevision: string }>;
export type OaSelector = Readonly<{ kind: 'all' }> | Readonly<{ kind: 'id'; objectId: string }>
  | Readonly<{ kind: 'exact_name'; name: string }>;
export type OaReadToolArguments = {
  oa_open_design: Readonly<{ designId: string; refresh: boolean }>;
  oa_inspect_design: OaBound;
  oa_query_instances: OaBound & Readonly<{ selector: OaSelector; cursor: string | null }>;
  oa_query_nets: OaBound & Readonly<{ selector: OaSelector; section: 'summary' | 'members'; cursor: string | null }>;
  oa_describe_device: OaBound & Readonly<{ instanceId: string; section: 'parameters' | 'terminals'; cursor: string | null }>;
};
export type OaReadToolName = keyof OaReadToolArguments;
export type OaReadQuery = { [K in OaReadToolName]: Readonly<{ toolName: K; arguments: OaReadToolArguments[K] }> }[OaReadToolName];
export type OaCoverage = Readonly<{
  collection: 'design' | 'instances' | 'nets' | 'net_members' | 'device_parameters' | 'device_terminals';
  selector: OaSelector; sourceStatus: OaCollectionStatus; returned: number; examined: number;
  observedTotal: number; total: number | null; complete: boolean; nextCursor: string | null;
  limitReason: 'page' | 'bytes' | 'source_partial' | 'unsupported' | null;
  fieldUnknown: number; fieldUnsupported: number;
  excludedScopes: readonly ['hierarchy', 'master_contents', 'effective_cdf', 'device_semantic_roles'];
}>;
export type OaInstanceSummary = Readonly<{
  id: string; name: string; master: OaLcv;
  parameters: Readonly<{ status: OaCollectionStatus; observedCount: number }>;
  terminals: Readonly<{ status: OaCollectionStatus; observedCount: number }>;
}>;
export type OaNetSummary = Readonly<{
  id: string; name: string | null; membersStatus: OaCollectionStatus; observedMemberCount: number; memberCount: number | null;
}>;
export type OaMemberDetail = Readonly<{ kind: 'instance_terminal'; instanceId: string; instanceName: string; terminal: OaTerminal }>
  | Readonly<{ kind: 'port'; port: OaPort }>;
export type OaReadData = Readonly<{ kind: 'design'; coverage: OaSourceCoverage;
  observedCounts: Readonly<{ instances: number; nets: number; ports: number }>;
  parameterEncoding: 'skill_stored_value_serialization' }>
  | Readonly<{ kind: 'instances'; items: readonly OaInstanceSummary[] }>
  | Readonly<{ kind: 'nets'; items: readonly OaNetSummary[] }>
  | Readonly<{ kind: 'net_members'; netId: string; items: readonly OaMemberDetail[] }>
  | Readonly<{ kind: 'device_parameters'; instanceId: string; encoding: 'skill_stored_value_serialization'; items: readonly OaParameter[] }>
  | Readonly<{ kind: 'device_terminals'; instanceId: string; items: readonly OaTerminal[] }>;
export type OaReadToolValue = Readonly<{
  kind: 'oa_read'; source: OaRunRef; evidenceId: string; resultDigest: string; coverage: OaCoverage; data: OaReadData;
  /** Present only when main has proven the saved source and object correspondence. */
  displayReferences?: readonly Readonly<{ label: string; objectRef: OaObjectRef; reference: SchematicReference }>[];
}>;
export type OaReadToolResult = Readonly<{ ok: true; value: OaReadToolValue }>
  | Readonly<{ ok: false; error: Readonly<{ code: OaReadCode }>; coverage: null }>;
/** Host persists this bounded page before passing it to the existing provider loop. */
export type OaReadEvidence = Readonly<{
  runId: string; callId: string; query: OaReadQuery; value: OaReadToolValue;
}>;
