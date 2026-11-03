import type {ReviewedDisplayV1,ReviewedGeometry} from '../reviewed-display';

export const REVIEWED_TEXT_LAYOUT_VERSION='aaw.reviewed-text-layout/v1' as const;
export const REVIEWED_TEXT_LINE_WORLD=14;
export const REVIEWED_TEXT_MAX_SHIFT_WORLD=42;
export const REVIEWED_TEXT_MAX_NUDGE_WORLD=24;
type TextGeometry=Extract<ReviewedGeometry,{tag:'text'}>;
export type ReviewedTextWorldBox=Readonly<{minX:number;minY:number;maxX:number;maxY:number}>;

/** Conservative collision envelope for 10-world-unit text, which scales together with the reviewed drawing. Fit measures the actual rendered DOM. */
export function reviewedTextWorldBox(text:TextGeometry):ReviewedTextWorldBox{
  const width=Array.from(text.text).reduce((sum,char)=>sum+(/[MW@]/u.test(char)?10:/[A-Z]/u.test(char)?7.5:/[0-9]/u.test(char)?6.5:/[ .,:;|!"'`]/u.test(char)?3.5:/[^\x00-\x7f]/u.test(char)?10:6),0);
  const anchor=text.position,left=text.anchor==='end'?-width:text.anchor==='middle'?-width/2:0;
  const angle=text.rotation*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle);
  const corners=[[left-2,-11],[left+width+2,-11],[left-2,5],[left+width+2,5]].map(([x,y])=>({x:anchor.x+x!*c-y!*s,y:anchor.y+x!*s+y!*c}));
  return {minX:Math.min(...corners.map(p=>p.x)),maxX:Math.max(...corners.map(p=>p.x)),minY:Math.min(...corners.map(p=>p.y)),maxY:Math.max(...corners.map(p=>p.y))};
}
function overlap(a:ReviewedTextWorldBox,b:ReviewedTextWorldBox):number{return Math.max(0,Math.min(a.maxX,b.maxX)-Math.max(a.minX,b.minX))*Math.max(0,Math.min(a.maxY,b.maxY)-Math.max(a.minY,b.minY));}

/** View-only placement. Source labels and all electrical/source geometry keep their exact positions and identities. */
export function layoutReviewedDisplayText(display:ReviewedDisplayV1,primitives:readonly ReviewedGeometry[]=display.primitives):readonly ReviewedGeometry[]{
  const mosIds=new Set(display.devices.filter(d=>d.displayKind==='pmos'||d.displayKind==='nmos').map(d=>d.id));
  const generated=(p:ReviewedGeometry):p is TextGeometry=>p.tag==='text'&&p.sourceKind==='instance'&&mosIds.has(p.sourceId);
  const sourceBoxes=primitives.filter((p):p is TextGeometry=>p.tag==='text'&&!generated(p)).map(reviewedTextWorldBox);
  const placedBoxes:ReviewedTextWorldBox[]=[];
  const replacement=new Map<string,TextGeometry>();
  const groups=display.devices.filter(d=>mosIds.has(d.id)).map(device=>primitives.filter((p):p is TextGeometry=>generated(p)&&p.sourceId===device.id)).filter(group=>group.length);
  // The name and literal W/L summary stay together and retain their original left/right anchor.
  const rowsFor=(group:readonly TextGeometry[])=>group.map((p,index)=>({...p,position:{x:p.position.x,y:group[0]!.position.y+index*REVIEWED_TEXT_LINE_WORLD}}));
  const choose=(rows:TextGeometry[],otherBoxes:readonly ReviewedTextWorldBox[])=>{
    let best=rows,bestSourceScore=Infinity,bestPlacedScore=Infinity;
    const offsets=[0];for(let distance=2;distance<=REVIEWED_TEXT_MAX_SHIFT_WORLD;distance+=2)offsets.push(-distance,distance);
    for(const offset of offsets){
      const candidate=rows.map(p=>({...p,position:{x:p.position.x,y:p.position.y+offset}}));
      const boxes=candidate.map(reviewedTextWorldBox);
      const score=(obstacles:readonly ReviewedTextWorldBox[])=>boxes.reduce((sum,box)=>sum+obstacles.reduce((subtotal,other)=>subtotal+overlap(box,other),0),0);
      const sourceScore=score(sourceBoxes),placedScore=score(otherBoxes);
      // Existing source names take priority over convenience of generated annotation placement.
      if(sourceScore<bestSourceScore||(sourceScore===bestSourceScore&&placedScore<bestPlacedScore)){bestSourceScore=sourceScore;bestPlacedScore=placedScore;best=candidate;}
      if(sourceScore===0&&placedScore===0)break;
    }
    return best;
  };
  for(const group of groups){
    choose(rowsFor(group),placedBoxes).forEach(p=>{replacement.set(p.key,p);placedBoxes.push(reviewedTextWorldBox(p));});
  }
  // One bounded repair pass lets an earlier annotation make room for a later one; no iterative/unbounded layout solver.
  for(const group of groups){
    const otherBoxes=[...replacement.values()].filter(p=>p.sourceId!==group[0]!.sourceId).map(reviewedTextWorldBox);
    const current=group.map(p=>replacement.get(p.key)!);
    if(!current.some(p=>otherBoxes.some(other=>overlap(reviewedTextWorldBox(p),other)>0)))continue;
    choose(rowsFor(group),otherBoxes).forEach(p=>replacement.set(p.key,p));
  }
  // Only repair annotations pushed farther than their own visible symbol height.
  // A small 2-D search avoids sending a group to a remote wire just because the
  // original vertical-only candidates were crowded. No device-name exceptions.
  const symbolBoxes=new Map<string,ReviewedTextWorldBox>();
  for(const primitive of primitives){
    if(primitive.sourceKind!=='instance'||primitive.tag==='text')continue;
    const points=primitive.tag==='polyline'?primitive.points:[
      {x:primitive.center.x-primitive.radius,y:primitive.center.y-primitive.radius},
      {x:primitive.center.x+primitive.radius,y:primitive.center.y+primitive.radius},
    ];
    const box=symbolBoxes.get(primitive.sourceId)??{minX:Infinity,minY:Infinity,maxX:-Infinity,maxY:-Infinity};
    symbolBoxes.set(primitive.sourceId,{minX:Math.min(box.minX,...points.map(p=>p.x)),minY:Math.min(box.minY,...points.map(p=>p.y)),
      maxX:Math.max(box.maxX,...points.map(p=>p.x)),maxY:Math.max(box.maxY,...points.map(p=>p.y))});
  }
  const wireBoxes=primitives.flatMap(p=>p.sourceKind==='wire'&&p.tag==='polyline'?p.points.slice(1).map((b,index)=>{
    const a=p.points[index]!;return {minX:Math.min(a.x,b.x)-1,maxX:Math.max(a.x,b.x)+1,minY:Math.min(a.y,b.y)-1,maxY:Math.max(a.y,b.y)+1};
  }):[]);
  for(const group of groups){
    const body=symbolBoxes.get(group[0]!.sourceId),current=replacement.get(group[0]!.key)!;
    if(!body||Math.abs(current.position.y-group[0]!.position.y)<=body.maxY-body.minY+1e-9)continue;
    const rows=rowsFor(group),limitY=Math.min(REVIEWED_TEXT_MAX_NUDGE_WORLD,Math.floor((body.maxY-body.minY)/4)*2);
    const obstacles=[...sourceBoxes,...wireBoxes,...symbolBoxes.values(),
      ...[...replacement.values()].filter(p=>p.sourceId!==group[0]!.sourceId).map(reviewedTextWorldBox)];
    const offsets:{dx:number;dy:number;distance:number}[]=[];
    for(let dx=-REVIEWED_TEXT_MAX_NUDGE_WORLD;dx<=REVIEWED_TEXT_MAX_NUDGE_WORLD;dx+=2)
      for(let dy=-limitY;dy<=limitY;dy+=2)offsets.push({dx,dy,distance:dx*dx+dy*dy});
    offsets.sort((a,b)=>a.distance-b.distance||Math.abs(a.dx)-Math.abs(b.dx)||a.dy-b.dy||a.dx-b.dx);
    for(const {dx,dy} of offsets){
      const candidate=rows.map(p=>({...p,position:{x:p.position.x+dx,y:p.position.y+dy}}));
      const boxes=candidate.map(reviewedTextWorldBox);
      if(boxes.some(box=>obstacles.some(other=>overlap(box,other)>0)))continue;
      candidate.forEach(p=>replacement.set(p.key,p));break;
    }
  }
  return primitives.map(p=>replacement.get(p.key)??p);
}
