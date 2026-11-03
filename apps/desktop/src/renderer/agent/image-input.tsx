import {useEffect,useRef} from 'react';import {IMAGE_BYTES,imageDimensions,parseImageAttachment,type ImageAttachment} from '../../shared/agent/image-attachment';
const decodeBase64=(data:string)=>Uint8Array.from(atob(data),c=>c.charCodeAt(0));
export async function prepareImage(file:File):Promise<ImageAttachment>{
 if(!file.size||file.size>8*1024*1024||!['','image/png','image/jpeg'].includes(file.type))throw Error('请选择不超过8 MB的PNG或JPEG图片。');
 const buffer=new Uint8Array(await file.arrayBuffer()),kind=buffer[0]===137?'png':'jpeg';try{imageDimensions(buffer,kind);}catch{throw Error('图片格式无效或超过1600万像素。');}
 const bitmap=await createImageBitmap(new Blob([buffer],{type:kind==='png'?'image/png':'image/jpeg'}));
 try{
  if(bitmap.width*bitmap.height>16000000)throw Error('图片像素过大。');const canvas=document.createElement('canvas');let ratio=Math.min(1,1600/Math.max(bitmap.width,bitmap.height));
  for(let attempt=0;attempt<3;attempt++){
   canvas.width=Math.max(1,Math.round(bitmap.width*ratio));canvas.height=Math.max(1,Math.round(bitmap.height*ratio));const context=canvas.getContext('2d');if(!context)throw Error('图片处理不可用。');context.fillStyle='#ffffff';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(bitmap,0,0,canvas.width,canvas.height);
   for(const quality of [0.9,0.75,0.6]){
    const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(Error('图片处理失败。')),'image/jpeg',quality));if(blob.size>IMAGE_BYTES)continue;
    const bytes=new Uint8Array(await blob.arrayBuffer());let raw='';for(const byte of bytes)raw+=String.fromCharCode(byte);
    return parseImageAttachment({id:crypto.randomUUID(),name:(file.name||'粘贴图片').replace(/[\u0000-\u001f/\\:]/gu,'_').slice(0,85)+'.jpg',data:btoa(raw),width:canvas.width,height:canvas.height});
   }ratio*=0.65;
  }throw Error('图片压缩后仍过大，请裁剪后重试。');
 }finally{bitmap.close();}
}
export function ImagePreview({image,onRemove}:{image:ImageAttachment;onRemove?:()=>void}){
 const ref=useRef<HTMLCanvasElement>(null);
 useEffect(()=>{let active=true;void createImageBitmap(new Blob([decodeBase64(image.data)],{type:'image/jpeg'})).then(bitmap=>{if(active&&ref.current){const canvas=ref.current;canvas.width=bitmap.width;canvas.height=bitmap.height;canvas.getContext('2d')?.drawImage(bitmap,0,0);}bitmap.close();}).catch(()=>{});return()=>{active=false;};},[image.data]);
 return <figure className="image-preview"><canvas ref={ref} role="img" aria-label={image.name}/><figcaption>{image.width} × {image.height}</figcaption>{onRemove&&<button type="button" aria-label={`移除图片 ${image.name}`} onClick={onRemove}>×</button>}</figure>;
}
