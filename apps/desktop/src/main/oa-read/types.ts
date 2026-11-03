import type { OaLcv, OaReadCode, OaSnapshotEnvelope } from '../../shared/agent/oa-read';

/** Main registry and capture owner supply this identity, never the model or reader.il. */
export type OaCaptureBinding = Readonly<{
  requestId: string; designId: string; environmentBindingId: string; libraryMappingIdentity: string;
  lcv: OaLcv; adapterVersion: string; allowedFiles: readonly string[];
}>;
export type OaSnapshot = Readonly<{
  snapshotId: string; designId: string; factsDigest: string; envelope: OaSnapshotEnvelope;
}>;
export class OaReadError extends Error {
  constructor(readonly code: OaReadCode) { super(code); this.name = 'OaReadError'; }
}
export function oaFail(code: OaReadCode): never { throw new OaReadError(code); }
