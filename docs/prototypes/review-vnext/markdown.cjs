const MarkdownIt = require('markdown-it');

const parser = new MarkdownIt({ html: false, linkify: true, breaks: false });
const validateLink = parser.validateLink;
parser.validateLink = (url) => /^(https?:|mailto:)/i.test(url) && validateLink(url);
parser.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
  tokens[index].attrSet('target', '_blank');
  tokens[index].attrSet('rel', 'noopener noreferrer');
  tokens[index].attrSet('referrerpolicy', 'no-referrer');
  return renderer.renderToken(tokens, index, options);
};
parser.renderer.rules.image = (tokens, index, options, env, renderer) => {
  const alt = renderer.renderInlineAsText(tokens[index].children || [], options, env);
  return `<span class="markdown-image-placeholder">[图片未加载${alt ? `：${parser.utils.escapeHtml(alt)}` : ''}]</span>`;
};

parser.core.ruler.after('inline', 'review_task_list', (state) => {
  for (let index = 2; index < state.tokens.length; index += 1) {
    const inline = state.tokens[index];
    if (inline.type !== 'inline' || state.tokens[index - 1].type !== 'paragraph_open' || state.tokens[index - 2].type !== 'list_item_open') continue;
    const first = inline.children?.[0];
    const marker = first?.type === 'text' && first.content.match(/^\[([ xX])\]\s+/);
    if (!marker) continue;
    const checkbox = new state.Token('review_task_checkbox', 'input', 0);
    checkbox.meta = { checked: marker[1].toLowerCase() === 'x' };
    first.content = first.content.slice(marker[0].length);
    inline.children.unshift(checkbox);
    state.tokens[index - 2].attrJoin('class', 'markdown-task-item');
  }
});
parser.renderer.rules.review_task_checkbox = (tokens, index) => {
  const checked = tokens[index].meta.checked;
  return `<input class="markdown-task-checkbox" type="checkbox" disabled${checked ? ' checked' : ''} aria-label="${checked ? '已完成的清单项' : '未完成的清单项'}"> `;
};

function render(text) {
  if (typeof text !== 'string') throw new TypeError('Markdown 内容必须是字符串');
  return parser.render(text);
}

module.exports = { render };
