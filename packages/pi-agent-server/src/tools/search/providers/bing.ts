/**
 * Bing search provider — no API key required.
 *
 * Uses Bing-only endpoints in order so regions where DuckDuckGo is unavailable
 * still have a usable built-in search path:
 *   1. Bing RSS search (small, stable response shape)
 *   2. Bing standard HTML search
 *   3. Bing China HTML search
 */

import { parse as parseHtml } from 'node-html-parser';
import type { WebSearchProvider, WebSearchResult } from '../types.ts';

const DEFAULT_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/rss+xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
} as const;

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function extractXmlTag(block: string, tag: string): string {
  const match = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  if (!match?.[1]) return '';
  const value = match[1]
    .replace(/^\s*<!\[CDATA\[/, '')
    .replace(/\]\]>\s*$/, '');
  return normalizeWhitespace(parseHtml(value).textContent);
}

function normalizeResultUrl(href: string): string | null {
  if (!href) return null;

  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    return null;
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) return null;

  // Bing may wrap result URLs in /ck/a links. The `u` value commonly uses
  // `a1` followed by base64url-encoded UTF-8.
  if (/(^|\.)bing\.com$/i.test(parsed.hostname) && parsed.pathname.startsWith('/ck/a')) {
    const encoded = parsed.searchParams.get('u');
    if (encoded?.startsWith('a1')) {
      try {
        const decoded = Buffer.from(encoded.slice(2), 'base64url').toString('utf8');
        const target = new URL(decoded);
        if (['http:', 'https:'].includes(target.protocol)) return target.toString();
      } catch {
        // Keep checking below; malformed tracking URLs should not abort parsing.
      }
    }
    return null;
  }

  return parsed.toString();
}

function extractRssResults(xml: string, count: number): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const seenUrls = new Set<string>();
  const items = xml.match(/<item\b[^>]*>[\s\S]*?<\/item>/gi) ?? [];

  for (const item of items) {
    if (results.length >= count) break;
    const title = extractXmlTag(item, 'title');
    const url = normalizeResultUrl(extractXmlTag(item, 'link'));
    if (!title || !url || seenUrls.has(url)) continue;

    seenUrls.add(url);
    results.push({
      title,
      url,
      description: extractXmlTag(item, 'description').slice(0, 500),
    });
  }

  return results;
}

function extractHtmlResults(html: string, count: number): WebSearchResult[] {
  const root = parseHtml(html);
  const results: WebSearchResult[] = [];
  const seenUrls = new Set<string>();

  for (const item of root.querySelectorAll('li.b_algo')) {
    if (results.length >= count) break;
    const anchor = item.querySelector('h2 a') ?? item.querySelector('a');
    const title = normalizeWhitespace(anchor?.textContent ?? '');
    const url = normalizeResultUrl(anchor?.getAttribute('href') ?? '');
    if (!title || !url || seenUrls.has(url)) continue;

    seenUrls.add(url);
    results.push({
      title,
      url,
      description: normalizeWhitespace(
        item.querySelector('.b_caption p')?.textContent
          ?? item.querySelector('p')?.textContent
          ?? '',
      ).slice(0, 500),
    });
  }

  return results;
}

async function fetchBing(url: string, endpointName: string): Promise<string> {
  const response = await fetch(url, {
    headers: DEFAULT_HEADERS,
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`${endpointName} returned HTTP ${response.status}`);
  }

  return response.text();
}

export class BingSearchProvider implements WebSearchProvider {
  name = 'Bing';

  async search(query: string, count: number): Promise<WebSearchResult[]> {
    const safeCount = Math.max(1, Math.min(10, count));
    const encodedQuery = encodeURIComponent(query);
    const attempts = [
      {
        name: 'bing_rss',
        url: `https://www.bing.com/search?format=rss&q=${encodedQuery}&count=${safeCount}`,
        parse: extractRssResults,
      },
      {
        name: 'bing_html',
        url: `https://www.bing.com/search?q=${encodedQuery}&count=${safeCount}`,
        parse: extractHtmlResults,
      },
      {
        name: 'bing_cn_html',
        url: `https://cn.bing.com/search?q=${encodedQuery}&count=${safeCount}`,
        parse: extractHtmlResults,
      },
    ];
    const failurePath: string[] = [];

    for (const attempt of attempts) {
      try {
        const body = await fetchBing(attempt.url, attempt.name);
        const results = attempt.parse(body, safeCount);
        if (results.length > 0) return results;
        failurePath.push(`${attempt.name}:no results parsed`);
      } catch (error) {
        failurePath.push(`${attempt.name}:${error instanceof Error ? error.message : String(error)}`);
      }
    }

    throw new Error(`All Bing endpoints failed: ${failurePath.join('; ')}`);
  }
}
