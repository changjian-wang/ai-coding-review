import MarkdownIt from 'markdown-it';
import { m } from '../i18n';

const markdown = new MarkdownIt({ html: false, linkify: true, breaks: false });
const originalValidate = markdown.validateLink;
markdown.validateLink = (url) => /^(https?:|mailto:)/i.test(url) && originalValidate(url);
markdown.renderer.rules.link_open = (tokens, index, options, _env, renderer) => {
  tokens[index].attrSet('target', '_blank');
  tokens[index].attrSet('rel', 'noopener noreferrer');
  tokens[index].attrSet('referrerpolicy', 'no-referrer');
  return renderer.renderToken(tokens, index, options);
};
markdown.renderer.rules.image = (tokens, index, options, env, renderer) => {
  const alt = renderer.renderInlineAsText(tokens[index].children ?? [], options, env);
  return `${markdown.utils.escapeHtml(m().requirements.imageBlocked)}${alt ? ` ${markdown.utils.escapeHtml(alt)}` : ''}`;
};
markdown.core.ruler.after('inline', 'requirement_tasks', (state) => {
  for (let index = 2; index < state.tokens.length; index++) {
    const inline = state.tokens[index];
    if (inline.type !== 'inline' || state.tokens[index - 1].type !== 'paragraph_open' || state.tokens[index - 2].type !== 'list_item_open') continue;
    const first = inline.children?.[0];
    if (!first || first.type !== 'text') continue;
    const marker = /^\[([ xX])\]\s+/.exec(first.content);
    if (!marker || !inline.children) continue;
    const checkbox = new state.Token('requirement_task', 'input', 0);
    checkbox.content = marker[1].toLowerCase() === 'x' ? 'checked' : '';
    first.content = first.content.slice(marker[0].length);
    inline.children.unshift(checkbox);
  }
});
markdown.renderer.rules.requirement_task = (tokens, index) => {
  const checked = tokens[index].content === 'checked';
  const label = checked ? m().requirements.taskChecked : m().requirements.taskUnchecked;
  return `<input type="checkbox" disabled${checked ? ' checked' : ''} aria-label="${markdown.utils.escapeHtml(label)}"> `;
};

export function renderRequirementMarkdown(text: string): string {
  return markdown.render(text);
}
