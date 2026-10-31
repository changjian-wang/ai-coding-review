import { Script } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { resetVscodeMock, vscodeMockState } from '../test/vscodeMock';
import { createReviewWorkflow } from '../review/reviewWorkflow';
import { isReviewCenterMessage, renderReviewCenter, scriptJson, type CenterDocument } from './reviewCenter';
import { WorkbenchPanel, type WorkbenchActions, type WorkbenchState } from './workbenchPanel';

afterEach(resetVscodeMock);
function state(): WorkbenchState {
  return {
    structureVersion: 1, label: 'Selected source', files: [], findings: [],
    coverage: { seen: 0, total: 0, filesReady: 0, filesTotal: 0 },
    gatePassed: false, globalDone: false, hasGlobalReport: false, modelLabel: 'Auto', repoName: 'fixture', projects: [], languages: [],
    center: {
      version: 1, headSha: 'live', workflow: createReviewWorkflow('scope', 'repo'),
      findings: [], requirementHtml: {}, reportBase: '# Report', commentPreview: '',
      blockers: { approve: [], 'request-changes': [], comment: [] }, current: false, requirementsConfirmed: false,
    },
  };
}
const source: CenterDocument = {
  path: 'src/example.ts', revision: 'source-version', name: 'example.ts', isMarkdown: false,
  sourceLines: ['const value = 1;'], raw: ['const value = 1;'], defaultToDiff: false,
  seen: [], findings: [], annotations: [], analyzing: false,
  renderPlan: { initial: 1, perFrame: 0, eager: true }, annotationHtml: {},
};

describe('typed real review center', () => {
  it('rejects unbound or malformed messages instead of dispatching positional finding actions', () => {
    expect(isReviewCenterMessage({ type: 'center', action: 'run', confirmed: true, resume: false, revision: 1 })).toBe(false);
    const base = { type: 'center', scopeKey: 'scope', runId: 'run' };
    expect(isReviewCenterMessage({ ...base, action: 'fix', id: 'f0', path: 'src/example.ts', global: false })).toBe(false);
    expect(isReviewCenterMessage({ ...base, action: 'seen', path: 'src/example.ts', revision: 'v1', lines: [1, -2] })).toBe(false);
    expect(isReviewCenterMessage({ ...base, action: 'run', confirmed: true, resume: false, revision: 1 })).toBe(true);
  });
  it('escapes untrusted script data and emits syntactically valid standalone client code', () => {
    const data = state();
    data.label = '</script><img src=x onerror=alert(1)>';
    expect(scriptJson(data)).not.toContain('</script>');
    const html = renderReviewCenter(data);
    expect(html).toContain("default-src 'none'");
    const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)?.[1];
    expect(script).toBeTruthy();
    expect(() => new Script(script!)).not.toThrow();
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
  });
  it('patches document metadata without retransmitting unchanged large source arrays', () => {
    const data = state();
    data.center!.document = source;
    WorkbenchPanel.show(() => data, {} as WorkbenchActions);
    data.center!.document = { ...source, annotations: [{ id: 'note', kind: 'note', startLine: 1, endLine: 1, sourceText: 'value', content: 'Review note' }], translationHtml: undefined };
    WorkbenchPanel.refreshNow();
    const update = vscodeMockState.panel?.webview.messages.at(-1);
    expect(update).toMatchObject({ type: 'center-state', documentPatch: { path: source.path, translationHtml: null } });
    expect(update).not.toHaveProperty('document');
    expect(update).not.toHaveProperty('center');
  });
  it('does not lose queued changed paths when an immediate refresh interrupts batching', () => {
    const data = state();
    let updated: ReadonlySet<string> | undefined;
    WorkbenchPanel.show((paths) => { updated = paths; return data; }, {} as WorkbenchActions);
    WorkbenchPanel.refreshIfOpen('src/example.ts');
    WorkbenchPanel.refreshNow();
    expect(updated).toEqual(new Set(['src/example.ts']));
  });
});
