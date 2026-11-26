import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  collectHrefs,
  collectTags,
  collectText,
  isAllowedHref,
  normalizeHrefCandidate,
  parseMarkdown,
  renderMarkdown,
  sanitizeHref,
} from '../ui/src/markdown.ts';

function hrefs(src: string): string[] {
  return collectHrefs(renderMarkdown(src));
}

function textOf(src: string): string {
  return collectText(renderMarkdown(src));
}

function tagsOf(src: string): string[] {
  return collectTags(renderMarkdown(src));
}

describe('href allow-list', () => {
  it('allows http, https, mailto and same-origin paths', () => {
    assert.deepEqual(sanitizeHref('https://example.com/a'), { href: 'https://example.com/a', kind: 'external' });
    assert.equal(sanitizeHref('HTTP://EXAMPLE.COM/A')?.kind, 'external');
    assert.equal(sanitizeHref('http://example.com')?.kind, 'external');
    assert.equal(sanitizeHref('mailto:owner@example.com')?.kind, 'external');
    assert.deepEqual(sanitizeHref('/read/rules'), { href: '/read/rules', kind: 'internal' });
    assert.deepEqual(sanitizeHref('/roles/abc?x=1#y'), { href: '/roles/abc?x=1#y', kind: 'internal' });
  });

  it('rejects javascript:, vbscript:, data:, protocol-relative and /\\ paths', () => {
    assert.equal(sanitizeHref('javascript:alert(1)'), null);
    assert.equal(sanitizeHref('JavaScript:alert(1)'), null);
    assert.equal(sanitizeHref('vbscript:msgbox(1)'), null);
    assert.equal(sanitizeHref('data:text/html,<h1>x</h1>'), null);
    assert.equal(sanitizeHref('//evil.example'), null);
    assert.equal(sanitizeHref('/\\evil.example'), null);
    assert.equal(sanitizeHref('./rel'), null);
    assert.equal(sanitizeHref('example.com'), null);
    assert.equal(sanitizeHref('ftp://example.com'), null);
  });

  it('decodes entities and percent-escapes and strips space and controls before the scheme check', () => {
    assert.equal(sanitizeHref(' javascript:alert(1)'), null);
    assert.equal(sanitizeHref('\tjavascript:alert(1)'), null);
    assert.equal(sanitizeHref('java\tscript:alert(1)'), null);
    assert.equal(sanitizeHref('java\nscript:alert(1)'), null);
    assert.equal(sanitizeHref('&#106;avascript:alert(1)'), null);
    assert.equal(sanitizeHref('java&#x09;script:alert(1)'), null);
    assert.equal(sanitizeHref('javascript&colon;alert(1)'), null);
    assert.equal(sanitizeHref('%6aavascript:alert(1)'), null);
    assert.equal(normalizeHrefCandidate(' &#106;ava%73cript:alert(1)').toLowerCase().startsWith('javascript:'), true);
  });
});

describe('XSS corpus', () => {
  it('treats javascript: in mixed case, with leading spaces, tabs or newlines, and with &#106; / &#x09; as text', () => {
    const cases = [
      '[x](javascript:alert(1))',
      '[x](JavaScript:alert(1))',
      '[x]( javascript:alert(1))',
      '[x](java\tscript:alert(1))',
      '[x](java\nscript:alert(1))',
      '[x](&#106;avascript:alert(1))',
      '[x](java&#x09;script:alert(1))',
    ];
    for (const src of cases) {
      assert.equal(hrefs(src).length, 0, src);
      assert.equal(tagsOf(src).includes('a'), false, src);
      assert.match(textOf(src), /x/);
    }
  });

  it('treats vbscript: and data:text/html as text', () => {
    for (const src of ['[x](vbscript:msgbox(1))', '[x](data:text/html,<h1>pwned</h1>)', '[x](DATA:text/html;base64,xxxx)']) {
      assert.equal(hrefs(src).length, 0, src);
      assert.equal(tagsOf(src).includes('a'), false, src);
    }
  });

  it('rejects //evil.example and /\\evil.example', () => {
    for (const src of ['[x](//evil.example)', '[x](/\\evil.example)', '[x](//evil.example/path)']) {
      assert.equal(hrefs(src).length, 0, src);
      assert.equal(tagsOf(src).includes('a'), false, src);
    }
  });

  it('sanitizes nested links, image alts and reference definitions', () => {
    const nested = '[[a](javascript:alert(1))](https://example.com/ok)';
    const got = hrefs(nested);
    assert.ok(got.every((h) => isAllowedHref(h)), String(got));
    assert.ok(!got.some((h) => /javascript/i.test(h)));
    // The outer https link may remain.
    assert.ok(got.length <= 1);

    const img = '![click](javascript:alert(1)) and ![ok](https://example.com/pic)';
    const imgH = hrefs(img);
    assert.ok(!imgH.some((h) => /javascript/i.test(h)));
    assert.ok(imgH.includes('https://example.com/pic'));
    assert.equal(tagsOf(img).includes('img'), false);

    const refs = '[go][r]\n\n[r]: javascript:alert(1)\n[ok][s]\n\n[s]: https://example.com';
    const refH = hrefs(refs);
    assert.ok(!refH.some((h) => /javascript/i.test(h)));
    assert.ok(refH.includes('https://example.com/'));
  });

  it('renders raw <script>, <img onerror> and <a href> as text, not as elements', () => {
    const src = 'Hello <script>alert(1)</script> <img onerror="alert(1)" src=x> <a href="javascript:alert(1)">x</a>';
    const tags = tagsOf(src);
    assert.ok(!tags.includes('script'), String(tags));
    assert.ok(!tags.includes('img'), String(tags));
    assert.ok(!tags.includes('a'), String(tags));
    const text = textOf(src);
    assert.match(text, /<script>alert\(1\)<\/script>/);
    assert.match(text, /<img onerror="alert\(1\)" src=x>/);
    assert.match(text, /<a href="javascript:alert\(1\)">x<\/a>/);
    assert.equal(hrefs(src).length, 0);
  });

  it('shows entities such as &lt;b&gt; literally, without a second decode', () => {
    const text = textOf('A &lt;b&gt;bold&lt;/b&gt; word');
    assert.match(text, /&lt;b&gt;bold&lt;\/b&gt;/);
    assert.ok(!text.includes('<b>'), text);
    assert.ok(!tagsOf('A &lt;b&gt;bold&lt;/b&gt; word').includes('b'));
  });
});

describe('autolinks, images and internal links', () => {
  it('applies the same allow-list to autolinks, reference definitions and image fallbacks', () => {
    assert.equal(hrefs('<javascript:alert(1)>').length, 0);
    assert.equal(hrefs('<https://example.com/ok>')[0], 'https://example.com/ok');
    assert.equal(hrefs('<//evil.example>').length, 0);
    const img = '![diagram](/docs/a)';
    assert.deepEqual(hrefs(img), ['/docs/a']);
    assert.equal(tagsOf(img).includes('img'), false);
    assert.match(textOf(img), /diagram/);
  });

  it('marks external links with rel and target, and leaves internal links for the router', () => {
    const ext = renderMarkdown('[ex](https://example.com)');
    const int = renderMarkdown('[in](/read/rules)');
    const extLink = findTag(ext, 'a')!;
    const intLink = findTag(int, 'a')!;
    assert.equal(extLink.props.href, 'https://example.com/');
    assert.equal(extLink.props.rel, 'noopener noreferrer nofollow');
    assert.equal(extLink.props.target, '_blank');
    assert.equal(intLink.props.href, '/read/rules');
    assert.equal(intLink.props.target, undefined);
    assert.equal(intLink.props.rel, undefined);
  });

  it('puts data-lines on block elements', () => {
    const tree = renderMarkdown('# Title\n\nHello\n\n- a\n- b');
    const tags = collectNodes(tree).filter((n) => n.props && 'data-lines' in n.props);
    assert.ok(tags.some((n) => n.type === 'h1' && n.props['data-lines']));
    assert.ok(tags.some((n) => n.type === 'p' && n.props['data-lines']));
    assert.ok(tags.some((n) => n.type === 'ul' && n.props['data-lines']));
  });
});

describe('pathological and large inputs', () => {
  it('parses a 200k-character document in linear time', () => {
    const chunk = '## Head\n\nA paragraph with a [link](https://example.com/x) and `code`.\n\n> quote\n\n';
    const src = chunk.repeat(Math.ceil(200_000 / chunk.length)).slice(0, 200_000);
    const t0 = performance.now();
    const tree = renderMarkdown(src);
    const ms = performance.now() - t0;
    assert.ok(collectTags(tree).includes('h2'));
    assert.ok(ms < 2_000, `200k parse took ${ms} ms`);
  });

  it('handles 10k * , [ and > without hanging and without leaking a bad href', () => {
    for (const ch of ['*', '[', '>']) {
      const src = ch.repeat(10_000);
      const t0 = performance.now();
      const tree = renderMarkdown(src);
      const ms = performance.now() - t0;
      assert.ok(ms < 1_000, `${ch} x 10k took ${ms} ms`);
      assert.ok(collectHrefs(tree).every(isAllowedHref));
    }
    const mixed = `${'*['.repeat(5_000)}>`.repeat(1);
    const tree = renderMarkdown(mixed);
    assert.ok(collectHrefs(tree).every(isAllowedHref));
  });
});

describe('property: every emitted href stays on the allow-list', () => {
  it('holds for a seeded generator of hostile and ordinary URLs', () => {
    const rnd = lcg(0x58c0ffee);
    const samples = 400;
    for (let i = 0; i < samples; i++) {
      const url = randomHref(rnd, i);
      const doc = [
        `[t](${wrapDest(url)})`,
        `![alt](${wrapDest(url)})`,
        `<${angle(url)}>`,
        `[t][r${i}]\n\n[r${i}]: ${refDest(url)}`,
      ].join('\n\n');
      const got = hrefs(doc);
      for (const h of got) {
        assert.ok(isAllowedHref(h), `href ${h} from input ${JSON.stringify(url)}`);
      }
    }
  });
});

describe('features', () => {
  it('renders headings, lists, quotes, code, emphasis, tables and thematic breaks', () => {
    const src = [
      '# H',
      '',
      'A **bold** and *italic* and `code`.',
      '',
      '- a',
      '  - b',
      '1. one',
      '',
      '> quoted',
      '',
      '```js',
      'ok()',
      '```',
      '',
      '| A | B |',
      '| --- | ---: |',
      '| 1 | 2 |',
      '',
      '---',
    ].join('\n');
    const tags = tagsOf(src);
    for (const t of ['h1', 'strong', 'em', 'code', 'ul', 'li', 'ol', 'blockquote', 'pre', 'table', 'th', 'td', 'hr']) {
      assert.ok(tags.includes(t), `missing ${t} in ${tags}`);
    }
  });

  it('falls back to a pre block when a nesting limit is exceeded', () => {
    const deep = `${'> '.repeat(40)}too deep`;
    const tree = renderMarkdown(deep);
    const tags = collectTags(tree);
    assert.ok(tags.includes('pre'), String(tags));
    assert.match(collectText(tree), /too deep/);
  });
});

function findTag(node: unknown, tag: string): { type: unknown; props: Record<string, unknown> } | null {
  const all = collectNodes(node);
  return all.find((n) => n.type === tag) ?? null;
}

function collectNodes(node: unknown): { type: unknown; props: Record<string, unknown> }[] {
  const out: { type: unknown; props: Record<string, unknown> }[] = [];
  const walk = (n: unknown): void => {
    if (n == null || typeof n === 'string' || typeof n === 'number' || typeof n === 'boolean') return;
    if (Array.isArray(n)) {
      for (const c of n) walk(c);
      return;
    }
    if (typeof n === 'object' && 'type' in n) {
      const v = n as { type: unknown; props?: Record<string, unknown> };
      out.push({ type: v.type, props: v.props ?? {} });
      walk(v.props?.children);
    }
  };
  walk(node);
  return out;
}

/** Deterministic LCG; no extra dependency. */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function pick<T>(rnd: () => number, xs: T[]): T {
  return xs[Math.floor(rnd() * xs.length)]!;
}

function randomHref(rnd: () => number, i: number): string {
  const bases = [
    'javascript:alert(1)',
    'JAVASCRIPT:alert(1)',
    'vbscript:msgbox(1)',
    'data:text/html,<h1>x</h1>',
    '//evil.example',
    '/\\evil.example',
    'https://example.com/ok',
    'http://example.com',
    'mailto:a@example.com',
    '/read/rules',
    '/projects/abc',
    'ftp://example.com',
    ' javascript:alert(1)',
    '\tjavascript:alert(1)',
  ];
  let url = pick(rnd, bases);
  // Mutate: inject whitespace, entities, percent-escapes, case changes.
  const mut = i % 7;
  if (mut === 1) url = url.replace(/j/gi, '&#106;');
  if (mut === 2) url = url.replace(/:/g, '&colon;');
  if (mut === 3) url = url.replace(/([a-z])/i, (m) => `&#x09;${m}`);
  if (mut === 4) url = url.replace(/[a-z]/, (m) => `%${m.charCodeAt(0).toString(16)}`);
  if (mut === 5) url = ` ${url} `;
  if (mut === 6) url = url.split('').join('\n');
  return url;
}

function wrapDest(url: string): string {
  // Angle brackets let destinations contain ")" safely.
  return `<${url.replace(/[<>]/g, '')}>`;
}

function angle(url: string): string {
  return url.replace(/[<>\s]/g, '');
}

function refDest(url: string): string {
  if (/\s/.test(url)) return `<${url.replace(/[<>]/g, '')}>`;
  return url;
}

// Silence unused if parseMarkdown is imported for future cases.
void parseMarkdown;
