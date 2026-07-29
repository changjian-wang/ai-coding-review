import { diffArrays } from 'diff';

export type FullFileDiffKind = 'context' | 'added' | 'deleted';

/** One row in a continuous, full-file inline diff. */
export interface FullFileDiffLine {
  kind: FullFileDiffKind;
  /** 1-based line number in the base file. */
  oldLine?: number;
  /** 1-based line number in the head file. */
  newLine?: number;
  text: string;
}

function sourceLines(text: string | undefined): string[] {
  return text === undefined ? [] : text.split(/\r?\n/);
}

/**
 * Produces an uncollapsed inline diff from the first line through the last.
 * Context rows retain both line numbers; deleted and added rows retain only
 * the side on which they exist.
 */
export function buildFullFileDiff(
  baseText: string | undefined,
  headText: string | undefined,
): FullFileDiffLine[] {
  const changes = diffArrays(sourceLines(baseText), sourceLines(headText));
  const lines: FullFileDiffLine[] = [];
  let oldLine = 1;
  let newLine = 1;

  for (const change of changes) {
    for (const text of change.value) {
      if (change.removed) {
        lines.push({ kind: 'deleted', oldLine, text });
        oldLine++;
      } else if (change.added) {
        lines.push({ kind: 'added', newLine, text });
        newLine++;
      } else {
        lines.push({ kind: 'context', oldLine, newLine, text });
        oldLine++;
        newLine++;
      }
    }
  }

  return lines;
}
