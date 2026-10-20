import { describe, expect, it } from 'vitest';
import { en } from '../i18n/en';
import { buildReviewReportMarkdown } from './reviewReport';

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
});
