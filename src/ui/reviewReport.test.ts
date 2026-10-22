import { describe, expect, it } from 'vitest';
import { en } from '../i18n/en';
import { buildReviewReportMarkdown } from './reviewReport';
import { addRequirementMaterial, createRequirementsDraft } from '../review/requirements';

describe('review report repository verification', () => {
  it('does not count unresolved repository candidates as unhandled', () => {
    const markdown = buildReviewReportMarkdown({
      repo: 'repo',
      scopeLabel: 'scope',
      generatedAt: 0,
      coverage: { seen: 1, total: 1, filesReady: 1, filesTotal: 1 },
      files: [{
        path: 'config_cmd.py',
        findings: [{
          id: 'f0',
          line: 157,
          severity: 'conditional',
          title: 'Possible KeyError',
          detail: 'The return contract needs verification.',
          verification: {
            status: 'unresolved',
            rationale: 'No repository evidence was found.',
            evidence: [],
          },
        }],
        disposition: () => undefined,
        annotations: [],
      }],
    }, en.report);

    expect(markdown).toContain('Unhandled findings: 0');
    expect(markdown).toContain('Repository evidence unresolved (non-blocking)');
    expect(markdown).not.toContain('_Open_');
  });

  it('exports the explicit requirement review boundary and original material provenance', () => {
    const draft = createRequirementsDraft();
    addRequirementMaterial(draft, { kind: 'file', name: 'Requirements.md', location: 'C:\\repo\\Requirements.md', text: '# Rule\nCharge once.', format: 'markdown' });
    const markdown = buildReviewReportMarkdown({
      repo: 'repo', scopeLabel: 'Feature', generatedAt: 0, coverage: { seen: 0, total: 1, filesReady: 0, filesTotal: 1 },
      files: [], requirements: draft, requirementStatus: 'Requirement consistency not assessed.',
    }, en.report);
    expect(markdown).toContain('> Requirement consistency not assessed.');
    expect(markdown).toContain('Material snapshots');
    expect(markdown).toContain('C:\\repo\\Requirements.md · v1');
  });
});
