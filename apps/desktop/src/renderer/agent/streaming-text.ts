const graphemes=new Intl.Segmenter(undefined,{granularity:'grapheme'});
/** Reveal a prefix of received text; never fabricate text or split a grapheme. */
export function advanceStreamingText(shown:string,target:string,elapsedMs:number):string{
 if(!target.startsWith(shown))return target;
 const remaining=target.slice(shown.length);if(!remaining)return target;
 const count=Math.max(1,Math.ceil((60+remaining.length*5)*Math.max(1,Math.min(50,elapsedMs))/1000));
 let end=0,n=0;for(const part of graphemes.segment(remaining)){end=part.index+part.segment.length;if(++n>=count)break;}
 return shown+remaining.slice(0,end);
}
