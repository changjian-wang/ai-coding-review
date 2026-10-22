import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { analyzeBusinessReviewPhase, businessReviewInputFits, setTokenUsageSink } from './analyzer';
import { BUSINESS_REVIEW_LIMITS } from '../review/businessReview';
import { languageDirective } from './lang';
import { vscodeMockState } from '../test/vscodeMock';

afterEach(() => { setTokenUsageSink(undefined); vscodeMockState.language = 'en'; });

function fixture() {
  const countTokens = vi.fn<vscode.LanguageModelChat['countTokens']>(async () => 25);
  const sendRequest = vi.fn<vscode.LanguageModelChat['sendRequest']>(async () => ({
    text: (async function* () { yield '{"summary":"Actual whole-scope analysis","candidates":[],"requests":[]}'; })(),
    stream: (async function* () {})(),
  }));
  const model: vscode.LanguageModelChat = {
    id: 'business-model', name: 'Controlled', vendor: 'test', family: 'test', version: '1',
    maxInputTokens: 4096, countTokens, sendRequest,
  };
  const cts = new vscode.CancellationTokenSource();
  return { model, countTokens, sendRequest, cts };
}

describe('business-review model adapter', () => {
  it('uses the configured model, independent global prompt, deterministic settings and captured usage owner', async () => {
    const { model, sendRequest, cts } = fixture();
    const usage = vi.fn();
    const unrelatedUsage = vi.fn();
    setTokenUsageSink(unrelatedUsage);
    await expect(analyzeBusinessReviewPhase(model, 'global', { scope: 'exact target', requirements: ['Human-final intent'] }, cts.token, usage)).resolves.toMatchObject({ candidates: [] });
    expect(sendRequest).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(sendRequest.mock.calls[0][0])).toContain('Independently discover');
    expect(JSON.stringify(sendRequest.mock.calls[0][0])).toContain('Human-final intent');
    expect(sendRequest.mock.calls[0][1]).toEqual({ modelOptions: { temperature: 0 } });
    expect(usage).toHaveBeenCalledWith({ op: 'business', input: 50, output: 25 });
    expect(unrelatedUsage).not.toHaveBeenCalled();
  });

  it('enforces the exact measured token and JSON-character thresholds without truncation', async () => {
    const { model, countTokens, sendRequest, cts } = fixture();
    countTokens.mockResolvedValue(4096 - 512);
    expect(await businessReviewInputFits(model, 'global', {}, cts.token)).toBe(true);
    countTokens.mockResolvedValue(4096 - 511);
    expect(await businessReviewInputFits(model, 'global', {}, cts.token)).toBe(false);
    await expect(analyzeBusinessReviewPhase(model, 'global', {}, cts.token, () => {})).rejects.toThrow(/budget/);
    expect(sendRequest).not.toHaveBeenCalled();
    countTokens.mockResolvedValue(1);
    expect(await businessReviewInputFits(model, 'global', 'x'.repeat(BUSINESS_REVIEW_LIMITS.inputCharacters - 2), cts.token)).toBe(true);
    const before = countTokens.mock.calls.length;
    expect(await businessReviewInputFits(model, 'global', 'x'.repeat(BUSINESS_REVIEW_LIMITS.inputCharacters - 1), cts.token)).toBe(false);
    expect(countTokens).toHaveBeenCalledTimes(before);
  });

  it('does not call a model after cancellation and rejects invalid token measurements', async () => {
    const { model, countTokens, sendRequest, cts } = fixture();
    countTokens.mockResolvedValueOnce(NaN);
    await expect(businessReviewInputFits(model, 'global', {}, cts.token)).rejects.toThrow(/budget/);
    countTokens.mockResolvedValueOnce(-1);
    await expect(businessReviewInputFits(model, 'global', {}, cts.token)).rejects.toThrow(/budget/);
    cts.cancel();
    await expect(analyzeBusinessReviewPhase(model, 'global', {}, cts.token, () => {})).rejects.toThrow(/Canceled/);
    expect(countTokens).toHaveBeenCalledTimes(2);
    expect(sendRequest).not.toHaveBeenCalled();
  });

  it('surfaces provider failures and malformed JSON rather than manufacturing an empty successful result', async () => {
    const { model, sendRequest, cts } = fixture();
    sendRequest.mockRejectedValueOnce(new Error('Model access denied'));
    await expect(analyzeBusinessReviewPhase(model, 'global', {}, cts.token, () => {})).rejects.toThrow(/access denied/);
    sendRequest.mockImplementationOnce(async () => ({
      text: (async function* () { yield '{not-json'; })(), stream: (async function* () {})(),
    }));
    await expect(analyzeBusinessReviewPhase(model, 'global', {}, cts.token, () => {})).rejects.toThrow();
  });

  it('uses one captured language for measured input and the actual request despite a UI language switch', async () => {
    const { model, countTokens, sendRequest, cts } = fixture();
    expect(await businessReviewInputFits(model, 'global', {}, cts.token, 'en')).toBe(true);
    vscodeMockState.language = 'zh-CN';
    await analyzeBusinessReviewPhase(model, 'global', {}, cts.token, () => {}, 'en');
    expect(countTokens.mock.calls[0][0]).toBe(countTokens.mock.calls[1][0]);
    const request = JSON.stringify(sendRequest.mock.calls[0][0]);
    expect(request).toContain(languageDirective('en'));
    expect(request).not.toContain(languageDirective('zh-CN'));
  });
});
