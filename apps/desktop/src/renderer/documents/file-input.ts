import {fileNameAllowed,validFileText,parseFileContext,type FileContext} from '../../shared/agent/file-context';
export type TextDocument=FileContext;
export async function readTextDocument(file:File):Promise<TextDocument>{
 if(!fileNameAllowed(file.name))throw Error('请选择普通文本或代码文件；凭据文件及此类型暂不支持。');
 if(file.size>256*1024)throw Error('文件超过256 KiB，请先选取较小的文本文件。');
 const bytes=await file.arrayBuffer();if(bytes.byteLength>256*1024)throw Error('文件超过256 KiB。');
 let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes).replace(/\r\n?/gu,'\n');}catch{throw Error('文件不是有效UTF-8，请转换编码后重新打开。');}
 if(!validFileText(text))throw Error('文件包含二进制或不支持的控制字符。');
 const totalLines=text.split('\n').length;if(totalLines>10000)throw Error('文件超过10000行，请先拆分。');
 return {id:crypto.randomUUID(),name:file.name,text,startLine:1,endLine:totalLines,totalLines};
}
export function excerpt(document:TextDocument,start:number,end:number):FileContext{
 if(start<document.startLine||end>document.endLine)throw Error('范围不在已打开的内容内。');
 return parseFileContext({...document,id:crypto.randomUUID(),startLine:start,endLine:end,text:document.text.split('\n').slice(start-document.startLine,end-document.startLine+1).join('\n')});
}
