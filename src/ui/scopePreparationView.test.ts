import { afterEach, describe, expect, it } from 'vitest';
import { scopePreparationView } from './scopePreparationView';
import { m } from '../i18n';
import { resetVscodeMock, vscodeMockState } from '../test/vscodeMock';

function client(kind = 'pr') {
  const html = scopePreparationView('C:\\repo', kind);
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error('Preparation script is missing');
  interface Element {
    value: string; textContent: string; hidden: boolean; disabled: boolean;
    onclick?: () => void; onchange?: () => void;
    replaceChildren(): void; appendChild(child: Element): void; addEventListener(): void;
  }
  const elements = new Map<string, Element>();
  const element = (): Element => ({
    value: '', textContent: '', hidden: false, disabled: false,
    replaceChildren() {}, appendChild() {}, addEventListener() {},
  });
  const get = (id: string) => {
    let value = elements.get(id);
    if (!value) { value = element(); elements.set(id, value); }
    return value;
  };
  get('error').hidden = true;
  get('head').value = 'feature';
  get('base').value = 'main';
  let listener: ((event: { data: unknown }) => void) | undefined;
  let saved: Record<string, unknown> = {};
  const messages: unknown[] = [];
  Function('window', 'document', 'acquireVsCodeApi', script)(
    { addEventListener: (type: string, callback: typeof listener) => { if (type === 'message') listener = callback; } },
    { getElementById: get, createElement: element, querySelectorAll: () => [] },
    () => ({ postMessage: (message: unknown) => messages.push(message), getState: () => saved, setState: (state: Record<string, unknown>) => { saved = state; } }),
  );
  const receive = (data: unknown) => listener?.({ data });
  const repository = () => receive({
    type: 'repository', selected: 'C:\\repo', roots: ['C:\\repo'],
    data: { cwd: 'C:\\repo', refs: ['main', 'feature'], current: 'feature' },
  });
  return { html, get, receive, repository, messages, saved: () => saved };
}

afterEach(() => resetVscodeMock());

describe('preparation repository actions', () => {
  it.each(['en', 'zh-CN'])('describes repository browsing and refresh/retry accurately in %s', (language) => {
    vscodeMockState.language = language;
    const page = client();
    const t = m().scope;
    expect(page.html).toContain(t.browseRepository);
    expect(page.html).toContain(t.browseRepositoryHint);
    expect(page.html).toContain(t.refreshHint);
    page.repository();
    expect(page.get('retry').textContent).toBe(t.refreshPrs);
    expect(page.get('retry').disabled).toBe(true);
    page.receive({ type: 'prs', prs: [{ number: 42, title: 'Selected PR' }], selectedPr: 42 });
    expect(page.get('retry').disabled).toBe(false);
    page.get('retry').onclick?.();
    expect(page.messages.at(-1)).toEqual({ type: 'prs', cwd: 'C:\\repo' });
    expect(page.get('retry').disabled).toBe(true);
    page.receive({ type: 'error', message: 'PR access denied' });
    expect(page.get('retry').textContent).toBe(t.retry);
    expect(page.get('retry').disabled).toBe(false);
    page.get('retry').onclick?.();
    expect(page.messages.at(-1)).toEqual({ type: 'prs', cwd: 'C:\\repo' });
    page.receive({ type: 'error', message: 'PR access denied' });
    page.get('kind').value = 'branchChanges';
    page.get('kind').onchange?.();
    expect(page.get('error').hidden).toBe(true);
    expect(page.get('retry').textContent).toBe(t.refreshRepository);
    page.get('browse').onclick?.();
    expect(page.messages.at(-1)).toEqual({ type: 'browse' });
  });

  it('refreshes repository branches rather than model understanding and remembers preparation separately from a review', () => {
    const page = client('branchChanges');
    page.repository();
    expect(page.get('retry').textContent).toBe(m().scope.refreshRepository);
    page.get('retry').onclick?.();
    expect(page.messages.at(-1)).toEqual({ type: 'repository', cwd: 'C:\\repo' });
    page.receive({ type: 'loading', selected: 'C:\\other', roots: ['C:\\repo', 'C:\\other'] });
    expect(page.saved()).toEqual({ preparationCwd: 'C:\\other' });
    expect(page.get('retry').disabled).toBe(true);
    page.receive({ type: 'error', message: 'Not a Git repository' });
    expect(page.get('retry').textContent).toBe(m().scope.retry);
    expect(page.get('retry').disabled).toBe(false);
    expect(page.messages).not.toContainEqual(expect.objectContaining({ type: 'organize' }));
  });
});
