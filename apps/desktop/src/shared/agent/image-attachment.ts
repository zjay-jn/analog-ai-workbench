export const IMAGE_BYTES=256*1024,IMAGE_COUNT=2;
export type ImageAttachment={id:string;name:string;data:string;width:number;height:number};
function invalid():never{throw new TypeError('Invalid image attachment');}
export function imageDimensions(bytes:Uint8Array,kind:'jpeg'|'png'):{width:number;height:number}{
 let width=0,height=0;
 if(kind==='png'){
  if(bytes.length<24||[137,80,78,71,13,10,26,10].some((n,i)=>bytes[i]!==n)||String.fromCharCode(...bytes.subarray(12,16))!=='IHDR')invalid();
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);width=view.getUint32(16);height=view.getUint32(20);
 }else{
  if(bytes[0]!==255||bytes[1]!==216)invalid();let index=2;
  while(index+4<bytes.length){
   if(bytes[index++]!==255)invalid();while(bytes[index]===255)index++;const marker=bytes[index++]!;if(marker===217||marker===218)break;if(marker===1||(marker>=208&&marker<=215))continue;
   const length=(bytes[index]!<<8)|bytes[index+1]!;if(length<2||index+length>bytes.length)invalid();
   if([192,193,194].includes(marker)){if(length<8)invalid();height=(bytes[index+3]!<<8)|bytes[index+4]!;width=(bytes[index+5]!<<8)|bytes[index+6]!;break;}index+=length;
  }
 }
 if(!width||!height||width>16384||height>16384||width*height>16000000)invalid();return {width,height};
}
export function parseImageAttachment(value:unknown):ImageAttachment{
 if(!value||typeof value!=='object'||Object.getPrototypeOf(value)!==Object.prototype||Reflect.ownKeys(value).length!==5)invalid();
 const v:Record<string,unknown>={};for(const key of ['id','name','data','width','height']){const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!('value'in d))invalid();v[key]=d.value;}
 if(typeof v.id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(v.id)||typeof v.name!=='string'||v.name.length>100||!v.name.trim()||/[\u0000-\u001f/\\:]/u.test(v.name)||typeof v.data!=='string'||v.data.length>Math.ceil(IMAGE_BYTES/3)*4||!v.data.length||v.data.length%4!==0||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(v.data))invalid();
 const decoded=atob(v.data);if(decoded.length>IMAGE_BYTES||btoa(decoded)!==v.data)invalid();const bytes=Uint8Array.from(decoded,c=>c.charCodeAt(0));const dimensions=imageDimensions(bytes,'jpeg');
 if(bytes.at(-2)!==255||bytes.at(-1)!==217||dimensions.width>1600||dimensions.height>1600||v.width!==dimensions.width||v.height!==dimensions.height)invalid();
 return {id:v.id,name:v.name,data:v.data,...dimensions};
}
export function parseImages(value:unknown):ImageAttachment[]{
 if(!Array.isArray(value)||value.length>IMAGE_COUNT||Object.getPrototypeOf(value)!==Array.prototype||Reflect.ownKeys(value).length!==value.length+1)invalid();
 const images=Array.from({length:value.length},(_,i)=>{const d=Object.getOwnPropertyDescriptor(value,String(i));if(!d||!('value'in d))invalid();return parseImageAttachment(d.value);});if(new Set(images.map(i=>i.id)).size!==images.length)invalid();return images;
}
export const imageDataUrl=(image:ImageAttachment)=>`data:image/jpeg;base64,${image.data}`;
