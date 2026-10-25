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
    if (!(node instanceof HTMLElement) || node.tagName !== 'IMG') return;
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

/**
 * Elements that load a remote subresource with no click and no chat-pane use:
 * media containers and SVG (which can nest `<image>`, and `<video>`/`<picture>`
 * which can load posters/srcsets). Dropped outright rather than rewritten —
 * there is no useful text to preserve and no legitimate add-in feature needs
 * them. `<img>` is handled by the hook above so its alt text survives.
 */
const RESOURCE_LOADING_TAGS = ['video', 'audio', 'source', 'track', 'picture', 'svg', 'image'] as const;

const SANITIZE_CONFIG: Config = {
  // Allow target so our new-tab attribute survives sanitization.
  ADD_ATTR: ['target'],
  // Defense in depth even though marked never emits these.
  FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', ...RESOURCE_LOADING_TAGS],
  FORBID_ATTR: ['style'],
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
