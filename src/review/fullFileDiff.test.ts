import { describe, expect, it } from 'vitest';
import { buildFullFileDiff } from './fullFileDiff';

describe('buildFullFileDiff', () => {
  it('keeps unchanged lines so the file remains continuous', () => {
    const rows = buildFullFileDiff('before\nold\nafter', 'before\nnew\nafter');

    expect(rows).toEqual([
      { kind: 'context', oldLine: 1, newLine: 1, text: 'before' },
      { kind: 'deleted', oldLine: 2, text: 'old' },
      { kind: 'added', newLine: 2, text: 'new' },
      { kind: 'context', oldLine: 3, newLine: 3, text: 'after' },
    ]);
  });

  it('advances old and new line numbers independently', () => {
    const rows = buildFullFileDiff('a\nb\nc', 'a\nx\ny\nb\nc');

    expect(rows.map(({ kind, oldLine, newLine }) => ({ kind, oldLine, newLine }))).toEqual([
      { kind: 'context', oldLine: 1, newLine: 1 },
      { kind: 'added', oldLine: undefined, newLine: 2 },
      { kind: 'added', oldLine: undefined, newLine: 3 },
      { kind: 'context', oldLine: 2, newLine: 4 },
      { kind: 'context', oldLine: 3, newLine: 5 },
    ]);
  });

  it('preserves the trailing empty line used by the document renderer', () => {
    const rows = buildFullFileDiff('a\n', 'a\nb\n');

    expect(rows.at(-1)).toEqual({ kind: 'context', oldLine: 2, newLine: 3, text: '' });
  });

  it('renders every line of an added file as added', () => {
    expect(buildFullFileDiff(undefined, 'first\nsecond')).toEqual([
      { kind: 'added', newLine: 1, text: 'first' },
      { kind: 'added', newLine: 2, text: 'second' },
    ]);
  });

  it('renders every line of a deleted file as deleted', () => {
    expect(buildFullFileDiff('first\nsecond', undefined)).toEqual([
      { kind: 'deleted', oldLine: 1, text: 'first' },
      { kind: 'deleted', oldLine: 2, text: 'second' },
    ]);
  });
});
