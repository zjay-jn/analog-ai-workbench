/** Shared read-only before/after view; strings remain React text, never executable markup. */
export function TextDiff({before,after}:{before:string;after:string}){
 const a=before.split('\n'),b=after.split('\n');let prefix=0,suffix=0;
 while(prefix<a.length&&prefix<b.length&&a[prefix]===b[prefix])prefix++;
 while(suffix<a.length-prefix&&suffix<b.length-prefix&&a[a.length-1-suffix]===b[b.length-1-suffix])suffix++;
 const side=(lines:string[],kind:'removed'|'added')=><pre aria-label={kind==='removed'?'修改前全文':'修改后全文'}>{lines.map((line,i)=><span key={i} className={i>=prefix&&i<lines.length-suffix?'diff-'+kind:''}><i aria-hidden="true">{i+1} </i>{line||' '}</span>)}</pre>;
 return <div className="edit-diff"><section><h3>修改前</h3>{side(a,'removed')}</section><section><h3>修改后</h3>{side(b,'added')}</section></div>;
}
