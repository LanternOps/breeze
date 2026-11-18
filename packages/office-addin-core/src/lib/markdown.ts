/**
 * Markdown → sanitized HTML for assistant chat messages (spec §11).
 *
 * Two-stage pipeline: `marked` parses Markdown (GFM: tables, fenced code,
 * task lists) to HTML, then DOMPurify strips anything dangerous (scripts,
 * event handlers, javascript: URLs, raw <iframe>/<object>, etc). A
 * model-authored image is rendered as a click-through link rather than an
 * `<img>` — see {@link installResourceHooks} for why.
 *
 * Designed to be STREAMING-FRIENDLY: it is called on every message_delta
 * append, so it must never throw on half-typed/incomplete Markdown (an
 * unterminated table row, a dangling code fence, a half-written link). marked
 * in non-strict mode degrades gracefully, and any parse error is caught and
 * falls back to escaped plain text rather than crashing the render.
 */
import { marked } from 'marked';
import DOMPurify, { type Config } from 'dompurify';

marked.setOptions({
  gfm: true, // tables, strikethrough, task lists, autolinks
  breaks: true, // treat single newlines as <br> — matches chat expectations
  // non-strict (pedantic:false) so partial/odd Markdown degrades instead of throwing
});

// Force every link to open in a new tab with no opener/referrer leakage.
// DOMPurify mutates nodes in-place via this hook, which also covers links that
// marked emitted from raw HTML, not just Markdown link syntax.
let hookInstalled = false;
function installLinkHook(): void {
  if (hookInstalled) return;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node instanceof HTMLElement && node.tagName === 'A' && node.hasAttribute('href')) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer nofollow');
    }
  });
  hookInstalled = true;
}

/**
 * Turn a model-authored `<img>` into a click-through link.
 *
 * Every element that makes the browser fetch a subresource the moment this
 * HTML is assigned to `innerHTML` is an exfiltration channel here, not a
 * rendering feature: the assistant has the open document / message in context,
 * so an image URL it emits carries whatever it encoded in that URL to any host
 * it names — no click, no confirmation, no visible sign. The other two AI
 * panels already enforce exactly this (see
 * `apps/web/src/lib/safeMarkdownImage.tsx` and
 * `apps/helper/src/lib/safeMarkdown.tsx`); this keeps the add-ins' shared
 * renderer in line with them, in HTML rather than React.
 *
 * `afterSanitizeElements` (not `afterSanitizeAttributes`) because the element
 * itself is replaced, not just its attributes; the replacement anchor is
 * built from a scheme-checked `src` and never re-parsed, so it cannot carry
 * markup of its own.
 */
let resourceHookInstalled = false;
function installResourceHooks(): void {
  if (resourceHookInstalled) return;
  DOMPurify.addHook('afterSanitizeElements', (node) => {
    if (!(node instanceof HTMLElement)) return;
    if (node.tagName === 'INPUT') {
      // Preserve GFM task-list checkboxes without admitting image inputs or
      // interactive controls supplied through raw HTML.
      if (node.getAttribute('type')?.toLowerCase() !== 'checkbox') {
        node.remove();
      } else {
        node.setAttribute('disabled', '');
      }
      return;
    }
    if (node.tagName !== 'IMG') return;
    const doc = node.ownerDocument;
    const src = node.getAttribute('src') ?? '';
    const alt = node.getAttribute('alt') ?? '';
    const label = alt.trim() || src;
    // Only http(s) survives as a link — same rule as the sibling renderers.
    const replacement = /^https?:\/\//i.test(src) ? doc.createElement('a') : doc.createTextNode(label);
    if (replacement instanceof HTMLElement) {
      replacement.setAttribute('href', src);
      replacement.setAttribute('target', '_blank');
      replacement.setAttribute('rel', 'noopener noreferrer nofollow');
      replacement.textContent = label;
    }
    node.parentNode?.replaceChild(replacement, node);
  });
  resourceHookInstalled = true;
}

const SANITIZE_CONFIG: Config = {
  // Limit output to chat formatting rather than DOMPurify's broader default
  // HTML/SVG/MathML policy. IMG and INPUT are constrained by the hook above.
  ALLOWED_TAGS: [
    'p', 'br', 'hr', 'div', 'span', 'blockquote', 'pre', 'code',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li',
    'strong', 'b', 'em', 'i', 'del', 's', 'u', 'small', 'mark',
    'sub', 'sup', 'kbd', 'samp', 'var', 'abbr', 'details', 'summary',
    'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
    'a', 'img', 'input',
  ],
  // No src/srcset, background, poster, or style attributes can survive. The
  // image hook reads src before attribute sanitization and emits only a link.
  ALLOWED_ATTR: [
    'href', 'title', 'target', 'rel', 'class', 'align', 'start',
    'colspan', 'rowspan', 'type', 'checked', 'disabled',
  ],
  ALLOW_DATA_ATTR: false,
};

/**
 * Parse Markdown and return sanitized HTML safe to inject via innerHTML.
 * Returns '' for blank input. Never throws.
 */
export function renderMarkdown(markdown: string): string {
  if (!markdown || !markdown.trim()) return '';
  installLinkHook();
  installResourceHooks();
  let html: string;
  try {
    // marked.parse is synchronous when no async extensions are registered.
    html = marked.parse(markdown, { async: false }) as string;
  } catch {
    // Incomplete/odd Markdown mid-stream: fall back to escaped plain text so
    // the user still sees their content rather than a broken render.
    html = escapeHtml(markdown);
  }
  // With no RETURN_DOM* flags set, sanitize returns a string.
  return DOMPurify.sanitize(html, SANITIZE_CONFIG);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
