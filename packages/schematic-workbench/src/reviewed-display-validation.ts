import {validateReviewedCircuitIrV1} from './reviewed-circuit-ir';
import type {ReviewedSchematicEnvelope} from './reviewed-display';
import {boundReviewedJson,reviewedBad,reviewedCanonical,reviewedExact,reviewedSha256} from './reviewed-json';

export const FOLDED_ADAPTED_DIGEST='098a4eec59b22dee954816a4b49440eee18d8370b5d54413a428d7d146c67b30';
export const FOLDED_REVIEWED_SOURCE_DIGEST='fd2b44561caf36d811f88dafa7bcaa305e79d7583afa28c7960a94ae6463fcac';
const admitted=new WeakSet<object>();
function freeze(value:unknown):void{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}}
/** Exact cryptographic content profile also closes all nested display fields. No caller-supplied digest is an admission pin. */
export function validateReviewedSchematicEnvelope(value:unknown):ReviewedSchematicEnvelope{
  if(value&&typeof value==='object'&&admitted.has(value))return value as ReviewedSchematicEnvelope;
  boundReviewedJson(value);const root=reviewedExact(value,['reviewedCircuitIr','display']);
  const display=reviewedExact(root.display,['contractVersion','documentRef','artifactRef','sourceDigest','adaptedDigest','definitionId','source','transform','glyphRevision','counts','devices','terminals','ports','nets','labels','displayOrder','primitives','instanceBounds']);
  if(display.adaptedDigest!==FOLDED_ADAPTED_DIGEST||display.sourceDigest!==FOLDED_REVIEWED_SOURCE_DIGEST)reviewedBad();
  const {adaptedDigest:_,...without}=display;
  if(reviewedSha256(reviewedCanonical({reviewedCircuitIr:root.reviewedCircuitIr,display:without}))!==FOLDED_ADAPTED_DIGEST)reviewedBad();
  validateReviewedCircuitIrV1(root.reviewedCircuitIr);
  const result=JSON.parse(JSON.stringify(value)) as ReviewedSchematicEnvelope;freeze(result);admitted.add(result);return result;
}
