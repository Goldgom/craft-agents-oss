import { afterEach, describe, expect, it } from 'bun:test';
import { BingSearchProvider } from './bing.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('BingSearchProvider', () => {
  it('uses Bing RSS by default and parses structured results', async () => {
    let requestedUrl = '';
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedUrl = String(input);
      return new Response(`
        <rss><channel>
          <item><title>First result</title><link>https://example.com/one</link><description>First description</description></item>
          <item><title>Second result</title><link>https://example.com/two</link><description>Second description</description></item>
        </channel></rss>
      `, { status: 200 });
    }) as typeof fetch;

    const results = await new BingSearchProvider().search('TokenBird AI', 1);

    expect(requestedUrl).toContain('https://www.bing.com/search?format=rss');
    expect(requestedUrl).toContain('q=TokenBird%20AI');
    expect(results).toEqual([
      { title: 'First result', url: 'https://example.com/one', description: 'First description' },
    ]);
  });

  it('falls through to Bing HTML when RSS has no results', async () => {
    const requestedUrls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedUrls.push(String(input));
      if (requestedUrls.length === 1) return new Response('<rss><channel /></rss>');
      return new Response(`
        <ol id="b_results">
          <li class="b_algo"><h2><a href="https://example.org/docs">Example docs</a></h2><div class="b_caption"><p>Documentation result</p></div></li>
        </ol>
      `);
    }) as typeof fetch;

    const results = await new BingSearchProvider().search('example docs', 5);

    expect(requestedUrls).toHaveLength(2);
    expect(requestedUrls[1]).toStartWith('https://www.bing.com/search?q=');
    expect(results[0]).toEqual({
      title: 'Example docs',
      url: 'https://example.org/docs',
      description: 'Documentation result',
    });
  });

  it('reports the complete Bing-only failure path', async () => {
    const requestedUrls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedUrls.push(String(input));
      return new Response('blocked', { status: 503 });
    }) as typeof fetch;

    await expect(new BingSearchProvider().search('test', 5)).rejects.toThrow(
      /All Bing endpoints failed:.*bing_rss:.*bing_html:.*bing_cn_html:/,
    );
    expect(requestedUrls).toHaveLength(3);
    expect(requestedUrls.every((url) => /https:\/\/(www|cn)\.bing\.com\/search/.test(url))).toBe(true);
  });
});
