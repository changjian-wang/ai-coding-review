import { describe, expect, it, vi } from 'vitest';
import {
  decodeRequirementFile, isPublicRequirementAddress, readPublicRequirementUrl, validateRequirementUrl,
  type RequirementHttpServices, type RequirementHttpResponse,
} from './requirementSources';
import { renderRequirementMarkdown } from '../ui/requirementMarkdown';

function services(response: Partial<RequirementHttpResponse> = {}) {
  return {
    addresses: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
    get: vi.fn<RequirementHttpServices['get']>(async () => ({
      status: 200, type: 'text/markdown; charset=utf-8', body: Buffer.from('# Requirements\n\n**Charge once.**'), ...response,
    })),
  } satisfies RequirementHttpServices;
}

describe('local requirement decoding', () => {
  it('retains original UTF-8 BOM, whitespace and CRLF; rejects invalid encodings and unsupported formats', () => {
    const raw = '\ufeff\r\n# 原始需求\r\n\r\n- 原文\r\n';
    expect(decodeRequirementFile(Buffer.from(raw), 'requirements.MD')).toBe(raw);
    expect(() => decodeRequirementFile(Buffer.from([255, 254]), 'requirements.txt')).toThrow(/UTF-8/);
    expect(() => decodeRequirementFile(Buffer.from('abc'), 'requirements.pdf')).toThrow(/Only UTF-8/);
    expect(() => decodeRequirementFile(Buffer.from(' \n'), 'requirements.txt')).toThrow();
  });
});

describe('authorized public requirement links', () => {
  it('reads explicit public content using the validated address, without changing the source', async () => {
    const io = services();
    const source = await readPublicRequirementUrl('https://example.com/requirements.md', undefined, io);
    expect(source).toMatchObject({ kind: 'url', format: 'markdown', location: 'https://example.com/requirements.md', text: '# Requirements\n\n**Charge once.**' });
    expect(io.get.mock.calls[0][1]).toEqual({ address: '93.184.216.34', family: 4 });
  });

  it.each(['file:///C:/private.txt', 'javascript:alert(1)', 'https://name:password@example.com', 'https://localhost/r', 'http://service.internal/r'])(
    'rejects %s before issuing a request', async (url) => {
      const io = services();
      expect(() => validateRequirementUrl(url)).toThrow();
      await expect(readPublicRequirementUrl(url, undefined, io)).rejects.toThrow();
      expect(io.get).not.toHaveBeenCalled();
    },
  );

  it('rejects private, loopback, metadata and mixed DNS results without connecting', async () => {
    const io = services();
    io.addresses.mockResolvedValue([{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }]);
    await expect(readPublicRequirementUrl('https://example.com/r', undefined, io)).rejects.toThrow(/private/);
    expect(io.get).not.toHaveBeenCalled();
    for (const ip of ['0.0.0.0', '10.1.2.3', '127.0.0.1', '169.254.169.254', '172.16.1.1', '192.168.1.1', '100.64.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', '2002:7f00:1::']) {
      expect(isPublicRequirementAddress(ip), ip).toBe(false);
    }
    expect(isPublicRequirementAddress('2606:4700:4700::1111')).toBe(true);
  });

  it('follows same-origin redirects only, rejecting origin changes and repeated loops', async () => {
    const io = services();
    io.get.mockResolvedValueOnce({ status: 302, type: '', location: '/final', body: Buffer.alloc(0) });
    expect((await readPublicRequirementUrl('https://example.com/start', undefined, io)).location).toBe('https://example.com/final');
    const cross = services({ status: 302, location: 'http://example.com/insecure' });
    await expect(readPublicRequirementUrl('https://example.com/start', undefined, cross)).rejects.toThrow(/redirected/);
    expect(cross.get).toHaveBeenCalledTimes(1);
    const loop = services({ status: 302, location: '/again' });
    await expect(readPublicRequirementUrl('https://example.com/start', undefined, loop)).rejects.toThrow(/redirected/);
    expect(loop.get).toHaveBeenCalledTimes(4);
  });

  it('preserves raw HTML without executing scripts, and reports denied/unsupported/oversized content', async () => {
    const html = '<h1>Requirements</h1><script>doNotRun()</script>';
    const io = services({ type: 'text/html', body: Buffer.from(html) });
    expect(await readPublicRequirementUrl('https://example.com/r', undefined, io)).toMatchObject({ format: 'html', text: html });
    await expect(readPublicRequirementUrl('https://example.com/r', undefined, services({ status: 403 }))).rejects.toThrow(/403/);
    await expect(readPublicRequirementUrl('https://example.com/r', undefined, services({ type: 'application/pdf' }))).rejects.toThrow(/supported/);
    await expect(readPublicRequirementUrl('https://example.com/r', undefined, services({ body: Buffer.alloc(512_001, 65) }))).rejects.toThrow(/512,000/);
  });

  it('cancels stalled DNS or HTTP rather than accepting late data', async () => {
    const controller = new AbortController();
    const io = services();
    io.addresses.mockImplementationOnce(() => new Promise(() => {}));
    const work = readPublicRequirementUrl('https://example.com/r', controller.signal, io);
    controller.abort(new Error('Canceled read'));
    await expect(work).rejects.toThrow(/Canceled read/);
    expect(io.get).not.toHaveBeenCalled();
  });
});

it('renders Markdown structures without executing HTML, loading images or granting unsafe links', () => {
  const html = renderRequirementMarkdown('# Title\n\n**Rule**\n\n- [x] Done\n- [ ] Unknown\n\n| A | B |\n| - | - |\n| a | b |\n\n<script>alert(1)</script>\n\n![image](https://example.com/x)\n\n[bad](file:///C:/private.txt) [good](https://example.com)');
  expect(html).toContain('<h1>Title</h1>');
  expect(html).toContain('<strong>Rule</strong>');
  expect(html).toContain('<table>');
  expect(html).toContain('type="checkbox" disabled checked');
  expect(html).toContain('type="checkbox" disabled aria-label=');
  expect(html).not.toMatch(/<(script|img)\b/);
  expect(html).not.toContain('href="file:');
  expect(html).toContain('rel="noopener noreferrer"');
});
