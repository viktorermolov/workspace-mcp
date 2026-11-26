/**
 * A small Markdown-to-Preact parser. It runs in linear time, emits only VNodes
 * (text is always a child, never markup), and allows only http, https, mailto
 * and same-origin "/" paths as links. Raw HTML is shown as text. Images are
 * not loaded: they become a link (or plain text if the URL is not allowed).
 */
import { h, type ComponentChild } from 'preact';

export const MAX_BLOCK_NESTING = 16;
export const MAX_EMPHASIS_NESTING = 16;

const MAX_NORMALIZE_ROUNDS = 8;

/** Named entities that matter for href smuggling or ordinary text escapes. */
const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  colon: ':',
  sol: '/',
  tab: '\t',
  Tab: '\t',
  newline: '\n',
  NewLine: '\n',
};

export class MarkdownLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MarkdownLimitError';
  }
}

function isStrippedChar(c: number): boolean {
  return (
    c <= 0x20 ||
    (c >= 0x7f && c <= 0x9f) ||
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}

/** Drops whitespace and control characters (used when checking a URL scheme). */
export function stripControlsAndSpace(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (isStrippedChar(c)) continue;
    out += s[i];
  }
  return out;
}

/** Decodes HTML entities once, including numeric ones. Linear in the input length. */
export function decodeEntitiesOnce(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch !== '&') {
      out += ch;
      continue;
    }
    const semi = s.indexOf(';', i + 1);
    if (semi === -1 || semi - i > 16) {
      out += '&';
      continue;
    }
    const body = s.slice(i + 1, semi);
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const digits = hex ? body.slice(2) : body.slice(1);
      if (!digits || (hex ? /[^0-9a-fA-F]/.test(digits) : /[^0-9]/.test(digits))) {
        out += '&';
        continue;
      }
      const n = hex ? parseInt(digits, 16) : parseInt(digits, 10);
      if (n >= 0 && n <= 0x10ffff) {
        out += String.fromCodePoint(n);
        i = semi;
        continue;
      }
    } else {
      const named = NAMED[body] ?? NAMED[body.toLowerCase()];
      if (named !== undefined) {
        out += named;
        i = semi;
        continue;
      }
    }
    out += '&';
  }
  return out;
}

/** Decodes one layer of %HH escapes. Invalid triplets are left as-is. */
export function percentDecodeOnce(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '%' && i + 2 < s.length) {
      const a = s.charCodeAt(i + 1);
      const b = s.charCodeAt(i + 2);
      const hex = (c: number) =>
        (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
      if (hex(a) && hex(b)) {
        out += String.fromCharCode(parseInt(s.slice(i + 1, i + 3), 16));
        i += 2;
        continue;
      }
    }
    out += s[i];
  }
  return out;
}

/**
 * Decodes entities and percent-escapes, then strips whitespace and controls,
 * until the string stops changing (capped, so this stays linear).
 */
export function normalizeHrefCandidate(raw: string): string {
  let s = raw;
  for (let r = 0; r < MAX_NORMALIZE_ROUNDS; r++) {
    const next = stripControlsAndSpace(percentDecodeOnce(decodeEntitiesOnce(s)));
    if (next === s) return s;
    s = next;
  }
  return s;
}

export type SafeHref = { href: string; kind: 'external' | 'internal' };

function hasScheme(s: string): { scheme: string; rest: string } | null {
  // scheme = ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ) ":"
  if (!s) return null;
  const c0 = s.charCodeAt(0);
  const isAlpha = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
  const isScheme = (c: number) => isAlpha(c) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46;
  if (!isAlpha(c0)) return null;
  let i = 1;
  while (i < s.length && isScheme(s.charCodeAt(i))) i++;
  if (s[i] !== ':') return null;
  return { scheme: s.slice(0, i).toLowerCase(), rest: s.slice(i + 1) };
}

/** Returns a safe href, or null if the URL must be shown as text. */
export function sanitizeHref(raw: string): SafeHref | null {
  const normalized = normalizeHrefCandidate(raw);
  if (!normalized) return null;
  const tagged = hasScheme(normalized);
  if (tagged) {
    if (tagged.scheme === 'http' || tagged.scheme === 'https') {
      try {
        const u = new URL(normalized);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
        if (!u.hostname) return null;
        return { href: u.toString(), kind: 'external' };
      } catch {
        return null;
      }
    }
    if (tagged.scheme === 'mailto') {
      if (!tagged.rest || tagged.rest.startsWith('/') || hasScheme(tagged.rest)) return null;
      try {
        const u = new URL(normalized);
        if (u.protocol !== 'mailto:') return null;
        return { href: u.toString(), kind: 'external' };
      } catch {
        return null;
      }
    }
    return null;
  }
  if (normalized.startsWith('/') && !normalized.startsWith('//') && !normalized.startsWith('/\\')) {
    // A decoded path must stay a same-origin path, never a protocol-relative URL.
    if (normalized.includes('\\')) return null;
    return { href: normalized, kind: 'internal' };
  }
  return null;
}

/** True when a finalized href (already on an element) is within the allow-list. */
export function isAllowedHref(href: string): boolean {
  return sanitizeHref(href) !== null;
}

// ---------------------------------------------------------------- AST

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'em' | 'strong'; children: Inline[] }
  | { type: 'a'; href: string; kind: 'external' | 'internal'; children: Inline[] }
  | { type: 'br' };

export type TableAlign = 'left' | 'center' | 'right' | null;

export type Block =
  | { type: 'p'; start: number; end: number; children: Inline[] }
  | { type: 'h'; level: number; start: number; end: number; children: Inline[] }
  | { type: 'pre'; start: number; end: number; lang: string; text: string }
  | { type: 'quote'; start: number; end: number; children: Block[] }
  | { type: 'list'; ordered: boolean; start: number; end: number; begin: number; items: { start: number; end: number; children: Block[] }[] }
  | { type: 'hr'; start: number; end: number }
  | { type: 'table'; start: number; end: number; align: TableAlign[]; head: Inline[][]; rows: Inline[][][] };

export interface Document {
  blocks: Block[];
  refs: Map<string, string>;
}

export interface ParseOptions {
  refs?: Map<string, string>;
  depth?: number;
}

function normalizeLabel(s: string): string {
  return s.replace(/[ \t\r\n]+/g, ' ').trim().toLowerCase();
}

function isBlank(line: string): boolean {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function leadingSpaces(line: string): number {
  let i = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  return i;
}

function isFence(line: string): { char: '`' | '~'; len: number; lang: string; indent: number } | null {
  const indent = leadingSpaces(line);
  if (indent > 3) return null;
  const s = line.slice(indent);
  const ch = s[0];
  if (ch !== '`' && ch !== '~') return null;
  let len = 0;
  while (len < s.length && s[len] === ch) len++;
  if (len < 3) return null;
  const rest = s.slice(len).trim();
  if (ch === '`' && rest.includes('`')) return null;
  return { char: ch, len, lang: rest.replace(/[ \t].*$/, ''), indent };
}

function isHr(line: string): boolean {
  const indent = leadingSpaces(line);
  if (indent > 3) return false;
  const s = line.slice(indent);
  let ch: string | null = null;
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === ' ' || c === '\t') continue;
    if (c !== '-' && c !== '*' && c !== '_') return false;
    if (ch && c !== ch) return false;
    ch = c;
    n++;
  }
  return n >= 3;
}

function atxHeading(line: string): { level: number; text: string } | null {
  const indent = leadingSpaces(line);
  if (indent > 3) return null;
  const s = line.slice(indent);
  let level = 0;
  while (level < s.length && s[level] === '#') level++;
  if (level < 1 || level > 6) return null;
  if (s.length > level && s[level] !== ' ' && s[level] !== '\t') return null;
  let text = s.slice(level).trim();
  // Optional closing hashes.
  let end = text.length;
  while (end > 0 && text[end - 1] === '#') end--;
  if (end < text.length && (end === 0 || text[end - 1] === ' ' || text[end - 1] === '\t')) text = text.slice(0, end).trim();
  return { level, text };
}

function listMarker(line: string): { indent: number; ordered: boolean; start: number; width: number } | null {
  const indent = leadingSpaces(line);
  if (indent > 7) return null;
  const s = line.slice(indent);
  if (s[0] === '-' || s[0] === '+' || s[0] === '*') {
    if (s.length === 1 || s[1] === ' ' || s[1] === '\t') return { indent, ordered: false, start: 1, width: indent + 2 };
    return null;
  }
  let i = 0;
  while (i < s.length && s.charCodeAt(i) >= 48 && s.charCodeAt(i) <= 57) i++;
  if (i < 1 || i > 9) return null;
  if (s[i] !== '.' && s[i] !== ')') return null;
  if (s.length > i + 1 && s[i + 1] !== ' ' && s[i + 1] !== '\t') return null;
  return { indent, ordered: true, start: Number(s.slice(0, i)) || 1, width: indent + i + 2 };
}

function quotePrefix(line: string): { rest: string } | null {
  const indent = leadingSpaces(line);
  if (indent > 3) return null;
  const s = line.slice(indent);
  if (s[0] !== '>') return null;
  let rest = s.slice(1);
  if (rest[0] === ' ' || rest[0] === '\t') rest = rest.slice(1);
  return { rest };
}

function isRefDef(line: string): { label: string; url: string } | null {
  const indent = leadingSpaces(line);
  if (indent > 3) return null;
  const s = line.slice(indent);
  if (s[0] !== '[') return null;
  const close = s.indexOf(']:');
  if (close <= 1) return null;
  const label = normalizeLabel(s.slice(1, close));
  if (!label) return null;
  let url = s.slice(close + 2).trim();
  if (!url) return null;
  if (url[0] === '<' && url[url.length - 1] === '>') url = url.slice(1, -1);
  // Drop an optional title in quotes or parentheses at the end.
  const title = /(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))\s*$/;
  url = url.replace(title, '').trim();
  if (!url) return null;
  return { label, url };
}

function tableAlign(cell: string): TableAlign {
  const s = cell.trim();
  if (!/^:?-+:?$/.test(s)) return undefined as unknown as TableAlign;
  const left = s.startsWith(':');
  const right = s.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return null;
}

function isAlignRow(line: string): TableAlign[] | null {
  if (!line.includes('|')) return null;
  const cells = splitTableRow(line);
  if (!cells.length) return null;
  const align: TableAlign[] = [];
  for (const c of cells) {
    const a = tableAlign(c);
    if (a === (undefined as unknown as TableAlign)) return null;
    align.push(a);
  }
  return align;
}

function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
      continue;
    }
    if (s[i] === '|') {
      cells.push(cur);
      cur = '';
      continue;
    }
    cur += s[i];
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

function lookFenceClose(line: string, open: { char: '`' | '~'; len: number }): boolean {
  const indent = leadingSpaces(line);
  if (indent > 3) return false;
  const s = line.slice(indent);
  let len = 0;
  while (len < s.length && s[len] === open.char) len++;
  if (len < open.len) return false;
  return isBlank(s.slice(len));
}

export function parseMarkdown(text: string, options: ParseOptions = {}): Document {
  const rawLines = text.split('\n');
  // Keep a trailing empty line only as content if the source ended with \n? split already drops a last empty if ended with \n... actually 'a\n'.split('\n') is ['a', '']. Fine.
  const refs = options.refs ?? new Map<string, string>();
  // First pass: collect reference definitions so later inline links can use them.
  if (!options.refs) {
    for (const line of rawLines) {
      const def = isRefDef(line);
      if (def && !refs.has(def.label)) refs.set(def.label, def.url);
    }
  }
  const blocks = parseBlocks(rawLines, 0, rawLines.length, refs, options.depth ?? 0);
  return { blocks, refs };
}

function parseBlocks(lines: string[], from: number, to: number, refs: Map<string, string>, depth: number): Block[] {
  if (depth > MAX_BLOCK_NESTING) throw new MarkdownLimitError('block nesting limit');
  const blocks: Block[] = [];
  let i = from;
  while (i < to) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    if (isRefDef(line) && leadingSpaces(line) <= 3) {
      i++;
      continue;
    }
    const fence = isFence(line);
    if (fence) {
      const start = i + 1; // 1-based later
      let j = i + 1;
      while (j < to && !lookFenceClose(lines[j], fence)) j++;
      const body = lines.slice(i + 1, j).map((l) => (leadingSpaces(l) >= fence.indent ? l.slice(fence.indent) : l));
      blocks.push({ type: 'pre', start: i + 1, end: (j < to ? j : j - 1) + 1, lang: fence.lang, text: body.join('\n') });
      i = j < to ? j + 1 : j;
      continue;
    }
    if (isHr(line)) {
      blocks.push({ type: 'hr', start: i + 1, end: i + 1 });
      i++;
      continue;
    }
    const heading = atxHeading(line);
    if (heading) {
      blocks.push({ type: 'h', level: heading.level, start: i + 1, end: i + 1, children: parseInline(heading.text, refs, 0) });
      i++;
      continue;
    }
    const qp = quotePrefix(line);
    if (qp) {
      const start = i;
      const inner: string[] = [];
      while (i < to) {
        if (isBlank(lines[i])) {
          // A blank line ends the quote only when the next non-blank is not a quote.
          let k = i + 1;
          while (k < to && isBlank(lines[k])) k++;
          if (k >= to || !quotePrefix(lines[k])) break;
        }
        const q = quotePrefix(lines[i]);
        if (!q) {
          if (isBlank(lines[i])) break;
          // Lazy continuation: add the line as-is if it is paragraph-like.
          if (isFence(lines[i]) || atxHeading(lines[i]) || isHr(lines[i]) || listMarker(lines[i])) break;
          inner.push(lines[i]);
          i++;
          continue;
        }
        inner.push(q.rest);
        i++;
      }
      blocks.push({ type: 'quote', start: start + 1, end: i, children: parseBlocks(inner, 0, inner.length, refs, depth + 1) });
      continue;
    }
    const marker = listMarker(line);
    if (marker) {
      const list = parseList(lines, i, to, marker, refs, depth);
      blocks.push(list.block);
      i = list.next;
      continue;
    }
    // GFM table: a row, then an align row.
    if (i + 1 < to && line.includes('|') && isAlignRow(lines[i + 1])) {
      const align = isAlignRow(lines[i + 1])!;
      const head = splitTableRow(line).map((c) => parseInline(c, refs, 0));
      const start = i;
      i += 2;
      const rows: Inline[][][] = [];
      while (i < to && lines[i].includes('|') && !isBlank(lines[i]) && !isFence(lines[i]) && !listMarker(lines[i]) && !quotePrefix(lines[i]) && !atxHeading(lines[i])) {
        rows.push(splitTableRow(lines[i]).map((c) => parseInline(c, refs, 0)));
        i++;
      }
      blocks.push({ type: 'table', start: start + 1, end: i, align, head, rows });
      continue;
    }
    // Indented code block.
    if (leadingSpaces(line) >= 4) {
      const start = i;
      const body: string[] = [];
      while (i < to && (leadingSpaces(lines[i]) >= 4 || isBlank(lines[i]))) {
        if (isBlank(lines[i]) ) {
          let k = i;
          while (k < to && isBlank(lines[k])) k++;
          if (k >= to || leadingSpaces(lines[k]) < 4) break;
        }
        body.push(lines[i].startsWith('    ') ? lines[i].slice(4) : lines[i].replace(/^\t/, ''));
        i++;
      }
      // Drop trailing blank lines in the body.
      while (body.length && isBlank(body[body.length - 1])) body.pop();
      blocks.push({ type: 'pre', start: start + 1, end: i, lang: '', text: body.join('\n') });
      continue;
    }
    // Paragraph (plus setext headings).
    const start = i;
    const para: string[] = [line];
    i++;
    while (i < to && !isBlank(lines[i])) {
      if (isFence(lines[i]) || atxHeading(lines[i]) || isHr(lines[i]) || quotePrefix(lines[i]) || listMarker(lines[i])) break;
      if (i + 1 < to && lines[i].includes('|') && isAlignRow(lines[i + 1]) && i === start) break;
      para.push(lines[i]);
      i++;
    }
    if (para.length >= 2) {
      const last = para[para.length - 1].trim();
      if (/^=+$/.test(last) || /^-+$/.test(last)) {
        const level = last[0] === '=' ? 1 : 2;
        const text = para.slice(0, -1).join('\n');
        blocks.push({ type: 'h', level, start: start + 1, end: i, children: parseInline(text, refs, 0) });
        continue;
      }
    }
    blocks.push({ type: 'p', start: start + 1, end: i, children: parseInline(para.join('\n'), refs, 0) });
  }
  return blocks;
}

function parseList(
  lines: string[],
  from: number,
  to: number,
  first: { indent: number; ordered: boolean; start: number; width: number },
  refs: Map<string, string>,
  depth: number,
): { block: Block; next: number } {
  if (depth + 1 > MAX_BLOCK_NESTING) throw new MarkdownLimitError('block nesting limit');
  const items: { start: number; end: number; children: Block[] }[] = [];
  let i = from;
  let lastEnd = from;
  while (i < to) {
    if (isBlank(lines[i])) {
      let k = i + 1;
      while (k < to && isBlank(lines[k])) k++;
      if (k >= to) break;
      const next = listMarker(lines[k]);
      if (next && next.indent <= first.indent + 1 && next.ordered === first.ordered) {
        i = k;
        continue;
      }
      // A blank then a non-item ends the list unless indented as item content.
      if (leadingSpaces(lines[k]) < first.width && !listMarker(lines[k])) break;
    }
    const m = listMarker(lines[i]);
    if (!m || m.ordered !== first.ordered || m.indent > first.indent + 1) {
      if (isBlank(lines[i])) {
        i++;
        continue;
      }
      break;
    }
    if (m.indent + 1 < first.indent) break;
    const itemStart = i;
    const itemWidth = m.width;
    const raw: string[] = [];
    // First line after the marker.
    raw.push(lines[i].slice(Math.min(itemWidth, lines[i].length)));
    i++;
    while (i < to) {
      if (isBlank(lines[i])) {
        let k = i + 1;
        while (k < to && isBlank(lines[k])) k++;
        if (k < to && (leadingSpaces(lines[k]) >= itemWidth || listMarker(lines[k]))) {
          raw.push('');
          i++;
          continue;
        }
        break;
      }
      const nxt = listMarker(lines[i]);
      if (nxt && nxt.indent <= first.indent + 1 && nxt.ordered === first.ordered) break;
      if (leadingSpaces(lines[i]) >= itemWidth) {
        raw.push(lines[i].slice(itemWidth));
        i++;
        continue;
      }
      // Lazy continuation of a paragraph.
      if (isFence(lines[i]) || atxHeading(lines[i]) || isHr(lines[i]) || quotePrefix(lines[i])) break;
      raw.push(lines[i].trimStart());
      i++;
    }
    items.push({ start: itemStart + 1, end: i, children: parseBlocks(raw, 0, raw.length, refs, depth + 1) });
    lastEnd = i;
  }
  const end = items.length ? items[items.length - 1].end : lastEnd;
  return {
    block: { type: 'list', ordered: first.ordered, begin: first.start, start: from + 1, end, items },
    next: i,
  };
}

// ---------------------------------------------------------------- inline

function parseInline(text: string, refs: Map<string, string>, emphasisDepth: number): Inline[] {
  if (emphasisDepth > MAX_EMPHASIS_NESTING) throw new MarkdownLimitError('emphasis nesting limit');
  const out: Inline[] = [];
  const pushText = (t: string) => {
    if (!t) return;
    const last = out[out.length - 1];
    if (last && last.type === 'text') last.text += t;
    else out.push({ type: 'text', text: t });
  };

  let i = 0;
  while (i < text.length) {
    const c = text[i];

    if (c === '\\' && i + 1 < text.length) {
      const n = text[i + 1];
      if ('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'.includes(n)) {
        pushText(n);
        i += 2;
        continue;
      }
    }

    if (c === '`') {
      let ticks = 0;
      while (i + ticks < text.length && text[i + ticks] === '`') ticks++;
      const close = findClosingTicks(text, i + ticks, ticks);
      if (close !== -1) {
        let code = text.slice(i + ticks, close);
        if (code.startsWith(' ') && code.endsWith(' ') && code.trim()) code = code.slice(1, -1);
        out.push({ type: 'code', text: code });
        i = close + ticks;
        continue;
      }
    }

    if (c === '!' && text[i + 1] === '[') {
      const link = readLink(text, i + 1, refs, true);
      if (link) {
        const alt = link.children.map(inlineText).join('') || link.rawUrl;
        const safe = link.safe;
        if (safe) out.push({ type: 'a', href: safe.href, kind: safe.kind, children: [{ type: 'text', text: alt }] });
        else pushText(alt);
        i = link.end;
        continue;
      }
    }

    if (c === '[') {
      const link = readLink(text, i, refs, false);
      if (link) {
        if (link.safe) out.push({ type: 'a', href: link.safe.href, kind: link.safe.kind, children: link.children });
        else for (const child of link.children) out.push(child);
        i = link.end;
        continue;
      }
    }

    if (c === '<') {
      const gt = text.indexOf('>', i + 1);
      if (gt !== -1 && gt - i <= 2048 && !text.slice(i, gt).includes('\n')) {
        const inner = text.slice(i + 1, gt);
        const safe = looksLikeAutolink(inner) ? sanitizeHref(inner) : null;
        if (safe && looksLikeAutolink(inner)) {
          out.push({ type: 'a', href: safe.href, kind: safe.kind, children: [{ type: 'text', text: inner }] });
          i = gt + 1;
          continue;
        }
        // Not an allowed autolink: emit the raw tag characters as text (including < and >).
        pushText(text.slice(i, gt + 1));
        i = gt + 1;
        continue;
      }
    }

    if (c === '*' || c === '_') {
      const em = readEmphasis(text, i, refs, emphasisDepth);
      if (em) {
        out.push(em.node);
        i = em.end;
        continue;
      }
    }

    if (c === '\n') {
      const lastLine = text[i - 1] === ' ' && text[i - 2] === ' ';
      if (lastLine) out.push({ type: 'br' });
      else pushText('\n');
      i++;
      continue;
    }

    // Advance one character. Anything else, including raw '<', is text.
    pushText(c);
    i++;
  }
  return out;
}

function looksLikeAutolink(inner: string): boolean {
  // CommonMark-style URI autolink or a mailto autolink. No whitespace.
  for (let i = 0; i < inner.length; i++) {
    const c = inner.charCodeAt(i);
    if (c <= 0x20 || c === 0x7f) return false;
  }
  if (inner.includes('@') && !inner.includes(':') && /^[^\s<>]+@[^\s<>]+$/.test(inner)) return true;
  return hasScheme(inner) !== null;
}

function findClosingTicks(text: string, from: number, ticks: number): number {
  let i = from;
  while (i < text.length) {
    if (text[i] === '`') {
      let n = 0;
      while (i + n < text.length && text[i + n] === '`') n++;
      if (n === ticks) return i;
      i += n;
      continue;
    }
    i++;
  }
  return -1;
}

function inlineText(n: Inline): string {
  if (n.type === 'text' || n.type === 'code') return n.text;
  if (n.type === 'br') return '\n';
  if (n.type === 'a' || n.type === 'em' || n.type === 'strong') return n.children.map(inlineText).join('');
  return '';
}

function readDestination(text: string, from: number): { url: string; end: number } | null {
  let i = from;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n')) i++;
  if (i >= text.length) return null;
  if (text[i] === '<') {
    const gt = text.indexOf('>', i + 1);
    if (gt === -1) return null;
    return { url: text.slice(i + 1, gt), end: gt + 1 };
  }
  // Bare destination: up to the first unescaped ) or whitespace, with balanced parens.
  let depth = 0;
  const start = i;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\' && i + 1 < text.length) {
      i += 2;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\n') break;
    if (c === '(') depth++;
    else if (c === ')') {
      if (depth === 0) break;
      depth--;
    }
    i++;
  }
  if (i === start) return null;
  return { url: text.slice(start, i), end: i };
}

function readLink(
  text: string,
  openBracket: number,
  refs: Map<string, string>,
  _image: boolean,
): { children: Inline[]; rawUrl: string; safe: SafeHref | null; end: number } | null {
  // Find the matching close bracket with a linear scan (nested [] counted).
  let i = openBracket + 1;
  let depth = 1;
  while (i < text.length && depth > 0) {
    if (text[i] === '\\' && i + 1 < text.length) {
      i += 2;
      continue;
    }
    if (text[i] === '[') depth++;
    else if (text[i] === ']') depth--;
    if (depth > 32) return null;
    i++;
  }
  if (depth !== 0) return null;
  const close = i - 1;
  const label = text.slice(openBracket + 1, close);
  let url: string | null = null;
  let end = close + 1;
  if (text[close + 1] === '(') {
    const dest = readDestination(text, close + 2);
    if (!dest) return null;
    let j = dest.end;
    while (j < text.length && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n')) j++;
    if (text[j] === '"' || text[j] === "'" || text[j] === '(') {
      const q = text[j] === '(' ? ')' : text[j];
      const qend = text.indexOf(q, j + 1);
      if (qend === -1) return null;
      j = qend + 1;
    }
    while (j < text.length && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n')) j++;
    if (text[j] !== ')') return null;
    url = dest.url;
    end = j + 1;
  } else if (text[close + 1] === '[') {
    const endLab = text.indexOf(']', close + 2);
    if (endLab === -1) return null;
    const key = normalizeLabel(text.slice(close + 2, endLab) || label);
    const dest = refs.get(key);
    if (dest === undefined) return null;
    url = dest;
    end = endLab + 1;
  } else {
    // Shortcut reference: [label]
    const dest = refs.get(normalizeLabel(label));
    if (dest === undefined) return null;
    url = dest;
  }
  const children = parseInline(label, refs, 0);
  return { children, rawUrl: url, safe: sanitizeHref(url), end };
}

function readEmphasis(
  text: string,
  from: number,
  refs: Map<string, string>,
  emphasisDepth: number,
): { node: Inline; end: number } | null {
  const ch = text[from];
  if (ch !== '*' && ch !== '_') return null;
  let run = 0;
  while (from + run < text.length && text[from + run] === ch) run++;
  if (run > 3) return null;
  // Find a matching closer of the same character, same length (1 = em, 2 = strong, 3 = strong+em).
  // Linear scan; no backtracking.
  const want = run === 3 ? 1 : run; // parse *** as em wrapping a later strong, or try exact first
  // Prefer the longest match of 2 then 1 for '**text**'.
  const tryLen = run >= 2 ? [Math.min(run, 2), 1] : [1];
  for (const len of tryLen) {
    const close = findEmphasisClose(text, from + run, ch, len);
    if (close === -1) continue;
    const inner = text.slice(from + len, close);
    const children = parseInline(inner, refs, emphasisDepth + 1);
    const node: Inline = len === 2 ? { type: 'strong', children } : { type: 'em', children };
    return { node, end: close + len };
  }
  return null;
}

function findEmphasisClose(text: string, from: number, ch: string, len: number): number {
  let i = from;
  while (i < text.length) {
    if (text[i] === '\\' && i + 1 < text.length) {
      i += 2;
      continue;
    }
    if (text[i] === '`') {
      let ticks = 0;
      while (i + ticks < text.length && text[i + ticks] === '`') ticks++;
      const close = findClosingTicks(text, i + ticks, ticks);
      i = close === -1 ? i + ticks : close + ticks;
      continue;
    }
    if (text[i] === ch) {
      let n = 0;
      while (i + n < text.length && text[i + n] === ch) n++;
      if (n >= len) return i;
      i += n;
      continue;
    }
    i++;
  }
  return -1;
}

// ---------------------------------------------------------------- render

function lineAttr(start: number, end: number): string {
  return start === end ? String(start) : `${start}-${end}`;
}

function renderInlines(nodes: Inline[]): ComponentChild[] {
  return nodes.map((n, i) => renderInline(n, i));
}

function renderInline(n: Inline, key: number): ComponentChild {
  switch (n.type) {
    case 'text':
      return n.text;
    case 'code':
      return h('code', { key }, n.text);
    case 'br':
      return h('br', { key });
    case 'em':
      return h('em', { key }, ...renderInlines(n.children));
    case 'strong':
      return h('strong', { key }, ...renderInlines(n.children));
    case 'a':
      if (n.kind === 'internal') return h('a', { key, href: n.href }, ...renderInlines(n.children));
      return h('a', { key, href: n.href, rel: 'noopener noreferrer nofollow', target: '_blank' }, ...renderInlines(n.children));
  }
}

function renderBlocks(blocks: Block[]): ComponentChild[] {
  return blocks.map((b, i) => renderBlock(b, i));
}

function renderBlock(b: Block, key: number): ComponentChild {
  const lines = lineAttr(b.start, b.end);
  switch (b.type) {
    case 'p':
      return h('p', { key, 'data-lines': lines }, ...renderInlines(b.children));
    case 'h': {
      const tag = (`h${Math.min(6, Math.max(1, b.level))}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6');
      return h(tag, { key, 'data-lines': lines }, ...renderInlines(b.children));
    }
    case 'pre':
      return h('pre', { key, 'data-lines': lines, class: b.lang ? `language-${b.lang}` : undefined }, h('code', null, b.text));
    case 'quote':
      return h('blockquote', { key, 'data-lines': lines }, ...renderBlocks(b.children));
    case 'list': {
      const tag = b.ordered ? 'ol' : 'ul';
      const items = b.items.map((item, j) =>
        h('li', { key: j, 'data-lines': lineAttr(item.start, item.end) }, ...renderBlocks(item.children)),
      );
      return h(tag, { key, 'data-lines': lines, start: b.ordered && b.begin !== 1 ? b.begin : undefined }, ...items);
    }
    case 'hr':
      return h('hr', { key, 'data-lines': lines });
    case 'table': {
      const ths = b.head.map((c, j) => h('th', { key: j, style: b.align[j] ? { textAlign: b.align[j]! } : undefined }, ...renderInlines(c)));
      const rows = b.rows.map((row, r) =>
        h(
          'tr',
          { key: r },
          ...row.map((c, j) => h('td', { key: j, style: b.align[j] ? { textAlign: b.align[j]! } : undefined }, ...renderInlines(c))),
        ),
      );
      return h(
        'div',
        { key, class: 'md-table', 'data-lines': lines },
        h('table', null, h('thead', null, h('tr', null, ...ths)), h('tbody', null, ...rows)),
      );
    }
  }
}

/** Parse and render Markdown to a Preact VNode tree. On error or a nesting limit, falls back to <pre>. */
export function renderMarkdown(text: string): ComponentChild {
  if (!text.trim()) return h('p', { class: 'muted' }, 'Empty.');
  try {
    const doc = parseMarkdown(text);
    return h('div', { class: 'md' }, ...renderBlocks(doc.blocks));
  } catch {
    return h('pre', { class: 'prose' }, text);
  }
}

export function Markdown({ text }: { text: string }): ComponentChild {
  return renderMarkdown(text);
}

/** Walk a VNode tree and collect every href (for tests). */
export function collectHrefs(node: unknown): string[] {
  const out: string[] = [];
  walkVNode(node, (n) => {
    const href = n && typeof n === 'object' ? (n as { props?: { href?: unknown } }).props?.href : undefined;
    if (typeof href === 'string') out.push(href);
  });
  return out;
}

/** Flatten visible text and, when asked, tag names from a VNode tree (for tests). */
export function collectText(node: unknown): string {
  const parts: string[] = [];
  const visit = (n: unknown): void => {
    if (n == null || n === false || n === true) return;
    if (typeof n === 'string' || typeof n === 'number') {
      parts.push(String(n));
      return;
    }
    if (Array.isArray(n)) {
      for (const c of n) visit(c);
      return;
    }
    if (typeof n === 'object' && n !== null && 'props' in n) {
      visit((n as { props?: { children?: unknown } }).props?.children);
    }
  };
  visit(node);
  return parts.join('');
}

export function collectTags(node: unknown): string[] {
  const tags: string[] = [];
  walkVNode(node, (n) => {
    if (typeof n.type === 'string') tags.push(n.type);
  });
  return tags;
}

function walkVNode(node: unknown, visit: (n: { type: unknown; props?: Record<string, unknown> }) => void): void {
  if (node == null || node === false || node === true) return;
  if (typeof node === 'string' || typeof node === 'number') return;
  if (Array.isArray(node)) {
    for (const c of node) walkVNode(c, visit);
    return;
  }
  if (typeof node === 'object' && 'type' in (node as object)) {
    const n = node as { type: unknown; props?: Record<string, unknown> };
    visit(n);
    walkVNode(n.props?.children, visit);
  }
}
