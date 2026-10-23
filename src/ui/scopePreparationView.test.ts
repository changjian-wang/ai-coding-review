import { afterEach, describe, expect, it } from 'vitest';
import { scopePreparationView } from './scopePreparationView';
import { m } from '../i18n';
import { resetVscodeMock, vscodeMockState } from '../test/vscodeMock';

function client(kind = 'pr') {
  const html = scopePreparationView('C:\\repo', kind);
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error('Preparation script is missing');
  interface Element {
    value: string; textContent: string; hidden: boolean; disabled: boolean; checked: boolean; open: boolean;
    id: string; label: string; title: string; innerHTML: string; tag: string;
    children: Element[]; readonly options: Element[];
    onclick?: () => void; onchange?: () => void;
    replaceChildren(): void; appendChild(child: Element): void; addEventListener(): void;
    setAttribute(name: string, value: string): void; getAttribute(name: string): string | undefined;
    showModal(): void; close(): void;
  }
  const elements = new Map<string, Element>();
  const element = (tag = ''): Element => {
    let value = '';
    const attributes = new Map<string, string>();
    return {
      get value() { return value; },
      set value(next: string) { value = tag === 'select' && !this.options.some((option) => option.value === String(next)) ? '' : String(next); },
      textContent: '', innerHTML: '', hidden: false, disabled: false, checked: false, open: false,
      id: '', label: '', title: '', tag, children: [],
      get options() { return this.children.flatMap((child) => child.tag === 'optgroup' ? child.children : [child]); },
      replaceChildren() { this.children = []; value = ''; },
      appendChild(child) { this.children.push(child); if (child.id) elements.set(child.id, child); },
      addEventListener() {},
      setAttribute(name, next) { attributes.set(name, next); },
      getAttribute(name) { return attributes.get(name); },
      showModal() { this.open = true; }, close() { this.open = false; },
    };
  };
  const get = (id: string) => {
    let value = elements.get(id);
    if (!value) {
      value = element(['repository', 'kind', 'pr', 'head', 'base', 'scope-mode'].includes(id) ? 'select' : '');
      value.id = id; elements.set(id, value);
    }
    return value;
  };
  for (const id of ['kind', 'scope-mode']) for (const kind of ['pr', 'branchChanges', 'branchFull']) {
    const option = element('option'); option.value = kind; get(id).appendChild(option);
  }
  get('error').hidden = true;
  get('head').value = 'feature';
  get('base').value = 'main';
  let listener: ((event: { data: unknown }) => void) | undefined;
  let saved: Record<string, unknown> = {};
  let clock = 0, timerId = 0;
  const timers = new Map<number, { at: number; callback(): void }>();
  const messages: unknown[] = [];
  Function('window', 'document', 'acquireVsCodeApi', script)(
    {
      addEventListener: (type: string, callback: typeof listener) => { if (type === 'message') listener = callback; },
      setTimeout: (callback: () => void, delay: number) => { const id = ++timerId; timers.set(id, { at: clock + delay, callback }); return id; },
      clearTimeout: (id: number) => { timers.delete(id); },
    },
    { getElementById: get, createElement: element, querySelectorAll: () => [] },
    () => ({ postMessage: (message: unknown) => messages.push(message), getState: () => saved, setState: (state: Record<string, unknown>) => { saved = state; } }),
  );
  const receive = (data: unknown) => listener?.({ data });
  const repository = () => receive({
    type: 'repository', selected: 'C:\\repo', roots: ['C:\\repo'],
    data: { cwd: 'C:\\repo', refs: ['main', 'feature'], current: 'feature' },
  });
  const request = () => messages.filter((message): message is { type: 'prs'; cwd: string; requestId: number } =>
    !!message && typeof message === 'object' && 'type' in message && message.type === 'prs').at(-1)!;
  return {
    html, get, receive, repository, messages, request, saved: () => saved,
    prs: (prs: { number: number; title: string }[], selectedPr?: number) => receive({ ...request(), type: 'prs', prs, selectedPr }),
    failPrs: (message: string) => receive({ ...request(), type: 'error', target: 'prs', message }),
    requirements: (values: Record<string, unknown> = {}) => receive({
      type: 'requirements', state: {
        materials: [], html: '', error: '', hasSources: false, ready: false, busy: false, reading: false, scopeLoading: false, scopeReady: true, ...values,
      },
    }),
    advance: (milliseconds: number) => {
      clock += milliseconds;
      for (const [id, timer] of timers) if (timer.at <= clock) { timers.delete(id); timer.callback(); }
    },
  };
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
    expect(page.get('pr').disabled).toBe(true);
    page.prs([{ number: 42, title: 'Selected PR' }]);
    expect(page.get('retry').disabled).toBe(false);
    page.get('retry').onclick?.();
    expect(page.messages.at(-1)).toMatchObject({ type: 'prs', cwd: 'C:\\repo' });
    expect(page.get('retry').disabled).toBe(true);
    page.failPrs('PR access denied');
    expect(page.get('retry').textContent).toBe(t.retry);
    expect(page.get('retry').disabled).toBe(false);
    page.get('retry').onclick?.();
    expect(page.messages.at(-1)).toMatchObject({ type: 'prs', cwd: 'C:\\repo' });
    page.failPrs('PR access denied');
    page.get('kind').value = 'branchChanges';
    page.get('kind').onchange?.();
    expect(page.get('error').hidden).toBe(true);
    expect(page.get('retry').textContent).toBe(t.refreshRepository);
    expect(page.html).not.toContain('id="browse"');
    expect(page.get('browse-repository').textContent).toBe(t.browseRepository);
    page.get('repository').value = '__browse_repository__';
    page.get('repository').onchange?.();
    expect(page.messages.at(-1)).toEqual({ type: 'browse' });
    expect(page.get('repository').value).toBe('C:\\repo');
    page.receive({ type: 'repositoryBrowse', pending: false });
    expect(page.get('repository').disabled).toBe(false);
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
    page.receive({ type: 'error', target: 'repository', message: 'Not a Git repository' });
    expect(page.get('retry').textContent).toBe(m().scope.retry);
    expect(page.get('retry').disabled).toBe(false);
    expect(page.messages).not.toContainEqual(expect.objectContaining({ type: 'organize' }));
  });

  it('uses the prototype PR/branch segmented target and a separate branch comparison mode', () => {
    const page = client('branchChanges');
    page.repository();
    expect(page.get('pr-field').hidden).toBe(true);
    expect(page.get('scope-mode-field').hidden).toBe(false);
    page.get('scope-mode').value = 'branchFull';
    page.get('scope-mode').onchange?.();
    expect(page.get('kind').value).toBe('branchFull');
    expect(page.get('base-field').hidden).toBe(true);
    expect(page.messages.at(-1)).toMatchObject({ type: 'selection', kind: 'branchFull' });
    page.get('target-pr').onchange?.();
    expect(page.get('pr-field').hidden).toBe(false);
    expect(page.get('scope-mode-field').hidden).toBe(true);
    expect(page.messages).toContainEqual(expect.objectContaining({ type: 'prs', cwd: 'C:\\repo' }));
    expect(page.messages.at(-1)).toMatchObject({ type: 'clearSelection', kind: 'pr' });
  });

  it('disables only the pending PR choice, keeps material input available, and leaves an unchosen list unselected', () => {
    const page = client();
    page.repository();
    expect(page.get('pr').disabled).toBe(true);
    expect(page.get('pr').options[0].textContent).toBe(m().scope.loadingPrList);
    expect(page.get('pr').getAttribute('aria-busy')).toBe('true');
    expect(page.get('pr-spinner').hidden).toBe(false);
    expect(page.get('paste').disabled).toBe(false);
    expect(page.get('file').disabled).toBe(false);
    expect(page.get('link').disabled).toBe(false);
    expect(page.get('confirm').disabled).toBe(true);
    page.prs([{ number: 42, title: 'First PR' }, { number: 43, title: 'Second PR' }]);
    expect(page.get('pr').value).toBe('');
    expect(page.get('pr').disabled).toBe(false);
    expect(page.get('status-text').textContent).toContain('2');
    expect(page.get('confirm').disabled).toBe(true);
  });

  it('shows the slow hint at exactly five seconds and does not let an old timer overwrite a result', () => {
    const page = client();
    page.repository();
    page.advance(4999);
    expect(page.get('status-text').textContent).toBe(m().scope.loadingPrList);
    page.advance(1);
    expect(page.get('status-text').textContent).toBe(m().scope.slowPrList);
    page.prs([{ number: 42, title: 'PR' }]);
    const complete = page.get('status-text').textContent;
    page.advance(5000);
    expect(page.get('status-text').textContent).toBe(complete);
    expect(page.get('status-spinner').hidden).toBe(true);
  });

  it('retains the old list and selected PR while refreshing but waits for a fresh scope before starting', () => {
    const page = client();
    page.repository();
    page.prs([{ number: 42, title: 'Original PR' }], 42);
    page.requirements({ scopeSummary: 'feature → main · 2 files' });
    expect(page.get('confirm').disabled).toBe(false);
    page.get('retry').onclick?.();
    expect(page.get('pr').value).toBe('42');
    expect(page.get('pr').options[1].textContent).toContain('Original PR');
    expect(page.get('pr').disabled).toBe(true);
    expect(page.get('status-text').textContent).toBe(m().scope.refreshingPrList);
    expect(page.get('confirm').disabled).toBe(true);
    page.prs([{ number: 42, title: 'Updated PR' }], 42);
    expect(page.get('status-text').textContent).toBe(m().scope.loadingPrScope);
    expect(page.get('requirement-status').textContent).toBe(m().scope.scopePending);
    expect(page.get('confirm').disabled).toBe(true);
    page.requirements({ scopeSummary: 'new-feature → main · 3 files' });
    expect(page.get('confirm').disabled).toBe(false);
    expect(page.get('pr').options[1].textContent).toContain('Updated PR');
  });

  it('distinguishes empty lists from failures and never makes a failed-refresh list current', () => {
    const page = client();
    page.repository();
    page.prs([{ number: 42, title: 'Retained PR' }], 42);
    page.requirements();
    page.get('retry').onclick?.();
    page.failPrs('Network denied');
    expect(page.get('pr').value).toBe('42');
    expect(page.get('pr').disabled).toBe(true);
    expect(page.get('error').textContent).toBe('Network denied');
    expect(page.get('status-text').textContent).toContain(m().scope.retainedPrList);
    expect(page.get('retry').disabled).toBe(false);
    expect(page.get('confirm').disabled).toBe(true);
    page.get('retry').onclick?.();
    page.prs([]);
    expect(page.get('error').hidden).toBe(true);
    expect(page.get('pr').disabled).toBe(true);
    expect(page.get('status-text').textContent).toBe(m().scope.noPrs);
  });

  it('discards a previous PR response and error after changing mode and requesting the list again', () => {
    const page = client();
    page.repository();
    const old = page.request();
    page.get('target-branch').onchange?.();
    expect(page.messages).toContainEqual({ type: 'cancelPrs', cwd: 'C:\\repo' });
    page.get('target-pr').onchange?.();
    const current = page.request();
    expect(current.requestId).toBeGreaterThan(old.requestId);
    page.receive({ ...old, type: 'prs', prs: [{ number: 99, title: 'Stale' }] });
    page.receive({ ...old, type: 'error', target: 'prs', message: 'Old failure' });
    expect(page.get('pr').disabled).toBe(true);
    expect(page.get('error').hidden).toBe(true);
    page.prs([{ number: 42, title: 'Current' }]);
    expect(page.get('pr').options[1].textContent).toContain('Current');
  });

  it('keeps browsing inside the repository dropdown and preserves selection and material when the dialog is cancelled', () => {
    const page = client();
    page.repository();
    page.prs([{ number: 42, title: 'PR' }], 42);
    page.requirements({ materials: [{ id: 'source', selected: true, name: 'Kept text', kind: 'paste', version: 1 }] });
    const before = page.get('materials').innerHTML;
    const group = page.get('repository').children.at(-1)!;
    expect(group.tag).toBe('optgroup');
    expect(group.children[0].textContent).toBe(m().scope.browseRepository);
    page.get('repository').value = '__browse_repository__';
    page.get('repository').onchange?.();
    expect(page.get('repository').value).toBe('C:\\repo');
    expect(page.get('repository').disabled).toBe(true);
    page.receive({ type: 'repositoryBrowse', pending: false });
    expect(page.get('repository').value).toBe('C:\\repo');
    expect(page.get('pr').value).toBe('42');
    expect(page.get('materials').innerHTML).toBe(before);
    expect(page.saved()).toEqual({ preparationCwd: 'C:\\repo' });
  });

  it('separates range I/O from model analysis and retries a failed range rather than reloading the PR list', () => {
    const page = client();
    page.repository();
    page.prs([{ number: 42, title: 'PR' }], 42);
    page.requirements({ scopeReady: false, scopeLoading: true, hasSources: true });
    expect(page.get('status-text').textContent).toBe(m().scope.loadingPrScope);
    expect(page.get('requirement-status').textContent).toBe(m().scope.scopePending);
    expect(page.get('cancel-analysis').hidden).toBe(true);
    expect(page.get('paste').disabled).toBe(false);
    expect(page.get('organize').disabled).toBe(true);
    page.advance(5000);
    expect(page.get('status-text').textContent).toBe(m().scope.slowScope);
    page.requirements({ scopeReady: false, scopeError: 'Missing commit' });
    expect(page.get('retry').textContent).toBe(m().scope.retryScope);
    page.get('retry').onclick?.();
    expect(page.messages.at(-1)).toMatchObject({ type: 'selection', prNumber: 42 });
    page.requirements({ scopeReady: true, busy: true, hasSources: true });
    expect(page.get('requirement-status').textContent).toBe(m().requirements.analyzing);
    expect(page.get('cancel-analysis').hidden).toBe(false);
  });
});
