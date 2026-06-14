/**
 * Markdown → sanitized HTML for assistant chat messages (spec §11).
 *
 * Two-stage pipeline: `marked` parses Markdown (GFM: tables, fenced code,
 * task lists) to HTML, then DOMPurify strips anything dangerous (scripts,
 * event handlers, javascript: URLs, raw <iframe>/<object>, etc).
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

const SANITIZE_CONFIG: Config = {
  // Allow target so our new-tab attribute survives sanitization.
  ADD_ATTR: ['target'],
  // Defense in depth even though marked never emits these.
  FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form'],
  FORBID_ATTR: ['style'],
};

/**
 * Parse Markdown and return sanitized HTML safe to inject via innerHTML.
 * Returns '' for blank input. Never throws.
 */
export function renderMarkdown(markdown: string): string {
  if (!markdown || !markdown.trim()) return '';
  installLinkHook();
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
