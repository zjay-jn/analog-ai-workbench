import {decodeAndHashStrictSourceFrameV1} from './strict-source-frame';
import {validateReviewedCircuitIrV1} from './reviewed-circuit-ir';
import {sha256CanonicalAawJsonV1} from './canonical-json';
import {createReviewedIdentityRegistryV1,parseReviewedDocumentRefV1,parseReviewedArtifactRefV1} from '../../document-contract/src/reviewed-identity';

export const CLOUD_DEMO_RAW_MAX_BYTES=64*1024;
export const CLOUD_DEMO_MANIFEST_MAX_BYTES=16*1024;
export const CLOUD_DEMO_MANIFEST_SHA256='sha256:6603bb05962bceecd11ab2d0539059ec49124ac2aff63a9400f6ddc448abfd1b';
export const CLOUD_DEMO_RAW_SHA256='sha256:7799af98416e2a340d045eb6a0b68a42e0fe2a371ef7b8a07588590cb8a3e3c9';
export const CLOUD_DEMO_CANONICAL_SHA256='sha256:13428144e3e4cb7aa415883b2e2f2605c1aaac1af9f7cbbb5cb704b178b1b3c5';

/** Separate fixed profile: the P3 manifest/registry and its immutable revisions never change. */
export function admitCloudDemo(manifestRawFrame:Uint8Array,fixtureRawFrame:Uint8Array){
  const manifest=decodeAndHashStrictSourceFrameV1(manifestRawFrame,{maxBytes:CLOUD_DEMO_MANIFEST_MAX_BYTES,allowedTopLevelKeys:['schemaVersion','fixtureId','documentRef','artifactRef','byteLength','rawSha256','payloadDigest','provenance','license','oracle']});
  if(manifest.byteLength!==1017||manifest.rawSha256!==CLOUD_DEMO_MANIFEST_SHA256||manifest.decoded.license!=='MIT')throw new Error('Synthetic admission unavailable');
  const raw=decodeAndHashStrictSourceFrameV1(fixtureRawFrame,{maxBytes:CLOUD_DEMO_RAW_MAX_BYTES,allowedTopLevelKeys:['schemaVersion','canonicalizationVersion','coordinateUnit','bounds','rootDefinitionId','definitions']});
  if(raw.byteLength!==2626||raw.rawSha256!==CLOUD_DEMO_RAW_SHA256||raw.rawSha256!==manifest.decoded.rawSha256)throw new Error('Synthetic admission unavailable');
  const circuitIr=validateReviewedCircuitIrV1(raw.decoded),payloadDigest=sha256CanonicalAawJsonV1(circuitIr);
  if(payloadDigest!==CLOUD_DEMO_CANONICAL_SHA256||payloadDigest!==manifest.decoded.payloadDigest)throw new Error('Synthetic admission unavailable');
  // The strict decoder deliberately uses null-prototype records. Only after the exact
  // manifest pin succeeds, structured clone materializes plain identity DTOs.
  const documentRef=parseReviewedDocumentRefV1(structuredClone(manifest.decoded.documentRef)),artifactRef=parseReviewedArtifactRefV1(structuredClone(manifest.decoded.artifactRef));
  const identityRegistry=createReviewedIdentityRegistryV1();
  identityRegistry.admitBinding({documentRef,artifactRef,freshness:'current'});
  return Object.freeze({documentRef,artifactRef,freshness:'current' as const,circuitIr,payloadDigest,dirty:false as const,receipt:Object.freeze({receiptClass:'synthetic_fixture_admission',issuerId:'aaw.main.cloud-demo/v1',receiptId:'receipt.synthetic.cloud-demo.v1',fixtureManifestDigest:manifest.rawSha256,payloadDigest,documentRef,artifactRef})});
}
