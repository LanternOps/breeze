// Formatted rich-text PDF renderer for proposal/contract documents.
//
// Consumes SANITIZED subset HTML only (see richTextSanitize.ts / RICH_TEXT_ALLOWED_TAGS:
// p, br, strong, em, u, h3, h4, ul, ol, li, a) — because the input is already
// machine-sanitized to those 11 tags, a small hand-rolled tokenizer over that
// fixed grammar is safe and avoids pulling in a new HTML/DOM parsing dependency.
//
// Two exports:
//  - parseRichText(html): pure parser → an intermediate block/run representation,
//    tested directly (no PDF byte inspection needed).
//  - renderRichTextIntoPdf(doc, html, opts): draws the parsed blocks into an
//    existing pdfkit document, reusing the CALLER's pagination helper via
//    opts.ensureRoom (never invents its own page-break logic) — see quotePdf.ts's
//    rich_text block branch for the wiring, and contract document rendering
//    (Task 14) for the other consumer.

import type { PdfThemeFonts } from './documentThemes';

// ---------------------------------------------------------------------------
// Intermediate representation
// ---------------------------------------------------------------------------

export interface RichTextRun {
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  link?: string;
}

export interface RichTextBlock {
  kind: 'p' | 'h3' | 'h4' | 'li';
  ordinal?: number;
  indent: 0 | 1;
  runs: RichTextRun[];
}

// ---------------------------------------------------------------------------
// Minimal tokenizer / tree builder over the known 11-tag subset. Not a general
// HTML parser — it trusts the input is already sanitized (Task 1), but is
// defensive about malformed nesting (stray/unmatched closing tags) so it never
// throws on unexpected input.
// ---------------------------------------------------------------------------

interface ElementNode {
  type: 'el';
  tag: string;
  attrs: Record<string, string>;
  children: RichNode[];
}
interface TextNode {
  type: 'text';
  text: string;
}
type RichNode = ElementNode | TextNode;

const ENTITY_MAP: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

function decodeEntities(raw: string): string {
  return raw.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, entity: string) => {
    if (entity[0] === '#') {
      const codePoint = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      // String.fromCodePoint throws RangeError outside 0..0x10FFFF (and for lone
      // surrogates) — fall back to the original text rather than letting a
      // malformed numeric character reference crash the render.
      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return whole;
      }
    }
    return ENTITY_MAP[entity] ?? whole;
  });
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRe = /([a-zA-Z_:][a-zA-Z0-9_:.-]*)(?:\s*=\s*("[^"]*"|'[^']*'))?/g;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(raw))) {
    const name = m[1]!.toLowerCase();
    const value = m[2] ? m[2].slice(1, -1) : '';
    attrs[name] = decodeEntities(value);
  }
  return attrs;
}

// Matches either a tag (`<p>`, `</p>`, `<br/>`, `<a href="...">`) or a run of
// plain text up to the next `<`.
const TAG_OR_TEXT_RE = /<(\/)?([a-zA-Z][a-zA-Z0-9]*)([^>]*)>|([^<]+)/g;

function tokenize(html: string): RichNode[] {
  const root: RichNode[] = [];
  const stack: { tag: string; children: RichNode[] }[] = [{ tag: '#root', children: root }];
  TAG_OR_TEXT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_OR_TEXT_RE.exec(html))) {
    const textRun = m[4];
    if (textRun !== undefined) {
      const text = decodeEntities(textRun);
      if (text.length) stack[stack.length - 1]!.children.push({ type: 'text', text });
      continue;
    }
    const closing = m[1] === '/';
    const tag = m[2]!.toLowerCase();
    const rawAttrs = m[3] ?? '';
    const selfClosing = /\/\s*$/.test(rawAttrs) || tag === 'br';
    if (closing) {
      // Pop back to (and including) the matching open tag; ignore stray/unmatched
      // closing tags rather than throwing on malformed input.
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i]!.tag === tag) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const node: ElementNode = { type: 'el', tag, attrs: parseAttrs(rawAttrs.replace(/\/\s*$/, '')), children: [] };
    stack[stack.length - 1]!.children.push(node);
    if (!selfClosing) stack.push({ tag, children: node.children });
  }
  return root;
}

// ---------------------------------------------------------------------------
// Inline run extraction (strong/em/u/a/br → RichTextRun[]), with adjacent runs
// of identical formatting merged so consumers see one run per formatting span
// rather than one run per source text node.
// ---------------------------------------------------------------------------

interface InlineCtx {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  link?: string;
}

function mergeAdjacentRuns(runs: RichTextRun[]): RichTextRun[] {
  const out: RichTextRun[] = [];
  for (const r of runs) {
    const prev = out[out.length - 1];
    if (prev && prev.bold === r.bold && prev.italic === r.italic && prev.underline === r.underline && prev.link === r.link) {
      prev.text += r.text;
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

function extractRuns(nodes: RichNode[], ctx: InlineCtx): RichTextRun[] {
  const runs: RichTextRun[] = [];
  const push = (text: string, c: InlineCtx) => {
    runs.push({ text, bold: c.bold, italic: c.italic, underline: c.underline, ...(c.link ? { link: c.link } : {}) });
  };
  const walk = (list: RichNode[], c: InlineCtx) => {
    for (const n of list) {
      if (n.type === 'text') {
        if (n.text.length) push(n.text, c);
        continue;
      }
      if (n.tag === 'br') {
        push('\n', c);
        continue;
      }
      // Unknown/unexpected tags (defensive — sanitized input shouldn't produce
      // these) fall through and just render their text content unformatted.
      const next: InlineCtx = { ...c };
      if (n.tag === 'strong') next.bold = true;
      else if (n.tag === 'em') next.italic = true;
      else if (n.tag === 'u') next.underline = true;
      else if (n.tag === 'a' && n.attrs.href) next.link = n.attrs.href;
      walk(n.children, next);
    }
  };
  walk(nodes, ctx);
  return mergeAdjacentRuns(runs);
}

const BASE_CTX: InlineCtx = { bold: false, italic: false, underline: false };

// ---------------------------------------------------------------------------
// Block assembly: p/h3/h4 → one block each; ul/ol → one 'li' block per <li>,
// numbering ol items 1..n (ul items get no ordinal). Nested lists (beyond the
// one level the subset realistically needs for proposal fidelity) flatten to
// indent 1 rather than growing indent per depth.
// ---------------------------------------------------------------------------

function collectListItems(list: ElementNode, indent: 0 | 1, blocks: RichTextBlock[]): void {
  let ordinal = 0;
  for (const child of list.children) {
    if (child.type !== 'el' || child.tag !== 'li') continue;
    ordinal += 1;
    const inline: RichNode[] = [];
    const nestedLists: ElementNode[] = [];
    for (const c of child.children) {
      if (c.type === 'el' && (c.tag === 'ul' || c.tag === 'ol')) nestedLists.push(c);
      else inline.push(c);
    }
    blocks.push({
      kind: 'li',
      ...(list.tag === 'ol' ? { ordinal } : {}),
      indent,
      runs: extractRuns(inline, BASE_CTX),
    });
    for (const nested of nestedLists) collectListItems(nested, 1, blocks);
  }
}

// Inline tags that can legitimately appear at the document root when the HTML
// wasn't produced by the TipTap editor (raw API/MCP contract bodies) — folded
// into an implicit paragraph so the PDF matches the browser's HTML render
// (which lays out stray root inline content as flowing text).
const ROOT_INLINE_TAGS = new Set(['strong', 'em', 'u', 'a', 'br']);

/** Parse sanitized rich-text subset HTML into an ordered block list. Pure /
 *  side-effect-free — safe to unit test without any PDF rendering. */
export function parseRichText(html: string): RichTextBlock[] {
  if (!html || !html.trim()) return [];
  const nodes = tokenize(html);
  const blocks: RichTextBlock[] = [];

  // Buffer stray root-level text / inline nodes and flush them as one implicit
  // paragraph whenever a block-level element interrupts (or at the end). Without
  // this, root inline content — reachable via the raw API/MCP, not the editor —
  // was silently dropped from the PDF while still rendering in the HTML view.
  let pendingInline: RichNode[] = [];
  const flushInline = (): void => {
    if (pendingInline.length === 0) return;
    const runs = extractRuns(pendingInline, BASE_CTX);
    pendingInline = [];
    // Ignore whitespace-only buffers (newlines between block tags) — they must
    // not manufacture empty paragraphs.
    if (runs.some((r) => r.text.trim().length > 0)) {
      blocks.push({ kind: 'p', indent: 0, runs });
    }
  };

  for (const node of nodes) {
    if (node.type === 'text') {
      pendingInline.push(node);
      continue;
    }
    if (node.tag === 'p' || node.tag === 'h3' || node.tag === 'h4') {
      flushInline();
      blocks.push({ kind: node.tag, indent: 0, runs: extractRuns(node.children, BASE_CTX) });
    } else if (node.tag === 'ul' || node.tag === 'ol') {
      flushInline();
      collectListItems(node, 0, blocks);
    } else if (ROOT_INLINE_TAGS.has(node.tag)) {
      pendingInline.push(node);
    }
    // Any other stray top-level tag is ignored — defensive only; the sanitizer
    // guarantees only the subset survives at the document root.
  }
  flushInline();
  return blocks;
}

// ---------------------------------------------------------------------------
// PDF rendering: draws the parsed blocks with pdfkit `continued: true` runs.
// ---------------------------------------------------------------------------

const BULLET_INDENT = 14;
const NESTED_INDENT = 14;
const TEXT_COLOR = '#1f2937';
const LINK_COLOR = '#2563eb';

interface BlockStyle {
  fontSize: number;
  spacingAfter: number;
  forceBold: boolean;
}

function styleFor(kind: RichTextBlock['kind']): BlockStyle {
  if (kind === 'h3') return { fontSize: 13, spacingAfter: 8, forceBold: true };
  if (kind === 'h4') return { fontSize: 11.5, spacingAfter: 8, forceBold: true };
  return { fontSize: 11, spacingAfter: 8, forceBold: false }; // 'p' | 'li'
}

/** Default Helvetica set — used when a caller doesn't opt into a theme (all
 *  existing call sites), so their behavior is byte-for-byte unchanged. */
const DEFAULT_BODY_FONTS: BodyFonts = {
  regular: 'Helvetica',
  bold: 'Helvetica-Bold',
  italic: 'Helvetica-Oblique',
  boldItalic: 'Helvetica-BoldOblique',
};

export type BodyFonts = PdfThemeFonts['body'];

function fontFor(fonts: BodyFonts, bold: boolean, italic: boolean): string {
  if (bold && italic) return fonts.boldItalic;
  if (bold) return fonts.bold;
  if (italic) return fonts.italic;
  return fonts.regular;
}

export interface RenderRichTextOpts {
  x: number;
  width: number;
  startY: number;
  /** Reuse the caller's own pagination helper (e.g. quotePdf.ts's ensureSpace) —
   *  reserves `needed` px of vertical space, page-breaking first if it won't
   *  fit, and returns the y to draw at. */
  ensureRoom: (needed: number) => number;
  /** Body font set to draw with (Task 6's theme threading). Defaults to the
   *  classic Helvetica set — pass `documentThemes.ts`'s registerThemeFonts(...)
   *  .body to draw in a document's theme instead. */
  fonts?: BodyFonts;
}

/** Draw sanitized rich-text HTML into `doc` starting at opts.startY, paginating
 *  via opts.ensureRoom. Returns the new y cursor (below the last block + its
 *  trailing spacing), for the caller to continue drawing from. */
export function renderRichTextIntoPdf(doc: PDFKit.PDFDocument, html: string, opts: RenderRichTextOpts): number {
  const bodyFonts = opts.fonts ?? DEFAULT_BODY_FONTS;
  const blocks = parseRichText(html);
  // Side-by-side callers can legitimately leave pdfkit's implicit cursor at the
  // bottom of the column drawn last rather than the lower of both columns.
  // startY is the public contract; synchronize doc.y before ensureRoom reads it.
  doc.y = opts.startY;
  let y = opts.startY;
  // The gap BEFORE the upcoming block (0 for the first block; each subsequent
  // block's leading gap is the PREVIOUS block's spacingAfter). Tracked explicitly
  // rather than folded into `y` up front — ensureRoom's overflow check needs the
  // gap counted as part of `needed`, and pdfkit's own `doc.y` cursor (updated by
  // the actual draw calls) never reflects a gap that hasn't been drawn as text.
  let gapBefore = 0;
  for (const block of blocks) {
    const style = styleFor(block.kind);
    // Ordered-list ordinals reach 2+ digits ("10.", "11.", …) which overflow the
    // fixed 14pt bullet gutter and character-wrap, garbling clause numbering.
    // Measure the actual prefix and widen the gutter to fit, shifting the text
    // start so the ordinal and the item text never overlap.
    const isLi = block.kind === 'li';
    const prefix = isLi ? (block.ordinal != null ? `${block.ordinal}.` : '•') : '';
    let gutter = 0;
    if (isLi) {
      doc.font(bodyFonts.regular).fontSize(style.fontSize);
      gutter = Math.max(BULLET_INDENT, Math.ceil(doc.widthOfString(prefix)) + 4);
    }
    const indent = (isLi ? gutter : 0) + block.indent * NESTED_INDENT;
    const textX = opts.x + indent;
    const textWidth = opts.width - indent;

    const plainText = block.runs.map((r) => r.text).join('') || ' ';
    doc.font(fontFor(bodyFonts, style.forceBold, false)).fontSize(style.fontSize);
    const blockHeight = doc.heightOfString(plainText, { width: textWidth });

    // Detect whether ensureRoom actually broke the page (vs. just confirming
    // there's room): addPage() resets pdfkit's own y cursor as a side effect, so
    // a changed doc.y means we landed on a fresh page and the leading gap
    // shouldn't be added (nothing to space away from at the top of a new page).
    const beforeDocY = doc.y;
    const reserved = opts.ensureRoom(gapBefore + blockHeight);
    const brokePage = doc.y !== beforeDocY;
    y = brokePage ? reserved : reserved + gapBefore;

    if (isLi) {
      doc.font(bodyFonts.regular).fontSize(style.fontSize).fillColor(TEXT_COLOR);
      // Draw the ordinal/bullet in its own measured gutter to the left of the
      // text. lineBreak:false guarantees the prefix stays a single line even if
      // a future font makes it marginally wider than the reserved gutter.
      doc.text(prefix, textX - gutter, y, { width: gutter, continued: false, lineBreak: false });
    }

    const runs = block.runs.length ? block.runs : [{ text: '', bold: false, italic: false, underline: false }];
    runs.forEach((run, i) => {
      const bold = style.forceBold || run.bold;
      const isFirst = i === 0;
      const isLast = i === runs.length - 1;
      doc.font(fontFor(bodyFonts, bold, run.italic)).fontSize(style.fontSize).fillColor(run.link ? LINK_COLOR : TEXT_COLOR);
      const textOptions: PDFKit.Mixins.TextOptions = {
        continued: !isLast,
        underline: run.underline || !!run.link,
        // Always set link explicitly (null, not omitted): pdfkit inherits omitted
        // options across `continued: true` runs, so a plain run following a link
        // run would otherwise keep the previous run's URL and make ALL trailing
        // text in the block a live link to it. `null` clears the inheritance.
        link: run.link ?? null,
      };
      if (isFirst) {
        doc.text(run.text, textX, y, { ...textOptions, width: textWidth });
      } else {
        doc.text(run.text, textOptions);
      }
    });
    doc.fillColor(TEXT_COLOR);

    y = doc.y;
    gapBefore = style.spacingAfter;
  }
  // Trailing gap after the last block, matching the convention every other
  // quotePdf block-type branch uses (e.g. `y = doc.y + 8` after a heading).
  return y + gapBefore;
}

// ---------------------------------------------------------------------------
// Measurement: same layout math as the draw loop above (:334-397), minus the
// drawing. Kept as a SEPARATE walk (not "draw with a no-op sink") because the
// draw loop leans on pdfkit's own `continued: true` line-wrapping, which has
// no read-only counterpart — so measurement re-derives line counts itself via
// per-run `widthOfString` + a greedy fill, mirroring what pdfkit's continued
// mode does. Any change to the draw loop's line-fill behavior must be mirrored
// here by hand.
// ---------------------------------------------------------------------------

/** doc._font / doc._fontSize aren't part of pdfkit's public TS surface, but
 *  they're exactly what doc.font()/doc.fontSize() mutate — save/restore them
 *  directly so measuring never leaks a font change into the caller's doc. */
interface PdfDocFontState {
  _font: unknown;
  _fontSize: number;
}

function saveFontState(doc: PDFKit.PDFDocument): PdfDocFontState {
  const d = doc as unknown as PdfDocFontState;
  return { _font: d._font, _fontSize: d._fontSize };
}

function restoreFontState(doc: PDFKit.PDFDocument, saved: PdfDocFontState): void {
  const d = doc as unknown as PdfDocFontState;
  d._font = saved._font;
  d._fontSize = saved._fontSize;
}

/** Greedy line-fill over a run sequence, mirroring pdfkit's own continued-text
 *  wrapping: walk words in source order, measuring each word at ITS run's
 *  actual font (so a bold run's wider glyphs wrap sooner than a regular run's
 *  would), and break to a new line whenever the running line width would
 *  exceed `width`. `\n` inside a run's text (from `<br>`) forces a hard break.
 *  Mutates doc.font/fontSize as it measures — caller is responsible for
 *  save/restore. */
function countWrappedLines(doc: PDFKit.PDFDocument, runs: RichTextRun[], width: number, fontSize: number, fonts: BodyFonts, forceBold: boolean): number {
  let lines = 1;
  let lineWidth = 0;
  for (const run of runs) {
    const font = fontFor(fonts, forceBold || run.bold, run.italic);
    doc.font(font).fontSize(fontSize);
    const segments = run.text.split('\n');
    segments.forEach((segment, segIndex) => {
      if (segIndex > 0) {
        // <br> — always a hard line break, matching pdfkit's own '\n' handling.
        lines += 1;
        lineWidth = 0;
      }
      if (!segment.length) return;
      // Keep whitespace as its own token (so its width counts toward the
      // current line) but never let a line START with one after a wrap.
      const tokens = segment.split(/(\s+)/).filter((t) => t.length > 0);
      for (const token of tokens) {
        const isWhitespace = token.trim().length === 0;
        const tokenWidth = doc.widthOfString(token);
        if (lineWidth > 0 && lineWidth + tokenWidth > width) {
          if (isWhitespace) continue; // drop trailing/would-be-leading space at a wrap point
          lines += 1;
          lineWidth = 0;
        }
        lineWidth += tokenWidth;
      }
    });
  }
  return lines;
}

/** The line height to charge PER LINE for a run sequence: the tallest
 *  `currentLineHeight(true)` among the DISTINCT fonts those runs actually draw
 *  in (forced-bold blocks, and each run's own bold/italic switch, both folded
 *  in via fontFor — same selection the draw loop uses). A themed bold/italic
 *  face can have taller line metrics than its regular face (e.g. condensed
 *  theme's DM Sans weights), so charging the regular face's line height alone
 *  would UNDER-measure any block containing a bold or italic run — the exact
 *  clipping failure this API exists to prevent. Never returns less than any
 *  font actually drawn in the block. */
function maxLineHeightForRuns(doc: PDFKit.PDFDocument, runs: RichTextRun[], fontSize: number, fonts: BodyFonts, forceBold: boolean): number {
  const usedFonts = new Set<string>();
  for (const run of runs) usedFonts.add(fontFor(fonts, forceBold || run.bold, run.italic));
  if (usedFonts.size === 0) usedFonts.add(fontFor(fonts, forceBold, false));
  let max = 0;
  for (const font of usedFonts) {
    doc.font(font).fontSize(fontSize);
    max = Math.max(max, doc.currentLineHeight(true));
  }
  return max;
}

/** Measures one block's height using the same per-run font selection, gutter,
 *  and indent math as the draw loop, but via countWrappedLines instead of an
 *  actual pdfkit draw. Returns the block's own height (excluding spacingAfter —
 *  callers accumulate that separately, matching renderRichTextIntoPdf). */
function measureBlockHeight(doc: PDFKit.PDFDocument, block: RichTextBlock, width: number, fonts: BodyFonts): number {
  const style = styleFor(block.kind);
  const isLi = block.kind === 'li';
  const prefix = isLi ? (block.ordinal != null ? `${block.ordinal}.` : '•') : '';
  let gutter = 0;
  if (isLi) {
    doc.font(fonts.regular).fontSize(style.fontSize);
    gutter = Math.max(BULLET_INDENT, Math.ceil(doc.widthOfString(prefix)) + 4);
  }
  const indent = (isLi ? gutter : 0) + block.indent * NESTED_INDENT;
  const textWidth = width - indent;

  const runs = block.runs.length ? block.runs : [{ text: '', bold: false, italic: false, underline: false }];
  const lines = countWrappedLines(doc, runs, textWidth, style.fontSize, fonts, style.forceBold);

  // includeGap=true matches doc.heightOfString's own line-height convention
  // (the draw loop's prior single-font blockHeight approximation used
  // heightOfString), so per-run measurement stays comparable to it.
  const lineHeight = maxLineHeightForRuns(doc, runs, style.fontSize, fonts, style.forceBold);
  return lines * lineHeight;
}

/** Height the given sanitized inline/block HTML would occupy at `width`,
 *  measured PER-RUN at the font each run will actually draw in (bold/italic
 *  switches included) — no drawing, doc font state saved/restored. */
export function measureRichText(doc: PDFKit.PDFDocument, html: string, width: number, fonts?: BodyFonts): number {
  const bodyFonts = fonts ?? DEFAULT_BODY_FONTS;
  const saved = saveFontState(doc);
  try {
    const blocks = parseRichText(html);
    let total = 0;
    let gapBefore = 0;
    for (const block of blocks) {
      const style = styleFor(block.kind);
      total += gapBefore + measureBlockHeight(doc, block, width, bodyFonts);
      gapBefore = style.spacingAfter;
    }
    // Trailing gap, matching renderRichTextIntoPdf's `return y + gapBefore`.
    return blocks.length ? total + gapBefore : 0;
  } finally {
    restoreFontState(doc, saved);
  }
}

/** Draw counterpart to measureInlineRuns — a single-line-wrapped run
 *  sequence (no block splitting, e.g. table cells) at `x, y`, per-run
 *  bold/italic/underline/link honored the same way the block draw loop above
 *  handles them (pdfkit `continued: true` runs so multiple formatting spans
 *  reflow as one wrapped paragraph). `align` is only meaningful passed on the
 *  FIRST run's text() call — pdfkit applies width/align to the whole
 *  continued-run paragraph, not per individual continued call. Restores
 *  doc.fillColor to TEXT_COLOR before returning (matching the block draw
 *  loop), but does NOT save/restore font state — callers already do that
 *  around their own measure+draw pair (see tablePdf.ts's renderTableIntoPdf). */
export function renderInlineRunsIntoPdf(
  doc: PDFKit.PDFDocument,
  html: string,
  x: number,
  y: number,
  width: number,
  fontSize: number,
  fonts?: BodyFonts,
  align: 'left' | 'center' | 'right' = 'left',
  color: string = TEXT_COLOR,
): void {
  const bodyFonts = fonts ?? DEFAULT_BODY_FONTS;
  if (!html || !html.trim()) return;
  const runs = extractRuns(tokenize(html), BASE_CTX);
  const effectiveRuns = runs.length ? runs : [{ text: '', bold: false, italic: false, underline: false }];
  effectiveRuns.forEach((run, i) => {
    const isFirst = i === 0;
    const isLast = i === effectiveRuns.length - 1;
    doc.font(fontFor(bodyFonts, run.bold, run.italic)).fontSize(fontSize).fillColor(run.link ? LINK_COLOR : color);
    const textOptions: PDFKit.Mixins.TextOptions = {
      continued: !isLast,
      underline: run.underline || !!run.link,
      link: run.link ?? null,
    };
    if (isFirst) {
      doc.text(run.text, x, y, { ...textOptions, width, align });
    } else {
      doc.text(run.text, textOptions);
    }
  });
  doc.fillColor(TEXT_COLOR);
}

/** Same per-run measurement for a single inline-runs string (table cells):
 *  no block splitting — the whole string is one line-wrapped run sequence at
 *  a single caller-supplied font size. */
export function measureInlineRuns(doc: PDFKit.PDFDocument, html: string, width: number, fontSize: number, fonts?: BodyFonts): number {
  const bodyFonts = fonts ?? DEFAULT_BODY_FONTS;
  const saved = saveFontState(doc);
  try {
    if (!html || !html.trim()) return 0;
    const runs = extractRuns(tokenize(html), BASE_CTX);
    const effectiveRuns = runs.length ? runs : [{ text: '', bold: false, italic: false, underline: false }];
    const lines = countWrappedLines(doc, effectiveRuns, width, fontSize, bodyFonts, false);
    const lineHeight = maxLineHeightForRuns(doc, effectiveRuns, fontSize, bodyFonts, false);
    return lines * lineHeight;
  } finally {
    restoreFontState(doc, saved);
  }
}
