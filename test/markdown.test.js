import test from 'node:test';
import assert from 'node:assert/strict';
import { markdown } from '../.github/ai-bot/src/markdown.js';
test('Markdown headings, emphasis, lists and tables are preserved',()=>{
  const text='## 要約\n\n**重要**\n\n- 項目\n\n| A | B |\n| --- | --- |\n| 1 | 2 |';
  assert.equal(markdown(text),text);
  assert.equal(markdown('> 引用'),'> 引用');
});
test('code snippets preserve operators and markup without HTML rendering',()=>{
  const text='`node >=22`\n\n```js\nif (a < b && b >= 2) return "<div>@user</div>";\n```';
  assert.equal(markdown(text),text);
  assert.equal(markdown('`` `x` <tag> ``'),'`` `x` <tag> ``');
});
test('prose suppresses raw HTML, embeds and mentions',()=>{
  const result=markdown('<img src="https://evil">\n\n![image](https://evil)\n\n@owner <!-- marker -->');
  assert.ok(!result.includes('<img'));assert.ok(result.includes('\\![image]'));
  assert.ok(!result.includes('@owner'));assert.ok(!result.includes('<!-- marker -->'));
  assert.equal(markdown('\\![x](url)'), '\\![x](url)');
  assert.equal(markdown('\\\\![x](url)'), '\\\\'+'\\![x](url)');
});
test('escaped backticks cannot hide active HTML from the prose sanitizer',()=>{
  const result=markdown('\\` <img src="https://evil"> `');
  assert.ok(!result.includes('<img'));
});
test('unclosed fences are closed and diagram fences become plain code',()=>{
  assert.equal(markdown('```js\nconst x=1;'),'```js\nconst x=1;\n```');
  assert.equal(markdown('```mermaid\ngraph TD; A-->B\n```'),'```text\ngraph TD; A-->B\n```');
  assert.equal(markdown('> ```mermaid'),'> ```text');
  assert.equal(markdown('~~~json\n{}\n~~~'),'~~~json\n{}\n~~~');
});
