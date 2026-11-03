export function FilePathBar({name,segments}:{name:string;segments:readonly string[]}){
 const parts=segments.length?segments:['快照',name];
 const visible=parts.length>5?[parts[0]!,'…',...parts.slice(-3)]:parts;
 return <nav className="file-pathbar" aria-label="文件路径" title={segments.length?parts.join(' > '):'原路径未记录，重新打开文件后可显示完整路径。'}><ol>{visible.map((part,index)=><li key={index} className={index===visible.length-1?'file-path-name':''}>{index>0&&<span className="file-path-separator" aria-hidden="true">›</span>}<span>{part}</span></li>)}</ol></nav>;
}
