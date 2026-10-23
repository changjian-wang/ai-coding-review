import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DEFAULT_LANGUAGE, m, resolveLanguage } from './index';
import { env, resetVscodeMock, vscodeMockState } from '../test/vscodeMock';
import { scopePreparationView } from '../ui/scopePreparationView';

afterEach(() => { resetVscodeMock(); env.language = 'en'; });

describe('Chinese-first extension experience', () => {
  it('defaults to Simplified Chinese independently of the editor display language and matches the manifest', () => {
    vscodeMockState.language = undefined;
    env.language = 'en';
    expect(resolveLanguage()).toBe('zh-CN');
    expect(DEFAULT_LANGUAGE).toBe('zh-CN');
    const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(manifest.contributes.configuration.properties['codereview.language'].default).toBe(DEFAULT_LANGUAGE);
    const html = scopePreparationView('C:\\repo', 'pr');
    expect(html).toContain('<html lang="zh-CN">');
    expect(html).toContain('准备一次审查');
    expect(html).toContain('选择审查对象');
    expect(html).toContain('代码仓库');
  });

  it('retains an explicit English preference and switches the entire page catalog', () => {
    vscodeMockState.language = 'en';
    expect(resolveLanguage()).toBe('en');
    expect(m().reviewCenter.prepare).toBe('Prepare');
    expect(scopePreparationView('C:\\repo', 'pr')).toContain('<html lang="en">');
  });

  it.each([['zh-CN', 'zh-CN'], ['zh-TW', 'zh-CN'], ['en', 'en'], ['de', 'en']])(
    'keeps explicit auto mode following the editor display language %s',
    (displayLanguage, expected) => {
      vscodeMockState.language = 'auto';
      env.language = displayLanguage;
      expect(resolveLanguage()).toBe(expected);
    },
  );
});
