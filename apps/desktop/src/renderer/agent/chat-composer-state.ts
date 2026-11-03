export function clearAcceptedDraft(current:Readonly<{text:string;revision:number}>,submittedRevision:number):Readonly<{text:string;revision:number}> {
  return current.revision===submittedRevision?{text:'',revision:current.revision+1}:current;
}
export function isChatNearBottom(scrollTop:number,clientHeight:number,scrollHeight:number):boolean {return scrollHeight-scrollTop-clientHeight<=64;}
