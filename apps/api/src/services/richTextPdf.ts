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

function fontFor(bold: boolean, italic: boolean): string {
  if (bold && italic) return 'Helvetica-BoldOblique';
  if (bold) return 'Helvetica-Bold';
  if (italic) return 'Helvetica-Oblique';
  return 'Helvetica';
}

export interface RenderRichTextOpts {
  x: number;
  width: number;
  startY: number;
  /** Reuse the caller's own pagination helper (e.g. quotePdf.ts's ensureSpace) —
   *  reserves `needed` px of vertical space, page-breaking first if it won't
   *  fit, and returns the y to draw at. */
  ensureRoom: (needed: number) => number;
}

/** Draw sanitized rich-text HTML into `doc` starting at opts.startY, paginating
 *  via opts.ensureRoom. Returns the new y cursor (below the last block + its
 *  trailing spacing), for the caller to continue drawing from. */
export function renderRichTextIntoPdf(doc: PDFKit.PDFDocument, html: string, opts: RenderRichTextOpts): number {
  const blocks = parseRichText(html);
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
      doc.font('Helvetica').fontSize(style.fontSize);
      gutter = Math.max(BULLET_INDENT, Math.ceil(doc.widthOfString(prefix)) + 4);
    }
    const indent = (isLi ? gutter : 0) + block.indent * NESTED_INDENT;
    const textX = opts.x + indent;
    const textWidth = opts.width - indent;

    const plainText = block.runs.map((r) => r.text).join('') || ' ';
    doc.font(fontFor(style.forceBold, false)).fontSize(style.fontSize);
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
      doc.font('Helvetica').fontSize(style.fontSize).fillColor(TEXT_COLOR);
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
      doc.font(fontFor(bold, run.italic)).fontSize(style.fontSize).fillColor(run.link ? LINK_COLOR : TEXT_COLOR);
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
