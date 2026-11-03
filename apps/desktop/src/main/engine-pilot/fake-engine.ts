import { randomUUID } from 'node:crypto';
import type { PilotEngine, EngineCallbacks } from './engine';
type Pending = { sessionId:string; questionId:string; callbacks:EngineCallbacks; resolve:()=>void; reject:(error:Error)=>void; remove:()=>void };
/** Deterministic protocol fixture. It does not call a model or interpret a goal as code. */
export function createFakePilotEngine(scenario:'sum'|'question'|'failure'|'stall'='question'):PilotEngine {
  const pending=new Map<string,Pending>();let disposed=false;
  function stop(runId:string):void {const run=pending.get(runId);if(run){pending.delete(runId);run.remove();run.reject(new Error('Fake pilot stopped'));}}
  async function complete(runId:string,step:number):Promise<void> {
    const run=pending.get(runId);if(!run)return;
    try {
      run.callbacks.notice({type:'step',step,usage:null});
      const result=await run.callbacks.tool({sessionId:run.sessionId,callId:`call.${randomUUID()}`,toolName:'pilot.sum.v1',arguments:{values:[1,2,3]}});
      if(pending.get(runId)!==run)return;
      run.callbacks.notice({type:'step',step:step+1,usage:null});
      run.callbacks.notice({type:'text',text:`本地模拟引擎：固定演示 1 + 2 + 3，工具实际返回 ${result.sum}。这不是模型回答，也没有读取文件。`});
      run.callbacks.notice({type:'completed'});
      pending.delete(runId);run.remove();run.resolve();
    }catch(error){if(pending.get(runId)===run){run.callbacks.notice({type:'failed'});pending.delete(runId);run.remove();run.reject(error instanceof Error?error:new Error('Fake pilot failed'));}}
  }
  return {
    kind:'fake',version:'fake-protocol-1',health:async()=>!disposed,
    start(input) {
      if(disposed||input.signal.aborted||pending.size)return Promise.reject(new Error('Fake pilot unavailable'));
      return new Promise<void>((resolve,reject)=>{
        const onAbort=()=>stop(input.runId),run:Pending={sessionId:`fake.${randomUUID()}`,questionId:`question.${randomUUID()}`,callbacks:input.callbacks,resolve,reject,remove:()=>input.signal.removeEventListener('abort',onAbort)};
        pending.set(input.runId,run);input.signal.addEventListener('abort',onAbort,{once:true});
        input.callbacks.notice({type:'started',sessionId:run.sessionId});
        if(scenario==='failure'){input.callbacks.notice({type:'failed'});return;}
        if(scenario==='stall')return;
        if(scenario==='question') {input.callbacks.notice({type:'step',step:1,usage:null});input.callbacks.notice({type:'question',questionId:run.questionId,prompt:'这是本地模拟工具演示，将计算固定的 1 + 2 + 3。请输入一条补充说明后继续；不会调用真实模型。'});}
        else void complete(input.runId,1);
      });
    },
    async answer(runId,questionId,_answer) { const run=pending.get(runId);if(!run||run.questionId!==questionId)throw new Error('Fake question unavailable');await complete(runId,2); },
    stop:async runId=>stop(runId),
    dispose(){disposed=true;for(const id of [...pending.keys()])stop(id);},
  };
}
