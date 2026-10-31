import { isActionableFinding, type Finding, type GlobalReport } from '../ai/types';
import type { Annotation, FindingDisposition, ReviewConclusion } from '../review/reviewStore';
import type { Messages } from '../i18n/en';
import type { ReviewWorkflowState } from '../review/reviewWorkflow';

export function composeReviewReport(base: string, notes: string, heading: string, comments = ''): string {
  const body = notes.trim() ? `${base.trimEnd()}\n\n## ${heading}\n\n${notes.trim()}\n` : base;
  return comments ? `${body.trimEnd()}\n\n${comments.trim()}\n` : body;
}
/** Everything the report needs about one file in the review set. */
export interface ReportFile {
  path: string;
  findings: Finding[];
  /** Disposition per finding id, when the reviewer acted on it. */
  disposition: (findingId: string) => FindingDisposition | undefined;
  annotations: Annotation[];
}

/** Inputs for {@link buildReviewReportMarkdown}. */
export interface ReportData {
  globalDisposition?: (spot: GlobalReport['fixSpots'][number]) => FindingDisposition | undefined;
  workflow?: ReviewWorkflowState;
  headSha?: string;
  baseSha?: string;
  repo: string;
  scopeLabel: string;
  generatedAt: number;
  coverage: { seen: number; total: number; filesReady: number; filesTotal: number };
  files: ReportFile[];
  globalReport?: GlobalReport;
  conclusion?: ReviewConclusion;
}

function sevLabel(t: Messages['report'], s: Finding['severity']): string {
  return s === 'bug' ? t.sevBug : s === 'conditional' ? t.sevConditional : t.sevSuggestion;
}

function dispLabel(
  t: Messages['report'],
  finding: Finding,
  d: FindingDisposition | undefined,
): string {
  if (finding.verification?.status === 'unresolved') return t.verificationUnresolved;
  if (finding.verification?.status === 'overturned') return t.verificationOverturned;
  if (!d) {
    return t.dispositionOpen;
  }
  return d.kind === 'fixed'
    ? t.dispositionFixed
    : d.kind === 'commented'
      ? t.dispositionCommented
      : t.dispositionIgnored;
}

function noteKind(t: Messages['report'], k: Annotation['kind']): string {
  return k === 'translate' ? t.noteKindTranslate : k === 'explain' ? t.noteKindExplain : t.noteKindNote;
}

function fmtDate(ms: number): string {
  // Local, human-readable timestamp; locale-agnostic ISO-ish without the T/Z.
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Assembles a self-contained Markdown report from a review's persisted state:
 * a summary, every finding grouped by file with its disposition, reviewer
 * notes/explanations, the global analysis (if run) and the final conclusion.
 * Pure string assembly — no IO — so it is trivially testable.
 */
export function buildReviewReportMarkdown(data: ReportData, t: Messages['report'], center?: Messages['reviewCenter']): string {
  const lines: string[] = [];
  const totalFindings = data.files.reduce((n, f) => n + f.findings.length, 0);
  const unhandled = data.files.reduce(
    (n, f) =>
      n + f.findings.filter((x) => (!data.workflow || x.severity !== 'suggestion') && isActionableFinding(x) && !f.disposition(x.id)).length,
    0,
  );

  lines.push(`# ${t.title}`, '');
  lines.push(`- **${t.repo}**: ${data.repo}`);
  lines.push(`- **${t.scope}**: ${data.scopeLabel}`);
  lines.push(`- **${data.workflow && center ? center.snapshotTime : t.generatedAt}**: ${fmtDate(data.generatedAt)}`, '');

  // Summary -------------------------------------------------------------------
  lines.push(`## ${t.summary}`, '');
  lines.push(`- ${t.filesLine(data.coverage.filesReady, data.coverage.filesTotal)}`);
  if (!data.workflow) lines.push(`- ${t.coverageLine(data.coverage.seen, data.coverage.total)}`);
  lines.push(`- ${t.findingsLine(totalFindings)}`);
  lines.push(`- ${t.unhandledLine(unhandled)}`, '');

  if (data.workflow) {
    if (!center) throw new Error('Review workflow report labels are required');
    const workflow = data.workflow;
    lines.push(`- ${center.selectedVerdict}: ${workflow.verdict === 'approve' ? center.approve : workflow.verdict === 'comment' ? center.comment : center.requestChanges}`);
    const models = new Set([workflow.run.modelId, workflow.understanding.modelId, ...Object.values(workflow.run.results).map((item) => item.modelId)].filter(Boolean));
    if (models.size) lines.push(`- ${center.model}: ${[...models].join(', ')}`);
    lines.push(`## ${center.requirementResults}`, '');
    lines.push(`- ${center.runState[workflow.run.status]}`);
    if (data.headSha) lines.push(`- HEAD: \`${data.headSha}\`${data.baseSha ? ` · BASE: \`${data.baseSha}\`` : ''}`);
    if (data.headSha === 'live' && workflow.run.repositoryStamp) lines.push(`- ${center.codeSnapshot}: \`${workflow.run.repositoryStamp}\``);
    const included = workflow.understanding.requirements.filter((item) => item.included);
    if (!included.length) {
      lines.push(`- ${center.technical}`, '');
    } else {
      lines.push(`- ${center.baselineVersion.replace('{0}', String(workflow.baseline?.version ?? 0))}`, '');
      for (const requirement of included) {
        const assessment = workflow.run.business?.requirements.find((item) => item.requirementId === requirement.id);
        lines.push(`- **${requirement.id} · ${requirement.title.replace(/\r?\n/g, ' ')}** — ${assessment ? center.assessment[assessment.status] : center.runState.idle}`);
        lines.push(`  - ${requirement.text.replace(/\r?\n/g, ' ')}`);
        if (assessment) lines.push(`  - ${assessment.rationale.replace(/\r?\n/g, ' ')}`);
        for (const origin of requirement.origins) {
          const source = workflow.materials.find((item) => item.id === origin.sourceId);
          lines.push(`  - ${source?.label.replace(/\r?\n/g, ' ') ?? origin.sourceId} · v${origin.version} · L${origin.line}`);
        }
        for (const evidence of assessment?.evidence ?? []) lines.push(`  - \`${evidence.file}:${evidence.line}\``);
      }
      lines.push('');
    }
    for (const excluded of workflow.understanding.requirements.filter((item) => !item.included)) {
      lines.push(`- ${center.excluded}: ${excluded.id} · ${excluded.exclusionReason?.replace(/\r?\n/g, ' ') ?? ''}`);
    }
    const concerns = workflow.run.business?.concerns ?? [];
    if (concerns.length) {
      lines.push('', `## ${center.criticalConcerns}`, '');
      for (const concern of concerns) {
        lines.push(`- **${concern.id} · ${concern.title.replace(/\r?\n/g, ' ')}** — ${concern.status === 'resolved' ? center.confirmed : center.unresolved}${concern.critical && concern.status === 'open' ? ` · ${center.critical}` : ''}`);
        lines.push(`  - ${concern.detail.replace(/\r?\n/g, ' ')}`, `  - ${concern.impact.replace(/\r?\n/g, ' ')}`);
        for (const proof of concern.evidence) lines.push(`  - \`${proof.file}:${proof.line}\``);
      }
    }
    if (workflow.run.business?.chains.length) {
      lines.push('', `## ${center.businessChains}`, '');
      for (const chain of workflow.run.business.chains) lines.push(`- **${chain.title.replace(/\r?\n/g, ' ')}**: ${chain.description.replace(/\r?\n/g, ' ')} · ${chain.files.map((file) => `\`${file}\``).join(', ')}`);
    }
    if (workflow.run.limitations.length || workflow.run.failed.length || workflow.run.unreviewedConcerns?.length) {
      lines.push('', `## ${center.limitations}`, '');
      for (const limit of workflow.run.limitations) lines.push(`- ${limit.replace(/\r?\n/g, ' ')}`);
      for (const failure of workflow.run.failed) lines.push(`- \`${failure.path}\`: ${failure.error.replace(/\r?\n/g, ' ')}`);
      for (const id of workflow.run.unreviewedConcerns ?? []) lines.push(`- ${center.priorConcern.replace('{0}', id)}`);
    }
    if (workflow.run.excluded.length) {
      lines.push('', `## ${center.excluded}`, '');
      for (const item of workflow.run.excluded) lines.push(`- \`${item.path}\`: ${item.reason}`);
    }
    if (workflow.run.priorFindings?.length) {
      lines.push('', `## ${center.reverification}`, '');
      for (const prior of workflow.run.priorFindings) {
        const judgment = workflow.run.business?.priorFindings?.find((item) => item.id === prior.id);
        const label = judgment?.status === 'dismissed' ? center.priorDismissed : judgment?.status === 'confirmed' ? center.confirmed : center.unresolved;
        lines.push(`- **${prior.finding.title.replace(/\r?\n/g, ' ')}** · \`${prior.path}\` — ${label}`);
        lines.push(`  - ${judgment?.rationale ?? center.errors.priorFindingPending}`);
        for (const evidence of judgment?.evidence ?? []) lines.push(`  - \`${evidence.file}:${evidence.line}\``);
      }
    }
    lines.push('');
  }

  // Findings by file ----------------------------------------------------------
  lines.push(`## ${t.filesHeading}`, '');
  if (totalFindings === 0 && data.files.every((file) => !file.annotations.length)) {
    lines.push(t.noFindings, '');
  } else {
    for (const f of data.files) {
      if (f.findings.length === 0 && f.annotations.length === 0) {
        continue;
      }
      lines.push(`### \`${f.path}\``, '');
      if (f.findings.length === 0) {
        lines.push(t.noFindingsInFile, '');
      }
      for (const finding of f.findings) {
        const d = f.disposition(finding.id);
        lines.push(
          `- **[${sevLabel(t, finding.severity)}] ${finding.title}** — ${t.line(finding.line)} · _${dispLabel(t, finding, d)}_`,
        );
        if (finding.verification) {
          const verificationLabel = finding.verification.status === 'repo-confirmed'
            ? t.verificationRepoConfirmed
            : finding.verification.status === 'overturned'
              ? t.verificationOverturned
              : t.verificationUnresolved;
          lines.push(
            `  - ${verificationLabel}: ${finding.verification.rationale.replace(/\n+/g, ' ')}`,
          );
          for (const evidence of finding.verification.evidence) {
            lines.push(
              `    - \`${evidence.file}:${evidence.line}${evidence.endLine && evidence.endLine !== evidence.line ? `-${evidence.endLine}` : ''}\``,
            );
          }
        }
        if (finding.detail) {
          lines.push(`  - ${finding.detail.replace(/\n+/g, ' ')}`);
        }
        if (finding.suggestion) {
          lines.push(`  - 💡 ${finding.suggestion.replace(/\n+/g, ' ')}`);
        }
        if (d?.reason) {
          lines.push(`  - ${t.reason}: ${d.reason.replace(/\n+/g, ' ')}`);
        }
      }
      // Per-file notes / explanations
      if (f.annotations.length > 0) {
        lines.push('', `**${t.notesHeading}**`, '');
        for (const a of f.annotations) {
          const where = a.startLine > 0 ? ` (${t.line(a.startLine)})` : '';
          lines.push(`- _${noteKind(t, a.kind)}${where}_: ${a.content.replace(/\n+/g, ' ')}`);
        }
      }
      lines.push('');
    }
  }

  // Global analysis -----------------------------------------------------------
  if (data.globalReport) {
    const g = data.globalReport;
    lines.push(`## ${t.globalHeading}`, '');
    if (g.conclusion) {
      lines.push(g.conclusion, '');
    }
    lines.push(`- **${t.recommendation}**: ${g.recommendation}`, '');
    if (g.evidence.length > 0) {
      lines.push(`**${t.evidence}**`, '');
      for (const e of g.evidence) {
        lines.push(`- ${e}`);
      }
      lines.push('');
    }
    if (data.workflow) {
      for (const spot of g.fixSpots) {
        const disposition = data.globalDisposition?.(spot);
        lines.push(`### ${spot.title.replace(/\r?\n/g, ' ')} · \`${spot.file}:${spot.line}\``, '');
        lines.push(`- ${sevLabel(t, spot.severity)} · ${dispLabel(t, spot, disposition)}`, '', spot.detail, '');
        if (spot.verification) {
          lines.push(spot.verification.rationale, '');
          for (const proof of spot.verification.evidence) lines.push(`- \`${proof.file}:${proof.line}\``);
        }
        if (disposition?.reason) lines.push(`- ${t.reason}: ${disposition.reason.replace(/\r?\n/g, ' ')}`);
        lines.push('');
      }
    }
  }

  // Conclusion ----------------------------------------------------------------
  if (!data.workflow || data.conclusion) lines.push(`## ${t.conclusionHeading}`, '');
  if (data.conclusion) {
    const c = data.conclusion;
    lines.push(`- **${t.verdict}**: ${c.label}`);
    const target = c.target === 'pr' && c.prNumber ? t.targetPr(c.prNumber) : t.targetLocal;
    lines.push(`- **${t.target}**: ${target}`);
    lines.push(`- **${t.generatedAt}**: ${fmtDate(c.submittedAt)}`, '');
  } else if (!data.workflow) {
    lines.push(t.notSubmitted, '');
  }

  return lines.join('\n');
}
