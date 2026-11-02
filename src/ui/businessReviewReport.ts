import { fmt, m } from '../i18n';
import {
  businessBlockers, businessHash, coverageComplete,
  type BusinessCitation, type BusinessReviewRun,
} from '../review/businessReview';

export function businessReportReferences(run: BusinessReviewRun): BusinessCitation[] {
  const origins = [...run.baseline.requirements, ...run.baseline.excluded, ...run.baseline.questions].flatMap((item) => item.origins.map((origin): BusinessCitation => {
    const source = run.baseline.materials.find((source) => source.sourceId === origin.sourceId && source.version === origin.version);
    return {
      evidenceId: `origin-${origin.sourceId}-${origin.version}-${origin.line}`, kind: 'material', side: 'material',
      sourceId: origin.sourceId, version: origin.version, sourceHash: source?.hash ?? '',
      path: source?.path ?? origin.sourceId, line: origin.line, endLine: origin.endLine, quote: origin.quote,
    };
  }));
  const seen = new Set<string>();
  return [
    ...origins, ...run.findings.flatMap((finding) => [...finding.evidence, ...finding.counterEvidence]),
    ...run.requirements.flatMap((item) => item.evidence), ...run.premises.flatMap((item) => item.evidence),
    ...run.priorCriticalVerdicts.flatMap((item) => item.evidence),
  ].filter((ref) => {
    const id = businessHash(JSON.stringify(ref));
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function citationMarkdown(refs: readonly BusinessCitation[]): string[] {
  return refs.flatMap((ref) => [
    `\`${ref.path}\` [${ref.side}${ref.version ? ` · v${ref.version}` : ''}] · L${ref.line}–${ref.endLine} · sha256 \`${ref.sourceHash}\``,
    '', ...ref.quote.split('\n').map((line) => `    ${line}`), '',
  ]);
}

export function businessReportMarkdown(run: BusinessReviewRun): string {
  const t = m().businessReview;
  const lines = [
    `# ${t.title}`, '', `${run.scope.repository} / ${run.scope.label}`,
    `head: ${run.scope.headSha}${run.scope.baseSha ? ` / base: ${run.scope.baseSha}` : ''}`,
    `\n**${t[run.status]}** · ${run.modelId} · ${new Date(run.startedAt).toISOString()}`,
    `\n${run.mode === 'technical' ? t.modeTechnical : t.modeRequirements}`,
    ...(run.requirements.some((item) => item.status === 'unknown') || run.premises.some((item) => item.status === 'unknown') ? [`\n${t.partialRequirements}`] : []),
    `\n> ${t.boundary}`, `\n> ${t.materialSnapshotBoundary}`, `\n> ${t.retryNote}`,
    '', `## ${t.limits}`, '',
    ...[...businessBlockers(run), ...run.limitations, ...run.errors].map((reason) => `- ${reason}`),
    '', `## ${t.coverage}`, '',
    ...run.coverage.map((entry) => `- \`${entry.path}\` [${entry.side}] — ${coverageComplete(entry) ? t.completed : t.coverageStates[entry.status]} · ${entry.characters} ${t.characters}${entry.error ? ` · ${entry.error}` : ''}`),
    '', `## ${t.units}`, '',
    ...run.units.map((unit) => `- **${unit.id}**: ${unit.goal}\n  - ${unit.files.join(', ')}${unit.requirementIds.length ? `\n  - ${unit.requirementIds.join(', ')}` : ''}`),
    '', `## ${t.requirementStatus}`, '',
  ];
  for (const verdict of run.requirements) {
    const rule = [...run.baseline.requirements, ...run.baseline.excluded].find((item) => item.id === verdict.id);
    lines.push(`### ${verdict.id} · ${rule?.title ?? verdict.id}`, '', `**${t[verdict.status]}**`, verdict.rationale, '', rule?.text ?? '');
    if (rule) {
      for (const origin of rule.origins) {
        const source = run.baseline.materials.find((source) => source.sourceId === origin.sourceId && source.version === origin.version);
        lines.push(`\n${source?.path ?? origin.sourceId} · v${origin.version} · L${origin.line}–${origin.endLine}${source ? ` · sha256 \`${source.hash}\`` : ''}`);
        lines.push('', ...origin.quote.split('\n').map((line) => `    ${line}`), '');
      }
    }
    if (verdict.critical) lines.push(`\n**${t.criticalBlocked}** ${verdict.critical.dependsOn} / ${verdict.critical.impact} / ${verdict.critical.missingEvidence} / ${verdict.critical.question}`);
    lines.push('', `**${t.evidenceLabel}**`, '', ...citationMarkdown(verdict.evidence));
  }
  lines.push('', `## ${t.premiseStatus}`, '');
  for (const premise of run.premises) {
    const question = run.baseline.questions.find((question) => question.id === premise.id);
    lines.push(`- **${premise.id} · ${t[premise.status]}**: ${question?.text ?? premise.id}\n\n${premise.rationale}`);
    if (premise.critical) lines.push(`  - ${premise.critical.dependsOn} / ${premise.critical.impact} / ${premise.critical.question}`);
    lines.push('', ...citationMarkdown(premise.evidence));
  }
  lines.push('', `## ${t.priorCritical}`, '');
  for (const item of run.priorCritical) {
    const verdict = run.priorCriticalVerdicts.find((verdict) => verdict.id === item.id);
    lines.push(`- **${item.title}**: ${verdict ? `${t[verdict.status]} · ${verdict.rationale}` : t.criticalBlocked}`);
    lines.push('', ...item.detail.split('\n').map((line) => `> ${line}`), '', ...citationMarkdown(verdict?.evidence ?? []));
  }
  lines.push('', `## ${t.findings}`, '');
  for (const finding of run.findings) {
    lines.push(`### ${finding.title}`, '', `**${t[finding.kind]} / ${t[finding.status]}** · ${t[finding.severity]} · ${t[finding.attribution]}`, '',
      finding.cause, '', finding.trigger, '', finding.impact, '', `${finding.requirementIds.join(', ')}`,
      '', `**${t.counterRationale}**`, finding.counterRationale, '');
    for (const [title, evidence] of [[t.evidenceLabel, finding.evidence], [t.counterEvidence, finding.counterEvidence]] as const) {
      lines.push(`**${title}**`, '');
      lines.push(...citationMarkdown(evidence));
    }
    if (finding.critical) lines.push(`**${t.criticalBlocked}** ${finding.critical.dependsOn} / ${finding.critical.impact} / ${finding.critical.missingEvidence} / ${finding.critical.question}`, '');
    const note = run.dispositions[finding.id];
    if (note) lines.push(`**${t.comment}**: ${note.reason}`, '');
  }
  return lines.join('\n');
}

export function businessConclusionSummary(run: BusinessReviewRun): string {
  const t = m().businessReview;
  return [
    `## ${t.title}`, '', `head: ${run.scope.headSha}${run.scope.baseSha ? ` / base: ${run.scope.baseSha}` : ''}`,
    '', `**${t[run.status]}**`, run.mode === 'technical' ? t.modeTechnical : t.modeRequirements,
    '', `${t.coverage}: ${run.coverage.filter(coverageComplete).length}/${run.coverage.length}`,
    `${t.requirementStatus}: ${(['supported', 'violated', 'unknown', 'not-applicable'] as const).map((status) => `${t[status]} ${run.requirements.filter((item) => item.status === status).length}`).join(' / ')}`,
    `${t.premiseStatus}: ${run.premises.filter((item) => item.status === 'clarified').length}/${run.premises.length}`,
    ...(run.requirements.some((item) => item.status === 'unknown') || run.premises.some((item) => item.status === 'unknown') ? [t.partialRequirements] : []),
    `${t.findings}: ${(['confirmed', 'unresolved', 'dismissed'] as const).map((status) => `${t[status]} ${run.findings.filter((item) => item.status === status).length}`).join(' / ')}`,
    `${t.priorCritical}: ${run.priorCriticalVerdicts.filter((item) => item.status === 'cleared').length}/${run.priorCritical.length}`,
    fmt(t.errorCount, run.limitations.length, run.errors.length),
    '', ...businessBlockers(run).filter((reason) => reason !== t.humanConfirm).map((reason) => `- ${reason}`),
    '', t.boundary, t.materialSnapshotBoundary, t.summaryLocal,
  ].join('\n');
}
