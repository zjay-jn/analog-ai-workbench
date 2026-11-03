import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {searchFileSnapshots} from '../apps/desktop/src/renderer/documents/file-search';
const file=(name:string,text:string,startLine=1)=>({id:randomUUID(),name,text,startLine,endLine:startLine+text.split('\n').length-1,totalLines:startLine+text.split('\n').length-1});
test('search keeps file identity and original excerpt line numbers across files',()=>{
 const first=file('first.md','No\nSAR ADC target'),excerpt=file('notes.txt','target\nother\nTARGET',20),result=searchFileSnapshots([first,excerpt],'target');
 assert.deepEqual(result.hits.map(h=>[h.documentId,h.name,h.line]),[[first.id,'first.md',2],[excerpt.id,'notes.txt',20],[excerpt.id,'notes.txt',22]]);assert.equal(result.hasMore,false);
 assert.equal(searchFileSnapshots([first,excerpt],'target',true).hits.length,2);assert.equal(searchFileSnapshots([first],'TARGET').hits.length,1);
});
test('queries are literal including regular-expression metacharacters and Unicode',()=>{
 const source=file('code.ts','a+b [x] (test).* $ { } | \\ path\n采样率 Δ Σ\nİstanbul');
 for(const query of ['a+b','[x]','(test).*','$','{ }','|','\\','采样率','δ'])assert.equal(searchFileSnapshots([source],query).hits.length,1,query);
 const unicode=searchFileSnapshots([source],'stanbul').hits[0]!;assert.equal(unicode.before,'İ');assert.equal(unicode.match,'stanbul');
 for(const query of ['','   ','x\ny','x'.repeat(121)])assert.deepEqual(searchFileSnapshots([source],query),{hits:[],hasMore:false});
});
test('bounded results distinguish exact limit and overflow and do not mutate source',()=>{
 const exact=file('exact.txt',Array(100).fill('target target').join('\n')),overflow=file('overflow.txt','target');const before=JSON.stringify(exact);
 assert.equal(searchFileSnapshots([exact],'target').hits.length,100);assert.equal(searchFileSnapshots([exact],'target').hasMore,false);assert.equal(searchFileSnapshots([exact,overflow],'target').hasMore,true);assert.equal(JSON.stringify(exact),before);
});
test('long-line previews include the match with bounded, intact Unicode and plain untrusted text',()=>{
 const source=file('large.md','🙂'.repeat(1000)+'<script>needle</script>'+'🙂'.repeat(1000)),hit=searchFileSnapshots([source],'needle').hits[0]!;
 assert.equal(hit.match,'needle');assert.ok(Array.from(hit.before).length<=49);assert.ok(Array.from(hit.after).length<=101);assert.ok(hit.before.endsWith('<script>'));assert.ok(hit.after.startsWith('</script>'));assert.equal(/\p{Surrogate}/u.test(hit.before+hit.after),false);
});
