import { afterEach, describe, expect, it } from 'vitest';
import { businessBaseline, businessHash, createBusinessRun } from '../review/businessReview';
import { resetVscodeMock } from '../test/vscodeMock';
import { businessConclusionSummary, businessReportMarkdown, businessReportReferences } from './businessReviewReport';
import { reviewCenterFixture } from '../test/reviewCenterFixture';

afterEach(() => resetVscodeMock());

function fixture() {
  const run = createBusinessRun(businessBaseline('C:\\repo', { scopeId: 'scope', label: 'Scope', headSha: 'live', files: [{ path: 'app.ts' }] }), 'model');
  run.status = 'completed';
  run.findings = [{
    id: 'issue', candidateIds: ['global-0-0'], kind: 'implementation', status: 'confirmed', severity: 'high', attribution: 'unknown',
    title: '</h3><script>unexpected()</script>', cause: 'A real cause', trigger: 'A real sequence', impact: 'A real consequence',
    requirementIds: [], evidence: [{ evidenceId: 'ev', kind: 'code', side: 'head', path: 'app.ts', sourceHash: 'source-hash', line: 1, endLine: 1, quote: '<script>untrustedSource()</script>' }],
    counterEvidence: [], counterRationale: 'No hidden safeguard was invented.', critical: null,
  }];
  return { run };
}

describe('business report exports', () => {
  it('keeps requirement-origin snapshot hashes in the export after removing the separate report panel', async () => {
    const { session, run } = await reviewCenterFixture();
    const report = businessReportMarkdown(run);
    for (const reference of businessReportReferences(run)) expect(report).toContain(reference.sourceHash);
    session.dispose();
  });

  it('includes exact evidence, hashes and the non-execution boundary without opening a panel', () => {
    const { run } = fixture();
    const markdown = businessReportMarkdown(run);
    expect(markdown).toContain('sha256 `source-hash`');
    expect(markdown).toContain('    <script>untrustedSource()</script>');
    expect(markdown).toContain('not executed tests');
    expect(businessReportReferences(run)).toHaveLength(1);
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
