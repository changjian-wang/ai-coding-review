const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const markdown = require('./markdown.cjs');
const sources = require('./sources.js');
const { createCenterState, sourceFiles } = require('./center.js');

const sample = [
  '# 支付验收',
  '',
  '必须 **只扣款一次**，并保留 *未知状态* 与 `event.id`。',
  '',
  '- 正常路径',
  '  - 重复通知',
  '- [x] 已明确的约束',
  '- [ ] 尚待验证的前提',
  '',
  '1. 发起请求',
  '2. 查询结果',
  '',
  '> 超时不代表失败。',
  '',
  '```ts',
  'if (amount < limit) return "<safe>";',
  '```',
  '',
  '| 状态 | 行为 |',
  '| --- | --- |',
  '| unknown | 等待确认 |',
  '',
  '[契约文档](https://example.com/contract)',
  '',
  '~~旧结论~~',
].join('\n');

test('常用Markdown结构通过现有解析器渲染，不是替换几个符号的伪支持', () => {
  const html = markdown.render(sample);
  for (const pattern of [
    /<h1>支付验收<\/h1>/, /<strong>只扣款一次<\/strong>/, /<em>未知状态<\/em>/,
    /<code>event\.id<\/code>/, /<ul>/, /<ol>/, /<blockquote>/,
    /<pre><code class="language-ts">/, /amount &lt; limit/, /&quot;|&lt;safe&gt;/,
    /<table>/, /<thead>/, /<td>unknown<\/td>/, /<s>旧结论<\/s>/,
  ]) assert.match(html, pattern);
  assert.match(html, /type="checkbox" disabled checked/);
  assert.match(html, /type="checkbox" disabled aria-label="未完成/);
});

test('合法链接具有隔离新窗口和不发送来源信息的属性', () => {
  const html = markdown.render('[https](https://example.com) [http](http://example.com) [mail](mailto:test@example.com)');
  assert.equal((html.match(/target="_blank"/g) || []).length, 3);
  assert.equal((html.match(/rel="noopener noreferrer"/g) || []).length, 3);
  assert.equal((html.match(/referrerpolicy="no-referrer"/g) || []).length, 3);
});

test('HTML、脚本、事件属性和SVG不执行，只显示转义原文', () => {
  const html = markdown.render('<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">\n\n<svg onload=alert(1)></svg>');
  assert.doesNotMatch(html, /<(?:script|img|svg)\b/i);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img/);
});

test('危险、文件、相对和协议相对链接不获得可导航href', () => {
  for (const url of [
    'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,hello', 'vbscript:msgbox(1)',
    'file:///C:/private.txt', 'command:workbench.action.closeWindow', '//example.com', '../secret.md',
    'javascript&#x3a;alert(1)',
  ]) {
    const html = markdown.render(`[链接](${url})`);
    assert.doesNotMatch(html, /<a\b|href=/i, url);
  }
});

test('Markdown图片只显示替代文字，不生成自动网络或本地读取', () => {
  const html = markdown.render('![**业务流程**](https://example.com/tracker.png) ![本地](file:///C:/private.png)');
  assert.doesNotMatch(html, /<img\b|src=|<strong>/i);
  assert.match(html, /图片未加载：业务流程/);
});

test('围栏代码和转义字符不会变成可执行标签', () => {
  const html = markdown.render('```html\n<script>alert(1)</script>\n```\n\n\\*原样星号\\*');
  assert.doesNotMatch(html, /<script>/i);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /\*原样星号\*/);
});

test('原始Markdown及空白逐字保存，预览不改变来源版本或引用', () => {
  const state = createCenterState();
  const raw = `\n    缩进代码\n\n${sample}\n\n`;
  const id = sources.addManualSource(state, 'Markdown 原文', raw, 'auto');
  const source = sources.getSource(state, id);
  const before = JSON.stringify(source);
  markdown.render(source.text);
  assert.equal(JSON.stringify(source), before);
  assert.equal(source.text, raw);
  assert.equal(sources.snapshot(source, 1).text, raw);
  assert.equal(sourceFiles(state)[id].markdownText, raw);
  sources.updateSource(state, id, '# 新版本\n\n更新内容。\n');
  assert.equal(sources.snapshot(source, 1).text, raw);
  assert.equal(source.version, 2);
});

test('空内容正常渲染，非字符串显式报错', () => {
  assert.equal(markdown.render(''), '');
  assert.throws(() => markdown.render(null), /必须是字符串/);
});

test('离线浏览器bundle与Node渲染一致，并包含依赖许可', () => {
  const path = join(__dirname, 'markdown.bundle.js');
  const bundle = readFileSync(path, 'utf8');
  const browser = {};
  runInNewContext(bundle, browser, { timeout: 5000 });
  assert.equal(browser.ReviewMarkdown.render(sample), markdown.render(sample));
  assert.match(bundle, /Copyright \(c\) 2014 Vitaly Puzrin, Alex Kocharin/);
  assert.match(bundle, /Permission is hereby granted/);
});
