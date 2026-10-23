import { afterEach, describe, expect, it } from 'vitest';
import { ModelProvider } from './modelProvider';
import { resetVscodeMock, vscodeMockState } from '../test/vscodeMock';

afterEach(() => resetVscodeMock());

describe('localized model selection labels', () => {
  it('uses Chinese by default, including a previously saved English Auto label', () => {
    vscodeMockState.language = undefined;
    const provider = new ModelProvider();
    expect(provider.label).toBe('自动选择模型');
    provider.set({ id: 'auto', label: 'Auto' });
    expect(provider.label).toBe('自动选择模型');
    vscodeMockState.language = 'en';
    expect(provider.label).toBe('Automatic model');
  });

  it('preserves the original name of an explicitly chosen model', () => {
    const provider = new ModelProvider();
    provider.set({ id: 'chosen-model', label: 'Original model name' });
    vscodeMockState.language = 'zh-CN';
    expect(provider.label).toBe('Original model name');
    expect(provider.id).toBe('chosen-model');
  });
});
