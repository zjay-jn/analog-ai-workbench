import { parseSumArguments, parseSumValue, type SumValue } from '../../shared/agent/engine-pilot';
export const PILOT_SUM_SCHEMA = Object.freeze({ name:'pilot.sum.v1', description:'Deterministic sum of bounded integers; no external state.', inputSchema:{ type:'object', properties:{ values:{ type:'array', minItems:1, maxItems:32, items:{ type:'integer', minimum:-1000000, maximum:1000000 } } }, required:['values'], additionalProperties:false } });
export function executePilotSum(value: unknown): SumValue {
  const args=parseSumArguments(value);
  return parseSumValue({ sum:args.values.reduce((a,b)=>a+b,0), count:args.values.length, source:'deterministic-local', toolVersion:'pilot.sum.v1' });
}
