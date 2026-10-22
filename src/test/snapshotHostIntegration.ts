import * as assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { createScopePreparation } from '../scope/scopePreparationPanel';
import { BranchSnapshotScope } from '../scope/scopes';
import { CommitSource } from '../review/commitSource';
import { DocumentPanel, type DocActions } from '../ui/documentPanel';
import { renderDocument } from '../ui/documentRenderer';
import { addRequirementMaterial, createRequirementsDraft, currentMaterial } from '../review/requirements';
import { readRequirementFile } from '../review/requirementSources';
import { analyzeRequirementUnderstanding } from '../ai/analyzer';

function within<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), milliseconds);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

/** Runs in a real Extension Development Host, not the Vitest vscode mock. */
export async function run(): Promise<void> {
  const root = process.env.CODEREVIEW_HOST_TEST_ROOT;
  const output = process.env.CODEREVIEW_HOST_TEST_RESULT;
  assert.ok(root && output, 'The isolated host-test runner must provide the fixture paths');
  const exec = promisify(execFile);
  const git = async (...args: string[]) => (await exec('git', args, { cwd: root })).stdout.trim();
  const checks: string[] = [];
  let preparation: ReturnType<typeof createScopePreparation> | undefined;
  try {
    await git('init', '--initial-branch=main');
    await git('config', 'core.autocrlf', 'false');
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'src', 'value.ts'), 'export const value = "main";\n');
    await git('add', '.');
    await git('-c', 'user.name=Host Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'main');
    await git('switch', '-c', 'feature');
    await writeFile(path.join(root, 'src', 'value.ts'), 'export const value = "feature";\n');
    await git('add', '.');
    await git('-c', 'user.name=Host Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'feature');
    await git('switch', 'main');
    await writeFile(path.join(root, 'src', 'value.ts'), 'local unsaved work\n');

    const extension = vscode.extensions.getExtension('changjian-wang.ai-coding-review');
    assert.ok(extension, 'Development extension is installed');
    await extension.activate();
    assert.ok(extension.isActive);
    checks.push('extension activation');

    preparation = createScopePreparation(root, vscode.ViewColumn.One, 'branchChanges');
    assert.equal(await within(preparation.ready, 30_000, 'preparation webview render handshake'), true);
    preparation.dispose();
    assert.equal(await preparation.result, undefined);
    checks.push('real preparation webview script and repository render');

    const requirementFile = path.join(root, 'requirements.md');
    await writeFile(requirementFile, '# Goal\n\nAn order must only be charged once.\n\n- [ ] Verify retries\n');
    const requirementDraft = createRequirementsDraft();
    addRequirementMaterial(requirementDraft, await readRequirementFile(requirementFile));
    let confirmRender!: () => void;
    let failRender!: (reason: Error) => void;
    const renderedRequirements = new Promise<void>((resolve, reject) => { confirmRender = resolve; failRender = reject; });
    let modelCalls = 0;
    const controlledModel: vscode.LanguageModelChat = {
      id: 'host-test-controlled-model', name: 'Controlled test response', vendor: 'test', family: 'test', version: '1', maxInputTokens: 16_000,
      countTokens: async (input) => typeof input === 'string' ? Math.ceil(input.length / 4) : 0,
      sendRequest: async () => {
        modelCalls++;
        const source = requirementDraft.materials[0];
        const output = JSON.stringify({
          summary: '**Verify charge consistency across retries.**',
          requirements: [{ id: 'RQ-1', title: 'Charge once', text: 'An order must only be charged once.', origins: [{
            sourceId: source.id, version: currentMaterial(source).version, line: 3, endLine: 3, quote: 'An order must only be charged once.',
          }] }], checks: [], questions: [],
        });
        return { text: (async function* () { yield output; })(), stream: (async function* () {})() };
      },
    };
    preparation = createScopePreparation(root, vscode.ViewColumn.One, 'branchChanges', {
      load: async () => ({ draft: structuredClone(requirementDraft), selection: { cwd: root, kind: 'branchChanges', headRef: 'feature', baseRef: 'main' } }),
      analyze: (draft, scope, token, usage) => analyzeRequirementUnderstanding(controlledModel, draft, scope, token, usage),
      modelLabel: () => controlledModel.name,
      onRendered: (report) => {
        if (report.error) failRender(new Error(report.error));
        if (report.materials === 1 && report.items === 1 && report.ready && report.unsafeNodes === 0) confirmRender();
      },
    });
    await within(renderedRequirements, 30_000, 'real requirement preparation render');
    assert.equal(modelCalls, 1);
    preparation.dispose();
    checks.push('real three-block requirement webview and model-adapter wiring (controlled response, not model-quality evaluation)');

    let confirmFailure!: () => void;
    const failedRequirements = new Promise<void>((resolve) => { confirmFailure = resolve; });
    preparation = createScopePreparation(root, vscode.ViewColumn.One, 'branchChanges', {
      load: async () => ({ draft: structuredClone(requirementDraft), selection: { cwd: root, kind: 'branchChanges', headRef: 'feature', baseRef: 'main' } }),
      analyze: async () => { throw new Error('Host-test model access denied'); },
      onRendered: (report) => {
        if (report.materials === 1 && report.items === 0 && !report.ready && report.error?.includes('Host-test model access denied')) confirmFailure();
      },
    });
    await within(failedRequirements, 30_000, 'real requirement failure state');
    preparation.dispose();
    checks.push('real model-failure UI preserves material and does not fabricate understanding');

    const set = await new BranchSnapshotScope('feature', 'main').load(root);
    const source = new CommitSource(root, set);
    const text = await source.readReviewFile('src/value.ts');
    assert.equal(text, 'export const value = "feature";\n');
    const rendered = renderDocument(text, 'typescript', 'value.ts');
    let markSeen!: (lines: number[]) => void;
    const seen = new Promise<number[]>((resolve) => { markSeen = resolve; });
    const noop = () => {};
    const actions: DocActions = {
      seen: (_file, lines) => { if (lines.length) markSeen(lines); },
      translate: noop, translateWhole: noop, explain: noop, note: noop, comment: noop,
      removeAnnotation: noop, regenerateAnnotation: noop, convertAnnotationToNote: noop,
      editAnnotation: noop, disposeFinding: noop, viewFix: noop, locate: noop,
      analyze: noop, jumpNext: noop, focusTree: noop,
    };
    DocumentPanel.show({
      path: 'src/value.ts', revision: rendered.revision, name: 'value.ts',
      sourceDescription: `Read-only snapshot: feature @ ${set.headSha.slice(0, 8)}`,
      isMarkdown: false, sourceLines: rendered.sourceLines, raw: text.split('\n'),
      defaultToDiff: false, seen: [], findings: [], annotations: [], analyzing: false,
    }, actions);
    assert.ok((await within(seen, 30_000, 'real document rendering and visible-line acknowledgement')).includes(1));
    checks.push('real document webview load and seen acknowledgement');
    assert.equal(await git('branch', '--show-current'), 'main');
    assert.equal(await git('stash', 'list'), '');
    assert.equal(await readFile(path.join(root, 'src', 'value.ts'), 'utf8'), 'local unsaved work\n');
    checks.push('selected commit read without checkout, stash or overwriting dirty files');
    await writeFile(output, JSON.stringify({ status: 'passed', checks }, null, 2));
  } catch (error) {
    await writeFile(output, JSON.stringify({ status: 'failed', checks, error: String(error) }, null, 2));
    throw error;
  } finally {
    preparation?.dispose();
    DocumentPanel.closeIfOpen();
  }
}
