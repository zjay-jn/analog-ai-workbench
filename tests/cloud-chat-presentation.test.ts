import test from 'node:test';import assert from 'node:assert/strict';import {createElement} from 'react';import {renderToStaticMarkup} from 'react-dom/server';
import {ChatMarkdown,parseChatMarkdown} from '../apps/desktop/src/renderer/agent/ChatMarkdown';
import {clearAcceptedDraft,isChatNearBottom} from '../apps/desktop/src/renderer/agent/chat-composer-state';
const render=(text:string)=>renderToStaticMarkup(createElement(ChatMarkdown,{text}));
test('chat Markdown renders engineering headings, emphasis, lists, code and tables',()=>{
  const html=render('### SAR ADC\n\n**逐次逼近**与`V_ref`\n\n- 比较器\n- DAC\n\n1. 采样\n2. 转换\n\n| 参数 | 值 |\n| --- | --- |\n| 位数 | 12 |\n\n```text\nVin --> DAC\n  |     |\n```');
  for(const pattern of [/<h3>SAR ADC<\/h3>/u,/<strong>逐次逼近<\/strong>/u,/<code>V_ref<\/code>/u,/<ul>/u,/<ol start="1">/u,/<th scope="col">参数<\/th>/u,/<pre><code>Vin --&gt; DAC\n  \|     \|\n<\/code><\/pre>/u])assert.match(html,pattern);
});
test('model HTML, links and images never become executable or remote resources',()=>{
  const html=render('<script>alert(1)</script>\n\n[点击](javascript:alert) ![图](https://example.invalid/tracker.png)\n\n```html\n<img src=x onerror=alert(1)>\n```');
  assert.doesNotMatch(html,/<(?:script|img|iframe)\b|<[a-z][^>]*\s(?:href|src|on\w+)=/iu);assert.match(html,/&lt;script&gt;/u);assert.match(html,/javascript:alert/u);
});
test('streaming unfinished fences retain every code line and close without duplicate content',()=>{
  const draft=parseChatMarkdown('```js\nconst x = 1;\n');assert.deepEqual(draft,[{kind:'code',language:'js',text:'const x = 1;\n'}]);
  assert.deepEqual(parseChatMarkdown('```js\nconst x = 1;\n```'),draft);
  assert.match(render('还没有结束的 **文字'),/\*\*文字/u);
});
test('Markdown budgets degrade to original text instead of an unbounded DOM',()=>{
  const text=Array.from({length:1100},()=>'- item').join('\n');assert.deepEqual(parseChatMarkdown(text),[{kind:'paragraph',text}]);
  const maximum='*'.repeat(65536);assert.ok(render(maximum).length<70000);
});
test('late submit acceptance cannot erase a newly edited draft, even with identical text',()=>{
  assert.deepEqual(clearAcceptedDraft({text:'sent',revision:1},1),{text:'',revision:2});
  const edited={text:'next draft',revision:2};assert.equal(clearAcceptedDraft(edited,1),edited);
  const editedBack={text:'sent',revision:3};assert.equal(clearAcceptedDraft(editedBack,1),editedBack);
});
test('reading older text opts out of following streaming output',()=>{
  assert.equal(isChatNearBottom(900,500,1400),true);assert.equal(isChatNearBottom(100,500,1400),false);
});
