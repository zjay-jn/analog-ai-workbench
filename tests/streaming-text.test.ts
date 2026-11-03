import test from 'node:test';import assert from 'node:assert/strict';import {advanceStreamingText} from '../apps/desktop/src/renderer/agent/streaming-text';
test('received bursts reveal monotonically from left to right without waiting for a full line',()=>{
 const target='测试SAR ADC的第一步是确认采样时钟。\n然后检查静态与动态指标。'.repeat(4);let shown='',steps=0;
 const first=advanceStreamingText(shown,target,16);assert.ok(first.length>0&&first.length<target.indexOf('\n'));
 while(shown!==target&&steps<300){const next=advanceStreamingText(shown,target,16);assert.ok(next.startsWith(shown)&&target.startsWith(next));assert.ok(next.length>shown.length);shown=next;steps++;}
 assert.equal(shown,target);assert.ok(steps>1&&steps<120);
});
test('emoji sequences and combining marks stay intact, and replacement snapshots do not replay old text',()=>{
 const target='👩🏽‍🔬e\u0301🇨🇳中文';const boundaries=new Set([...new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(target)].map(s=>s.index+s.segment.length));let shown='';
 while(shown!==target){shown=advanceStreamingText(shown,target,1);assert.ok(boundaries.has(shown.length));}
 assert.equal(advanceStreamingText('old reply','new reply',16),'new reply');assert.equal(advanceStreamingText(target,target,16),target);
});
test('large received bursts catch up without losing or duplicating Markdown text',()=>{
 const target=('# 标题\n- 测试参数\n').repeat(1500);let shown='',frames=0;
 while(shown!==target&&frames++<300)shown=advanceStreamingText(shown,target,16);
 assert.equal(shown,target);assert.ok(frames<150);
});
