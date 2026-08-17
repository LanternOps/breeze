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

export interface RichTextTextBlock {
  kind: 'p' | 'h3' | 'h4' | 'li';
  ordinal?: number;
  indent: 0 | 1;
  runs: RichTextRun[];
}

/** One `<tr>` of a rich-text `<table>` (issue #3484). `header` is true for a row
 *  whose cells were `<th>` or that sat inside `<thead>` — drawn bold on a tinted
 *  fill, and repeated at the top of every page the table spills onto. Cells hold
 *  inline runs only, matching the sanitizer's cell contract. */
export interface RichTextTableRow {
  header: boolean;
  cells: RichTextRun[][];
}

export interface RichTextTableBlock {
  kind: 'table';
  rows: RichTextTableRow[];
}

export type RichTextBlock = RichTextTextBlock | RichTextTableBlock;

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

// ---------------------------------------------------------------------------
// Table assembly (#3484): <table> → one 'table' block. Rows are collected
// through thead/tbody/tfoot wrappers (and directly off <table>, which is what
// a bare `<table><tr>` paste produces). Cells are inline runs only — the
// sanitizer guarantees that, and anything block-level that slipped past it
// flattens through extractRuns rather than being dropped.
// ---------------------------------------------------------------------------

function collectTableRows(node: ElementNode, inHeader: boolean, rows: RichTextTableRow[]): void {
  for (const child of node.children) {
    if (child.type !== 'el') continue;
    if (child.tag === 'thead') collectTableRows(child, true, rows);
    else if (child.tag === 'tbody' || child.tag === 'tfoot') collectTableRows(child, false, rows);
    else if (child.tag === 'tr') {
      const cells: RichTextRun[][] = [];
      let allHeaderCells = true;
      for (const cell of child.children) {
        if (cell.type !== 'el' || (cell.tag !== 'td' && cell.tag !== 'th')) continue;
        if (cell.tag !== 'th') allHeaderCells = false;
        cells.push(extractRuns(cell.children, BASE_CTX));
      }
      if (cells.length === 0) continue;
      rows.push({ header: inHeader || allHeaderCells, cells });
    }
  }
}

function parseTableBlock(node: ElementNode): RichTextTableBlock | null {
  const rows: RichTextTableRow[] = [];
  collectTableRows(node, false, rows);
  return rows.length ? { kind: 'table', rows } : null;
}

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

/** Table parts orphaned from their `<table>` — see the root walk below. */
const STRAY_TABLE_TAGS = new Set(['thead', 'tbody', 'tfoot', 'tr', 'th', 'td']);

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
    } else if (node.tag === 'table') {
      flushInline();
      const table = parseTableBlock(node);
      if (table) blocks.push(table);
    } else if (STRAY_TABLE_TAGS.has(node.tag)) {
      // A `<tr>`/`<td>` that reached the document root without its `<table>`
      // (hand-written API/MCP HTML). The browser lays its text out as flowing
      // content, so buffer it as inline rather than dropping it from the PDF.
      pendingInline.push(node);
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

function styleFor(kind: RichTextTextBlock['kind']): BlockStyle {
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
  return drawBlocks(doc, parseRichText(html), opts, opts.fonts ?? DEFAULT_BODY_FONTS);
}

/** The block draw loop, split out of renderRichTextIntoPdf so the oversized-row
 *  degrade path in drawTableBlock can reuse it on synthetic paragraph blocks
 *  (which contain no tables, so the mutual recursion terminates at one level). */
function drawBlocks(doc: PDFKit.PDFDocument, blocks: RichTextBlock[], opts: RenderRichTextOpts, bodyFonts: BodyFonts): number {
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
    if (block.kind === 'table') {
      y = drawTableBlock(doc, block, opts, bodyFonts, y, gapBefore);
      gapBefore = TABLE_SPACING_AFTER;
      continue;
    }
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
function measureBlockHeight(doc: PDFKit.PDFDocument, block: RichTextTextBlock, width: number, fonts: BodyFonts): number {
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
      if (block.kind === 'table') {
        total += gapBefore + measureTableBlock(doc, block, width, bodyFonts);
        gapBefore = TABLE_SPACING_AFTER;
        continue;
      }
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
 *  around their own measure+draw pair (see tablePdf.ts's renderTableIntoPdf).
 *  `forceBold` ORs into every run's own bold state (mirrors styleFor(...).forceBold
 *  in the block draw loop) — table headers use this instead of wrapping the
 *  (already-sanitized, potentially tag-bearing) label HTML in a synthetic
 *  `<strong>` string, which would double-encode any real `<strong>`/`<em>`/etc.
 *  already in the label. */
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
  forceBold = false,
): void {
  if (!html || !html.trim()) return;
  drawRuns(doc, extractRuns(tokenize(html), BASE_CTX), x, y, width, fontSize, fonts ?? DEFAULT_BODY_FONTS, align, color, forceBold);
}

/** Run-sequence draw core shared by renderInlineRunsIntoPdf and the table-cell
 *  draw (which already holds parsed runs and must not re-serialize to HTML). */
function drawRuns(
  doc: PDFKit.PDFDocument,
  runs: RichTextRun[],
  x: number,
  y: number,
  width: number,
  fontSize: number,
  bodyFonts: BodyFonts,
  align: 'left' | 'center' | 'right' = 'left',
  color: string = TEXT_COLOR,
  forceBold = false,
): void {
  const effectiveRuns = runs.length ? runs : [{ text: '', bold: false, italic: false, underline: false }];
  effectiveRuns.forEach((run, i) => {
    const isFirst = i === 0;
    const isLast = i === effectiveRuns.length - 1;
    doc.font(fontFor(bodyFonts, forceBold || run.bold, run.italic)).fontSize(fontSize).fillColor(run.link ? LINK_COLOR : color);
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
 *  a single caller-supplied font size. `forceBold` must match whatever the
 *  paired renderInlineRunsIntoPdf draw call passes — table headers measure
 *  AND draw force-bold, so the reserved height accounts for the (often wider)
 *  bold glyph metrics. */
export function measureInlineRuns(doc: PDFKit.PDFDocument, html: string, width: number, fontSize: number, fonts?: BodyFonts, forceBold = false): number {
  const bodyFonts = fonts ?? DEFAULT_BODY_FONTS;
  const saved = saveFontState(doc);
  try {
    if (!html || !html.trim()) return 0;
    return measureRuns(doc, extractRuns(tokenize(html), BASE_CTX), width, fontSize, bodyFonts, forceBold);
  } finally {
    restoreFontState(doc, saved);
  }
}

/** Run-sequence measure core (counterpart to drawRuns). Mutates doc font state
 *  as it measures — callers save/restore around it. */
function measureRuns(doc: PDFKit.PDFDocument, runs: RichTextRun[], width: number, fontSize: number, bodyFonts: BodyFonts, forceBold = false): number {
  const effectiveRuns = runs.length ? runs : [{ text: '', bold: false, italic: false, underline: false }];
  const lines = countWrappedLines(doc, effectiveRuns, width, fontSize, bodyFonts, forceBold);
  const lineHeight = maxLineHeightForRuns(doc, effectiveRuns, fontSize, bodyFonts, forceBold);
  return lines * lineHeight;
}

// ---------------------------------------------------------------------------
// Rich-text <table> blocks (#3484)
//
// Deliberately NOT tablePdf.ts: that module renders the STRUCTURED `table`
// block type, whose author-supplied column weights / zebra / header style have
// no counterpart in pasted HTML — and it imports this module, so the dependency
// can only run one way. What the two share is the cell primitive (drawRuns /
// measureRuns above), which is where the formatting fidelity actually lives.
//
// Column widths are inferred, since HTML carries no weights: each column's
// weight is the longest plain-text cell in it, clamped so one prose-heavy
// column can't squeeze the rest below a readable floor.
// ---------------------------------------------------------------------------

const TABLE_FONT_SIZE = 10;
const TABLE_CELL_PADDING = 5;
const TABLE_MIN_COLUMN_WIDTH = 36;
const TABLE_SPACING_AFTER = 8;
const TABLE_HEADER_FILL = '#f1f5f9';
const TABLE_BORDER_COLOR = '#e2e8f0';
/** Clamp on a column's inferred weight — without an upper bound a single long
 *  paragraph cell would starve every other column down to the floor. */
const TABLE_MAX_COLUMN_WEIGHT = 60;

function runsPlainText(runs: RichTextRun[]): string {
  return runs.map((r) => r.text).join('');
}

function tableColumnCount(block: RichTextTableBlock): number {
  return block.rows.reduce((max, row) => Math.max(max, row.cells.length), 0);
}

/** Distribute `width` across the table's columns by inferred weight, flooring
 *  each at TABLE_MIN_COLUMN_WIDTH. Like tablePdf's distributeColumnWidths, the
 *  floor does not re-balance: a table with more columns than fit simply
 *  overflows rather than rendering illegibly narrow cells. */
function tableColumnWidths(block: RichTextTableBlock, width: number): number[] {
  const count = tableColumnCount(block);
  if (count === 0) return [];
  const weights = Array.from({ length: count }, (_, i) =>
    Math.min(
      TABLE_MAX_COLUMN_WEIGHT,
      Math.max(1, ...block.rows.map((row) => runsPlainText(row.cells[i] ?? []).trim().length)),
    ),
  );
  const totalWeight = weights.reduce((sum, w) => sum + w, 0) || count;
  return weights.map((w) => Math.max(TABLE_MIN_COLUMN_WIDTH, Math.round((width * w) / totalWeight)));
}

/** Row height = tallest cell in the row, padding included. Header rows are
 *  drawn bold, so they must be MEASURED bold — a themed bold face can carry
 *  taller line metrics than its regular face. */
function measureTableRow(doc: PDFKit.PDFDocument, row: RichTextTableRow, widths: number[], fonts: BodyFonts): number {
  const saved = saveFontState(doc);
  try {
    let tallest = 0;
    row.cells.forEach((cell, i) => {
      const columnWidth = widths[i];
      if (columnWidth === undefined) return;
      const inner = Math.max(0, columnWidth - 2 * TABLE_CELL_PADDING);
      tallest = Math.max(tallest, measureRuns(doc, cell, inner, TABLE_FONT_SIZE, fonts, row.header));
    });
    return tallest + 2 * TABLE_CELL_PADDING;
  } finally {
    restoreFontState(doc, saved);
  }
}

/** Height the table occupies with NO page breaks — repeated headers are not
 *  counted, exactly as measureRichText ignores pagination for every other block
 *  kind. Today's only caller (calloutPdf) passes a non-paginating ensureRoom, so
 *  measure and draw agree; a future paginating caller would need this to grow a
 *  page-aware variant rather than trusting this number. */
function measureTableBlock(doc: PDFKit.PDFDocument, block: RichTextTableBlock, width: number, fonts: BodyFonts): number {
  const widths = tableColumnWidths(block, width);
  return block.rows.reduce((total, row) => total + measureTableRow(doc, row, widths, fonts), 0);
}

function drawTableRow(
  doc: PDFKit.PDFDocument,
  row: RichTextTableRow,
  widths: number[],
  x: number,
  y: number,
  height: number,
  fonts: BodyFonts,
): void {
  const totalWidth = widths.reduce((sum, w) => sum + w, 0);
  if (row.header) {
    doc.save();
    doc.rect(x, y, totalWidth, height).fill(TABLE_HEADER_FILL);
    doc.restore();
  }
  let cx = x;
  widths.forEach((columnWidth, i) => {
    doc.save();
    doc.lineWidth(0.5).strokeColor(TABLE_BORDER_COLOR).rect(cx, y, columnWidth, height).stroke();
    doc.restore();
    drawRuns(
      doc,
      row.cells[i] ?? [],
      cx + TABLE_CELL_PADDING,
      y + TABLE_CELL_PADDING,
      Math.max(0, columnWidth - 2 * TABLE_CELL_PADDING),
      TABLE_FONT_SIZE,
      fonts,
      'left',
      TEXT_COLOR,
      row.header,
    );
    cx += columnWidth;
  });
}

/** Draw one table block, row at a time. Rows never split: the leading header
 *  row is redrawn on every page the table spills onto, and a row too tall for
 *  even a fresh page degrades BEFORE drawing into stacked "header: value"
 *  paragraphs (which paginate themselves) — so this can never loop asking for
 *  room that does not exist. Mirrors tablePdf.ts's contract for the structured
 *  block type, but detects the page break from doc.y rather than needing the
 *  richer EnsureRoomRich callback, keeping renderRichTextIntoPdf's public
 *  `ensureRoom: (needed) => number` signature (and all its call sites) intact. */
function drawTableBlock(
  doc: PDFKit.PDFDocument,
  block: RichTextTableBlock,
  opts: RenderRichTextOpts,
  fonts: BodyFonts,
  startY: number,
  gapBefore: number,
): number {
  const widths = tableColumnWidths(block, opts.width);
  if (widths.length === 0) return startY;
  const totalWidth = widths.reduce((sum, w) => sum + w, 0);
  const headerRow = block.rows[0]?.header ? block.rows[0] : null;
  const headerHeight = headerRow ? measureTableRow(doc, headerRow, widths, fonts) : 0;
  const usablePageHeight = doc.page.height - doc.page.margins.top - doc.page.margins.bottom;

  let y = startY;
  let leadingGap = gapBefore;
  block.rows.forEach((row, index) => {
    const height = measureTableRow(doc, row, widths, fonts);
    // ensureRoom decides from pdfkit's OWN cursor, which the per-cell draws
    // above leave wherever the LAST column ended — resync before every call so
    // the decision is anchored to the y this function tracks (same hazard and
    // fix as tablePdf.ts's renderTableIntoPdf).
    doc.y = y;
    const beforeDocY = doc.y;
    const reserved = opts.ensureRoom(leadingGap + height);
    const brokePage = doc.y !== beforeDocY;
    y = brokePage ? reserved : reserved + leadingGap;
    leadingGap = 0;

    if (brokePage && headerRow && index > 0) {
      drawTableRow(doc, headerRow, widths, opts.x, y, headerHeight, fonts);
      y += headerHeight;
    }

    if (height > usablePageHeight - headerHeight) {
      // Taller than a whole page even on its own — fall back to prose so the
      // content still reaches the reader instead of being clipped.
      const degraded: RichTextBlock[] = row.cells.map((cell, i) => {
        const label = headerRow ? runsPlainText(headerRow.cells[i] ?? []).trim() : '';
        const runs: RichTextRun[] = label
          ? [{ text: `${label}: `, bold: true, italic: false, underline: false }, ...cell]
          : [...cell];
        return { kind: 'p', indent: 0, runs };
      });
      y = drawBlocks(doc, degraded, { ...opts, width: totalWidth, startY: y }, fonts);
      return;
    }

    drawTableRow(doc, row, widths, opts.x, y, height, fonts);
    y += height;
  });

  // Leave pdfkit's cursor where this block actually ended, so the next block's
  // ensureRoom sees the table's true bottom rather than the last cell's.
  doc.y = y;
  return y;
}
