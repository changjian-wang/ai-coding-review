import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { analyzeRequirementUnderstanding, setTokenUsageSink } from './analyzer';
import { addRequirementMaterial, createRequirementsDraft } from '../review/requirements';
import { resetVscodeMock } from '../test/vscodeMock';

afterEach(() => { resetVscodeMock(); setTokenUsageSink(undefined); });

function fixture() {
  const draft = createRequirementsDraft();
  const id = addRequirementMaterial(draft, { kind: 'paste', name: 'Rule', location: 'User input', format: 'markdown', text: 'Charge at most once.' });
  const response = {
    summary: 'Charge consistency.',
    requirements: [{ id: 'RQ-1', title: 'Charge once', text: 'Charge at most once.', origins: [{ sourceId: id, version: 1, line: 1, endLine: 1, quote: 'Charge at most once.' }] }],
    checks: [{ id: 'CK-1', text: 'Inspect concurrent retries.', requirementIds: ['RQ-1'] }],
    questions: [],
  };
  return { draft, response };
}

function modelFor(output: unknown) {
  const sendRequest = vi.fn<vscode.LanguageModelChat['sendRequest']>(async () => ({
    text: (async function* () { yield JSON.stringify(output); })(),
    stream: (async function* () {})(),
  }));
  const countTokens = vi.fn(async () => 25);
  const model: vscode.LanguageModelChat = {
    id: 'test-model', name: 'Test model', vendor: 'test', family: 'test', version: '1',
    maxInputTokens: 4096, sendRequest, countTokens,
  };
  return { model, sendRequest, countTokens };
}

describe('real requirement model adapter', () => {
  it('calls the configured model with exact materials, a code scope, schema and deterministic review settings', async () => {
    const { draft, response } = fixture();
    const { model, sendRequest } = modelFor(response);
    const usage = vi.fn();
    const otherSessionUsage = vi.fn();
    setTokenUsageSink(otherSessionUsage);
    const result = await analyzeRequirementUnderstanding(model, draft, { key: 'scope-1', description: 'repo / feature @ abc' }, { isCancellationRequested: false } as vscode.CancellationToken, usage);
    expect(result).toMatchObject({ sourceKey: expect.any(String), scopeKey: 'scope-1', modelId: 'test-model' });
    expect(sendRequest).toHaveBeenCalledTimes(1);
    const call = sendRequest.mock.calls[0];
    expect(JSON.stringify(call[0])).toContain('Charge at most once.');
    expect(JSON.stringify(call[0])).toContain('repo / feature @ abc');
    expect(JSON.stringify(call[0])).toContain('not from code');
    expect(call[1]).toEqual({ modelOptions: { temperature: 0 } });
    expect(usage).toHaveBeenCalledWith({ op: 'requirements', input: 50, output: 25 });
    expect(otherSessionUsage).not.toHaveBeenCalled();
    expect(draft.confirmation).toBeUndefined();
  });

  it('rejects fabricated source citations rather than confirming a plausible-looking checklist', async () => {
    const { draft, response } = fixture();
    response.requirements[0].origins[0].quote = 'Response must complete in 200ms';
    const { model } = modelFor(response);
    await expect(analyzeRequirementUnderstanding(model, draft, { key: 'scope', description: 'repo' }, { isCancellationRequested: false } as vscode.CancellationToken, () => {})).rejects.toThrow(/citation/);
    expect(draft.understanding).toBeUndefined();
    expect(draft.confirmation).toBeUndefined();
  });

  it('does not silently truncate or call a model when its measured input budget is exceeded', async () => {
    const { draft, response } = fixture();
    const { model, sendRequest, countTokens } = modelFor(response);
    countTokens.mockResolvedValue(4096 - 511);
    await expect(analyzeRequirementUnderstanding(model, draft, { key: 'scope', description: 'repo' }, { isCancellationRequested: false } as vscode.CancellationToken, () => {})).rejects.toThrow(/budget/);
    expect(sendRequest).not.toHaveBeenCalled();
    countTokens.mockResolvedValue(4096 - 512);
    await expect(analyzeRequirementUnderstanding(model, draft, { key: 'scope', description: 'repo' }, { isCancellationRequested: false } as vscode.CancellationToken, () => {})).resolves.toMatchObject({ modelId: 'test-model' });
  });

  it('surfaces a model failure and never changes source or creates a confirmation', async () => {
    const { draft, response } = fixture();
    const { model, sendRequest } = modelFor(response);
    sendRequest.mockRejectedValueOnce(new Error('Access denied to model'));
    const before = JSON.stringify(draft);
    await expect(analyzeRequirementUnderstanding(model, draft, { key: 'scope', description: 'repo' }, { isCancellationRequested: false } as vscode.CancellationToken, () => {})).rejects.toThrow(/Access denied/);
    expect(JSON.stringify(draft)).toBe(before);
  });

  it('rejects cancellation or an old material signature after the request finishes', async () => {
    const { draft, response } = fixture();
    const { model, sendRequest } = modelFor(response);
    sendRequest.mockImplementationOnce(async () => {
      addRequirementMaterial(draft, { kind: 'paste', name: 'New', location: 'User', format: 'text', text: 'New constraint.' });
      return { text: (async function* () { yield JSON.stringify(response); })(), stream: (async function* () {})() };
    });
    await expect(analyzeRequirementUnderstanding(model, draft, { key: 'scope', description: 'repo' }, { isCancellationRequested: false } as vscode.CancellationToken, () => {})).rejects.toThrow(/changed/);
  });

  it('does not call or confirm a model after cancellation', async () => {
    const { draft, response } = fixture();
    const { model, sendRequest } = modelFor(response);
    await expect(analyzeRequirementUnderstanding(model, draft, { key: 'scope', description: 'repo' }, { isCancellationRequested: true } as vscode.CancellationToken, () => {})).rejects.toThrow(/Canceled/);
    expect(sendRequest).not.toHaveBeenCalled();
    expect(draft.confirmation).toBeUndefined();
  });
});
