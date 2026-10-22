import { afterEach, describe, expect, it, vi } from 'vitest';
import { businessBaseline, businessHash, createBusinessRun } from '../review/businessReview';
import { resetVscodeMock, vscodeMockState } from '../test/vscodeMock';
import { BusinessReviewPanel, businessConclusionSummary, businessReportMarkdown, businessReportReferences, type BusinessReviewPanelActions } from './businessReviewPanel';

afterEach(() => { BusinessReviewPanel.closeIfOpen(); resetVscodeMock(); });

function fixture() {
  const run = createBusinessRun(businessBaseline('C:\\repo', { scopeId: 'scope', label: 'Scope', headSha: 'live', files: [{ path: 'app.ts' }] }), 'model');
  run.status = 'completed';
  run.findings = [{
    id: 'issue', candidateIds: ['global-0-0'], kind: 'implementation', status: 'confirmed', severity: 'high', attribution: 'unknown',
    title: '</h3><script>unexpected()</script>', cause: 'A real cause', trigger: 'A real sequence', impact: 'A real consequence',
    requirementIds: [], evidence: [{ evidenceId: 'ev', kind: 'code', side: 'head', path: 'app.ts', sourceHash: 'source-hash', line: 1, endLine: 1, quote: '<script>untrustedSource()</script>' }],
    counterEvidence: [], counterRationale: 'No hidden safeguard was invented.', critical: null,
  }];
  const actions: BusinessReviewPanelActions = { recheck: vi.fn(), cancel: vi.fn(), prepare: vi.fn(), confirm: vi.fn(), note: vi.fn(), source: vi.fn() };
  return { run, actions };
}

describe('business report and actions', () => {
  it('escapes model/source HTML and includes evidence, hashes, limitations and the non-execution boundary', () => {
    const { run, actions } = fixture();
    BusinessReviewPanel.show(run, actions);
    const html = vscodeMockState.panel!.webview.html;
    expect(html).not.toContain('<script>unexpected()</script>');
    expect(html).not.toContain('<script>untrustedSource()</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('<pre><code>&lt;script&gt;untrustedSource()&lt;/script&gt;');
    expect(html).toContain('source-hash');
    expect(html).toContain('No tests or production calls were executed.');
    expect(businessReportMarkdown(run)).toContain('sha256 `source-hash`');
    expect(businessReportReferences(run)).toHaveLength(1);
  });

  it('binds actions to the current run and resolves references by identity, not a shifting array index', () => {
    const { run, actions } = fixture();
    BusinessReviewPanel.show(run, actions);
    const webview = vscodeMockState.panel!.webview;
    const ref = businessReportReferences(run)[0];
    webview.receiveMessage({ type: 'source', runId: run.id, id: businessHash(JSON.stringify(ref)) });
    expect(actions.source).toHaveBeenCalledWith(ref);
    webview.receiveMessage({ type: 'source', runId: run.id, id: '0' });
    expect(actions.source).toHaveBeenCalledTimes(1);
    expect(vscodeMockState.warnings.at(-1)).toMatch(/quotation/);
    const next = { ...run, id: 'next-run' };
    BusinessReviewPanel.refreshIfOpen(next);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    webview.receiveMessage({ type: 'confirm', runId: run.id });
    expect(actions.confirm).not.toHaveBeenCalled();
    webview.receiveMessage({ type: 'confirm', runId: next.id });
    expect(actions.confirm).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('preserves per-requirement source facts in Markdown exports, not only in a separate UI source list', () => {
    const { run } = fixture();
    run.requirements = [{ id: 'RQ-1', status: 'supported', rationale: 'A supplied source supports the behavior.', evidence: run.findings[0].evidence, critical: null }];
    run.findings = [];
    run.baseline.materials = [{ sourceId: 's', version: 1, path: 'Requirement input', hash: businessHash('Timeout outcome must be verified.') }];
    run.baseline.questions = [{ id: 'Q-1', text: 'Is a timeout outcome definitive?', origins: [{ sourceId: 's', version: 1, line: 1, endLine: 1, quote: 'Timeout outcome must be verified.' }] }];
    run.premises = [{ id: 'Q-1', status: 'unknown', rationale: 'Provider facts are missing.', evidence: [], critical: null }];
    const report = businessReportMarkdown(run);
    expect(report).toContain('RQ-1');
    expect(report).toContain('app.ts');
    expect(report).toContain('source-hash');
    expect(report).toContain('untrustedSource()');
    expect(report).toContain('Is a timeout outcome definitive?');
    expect(businessReportReferences(run).some((ref) => ref.sourceId === 's')).toBe(true);
  });

  it('publishes only a bounded status summary, not private requirements, paths, model wording or source quotations', () => {
    const { run } = fixture();
    run.scope.repository = 'C:\\private\\product';
    run.baseline.materials = [{ sourceId: 'source', version: 1, path: 'C:\\private\\roadmap.md', hash: 'material-hash' }];
    run.premises = [{ id: 'Q-1', status: 'unknown', rationale: 'Private unresolved premise.', evidence: [], critical: null }];
    run.errors = ['A private error detail.'];
    const summary = businessConclusionSummary(run);
    expect(summary.length).toBeLessThan(10_000);
    expect(summary).toContain('Some requirements or premises remain unknown');
    expect(summary).toContain('Confirmed by supplied evidence 1');
    for (const privateText of ['C:\\private', 'roadmap', 'untrustedSource', 'unexpected()', 'private error detail', 'Private unresolved premise']) {
      expect(summary).not.toContain(privateText);
    }
  });
});
