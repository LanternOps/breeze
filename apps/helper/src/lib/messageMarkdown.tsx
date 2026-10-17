/**
 * Anti-phishing markdown renderer for endpoint messages (#8293).
 *
 * A message is technician-authored text shown to an end user under the IT
 * provider's name, so the generic `safeMarkdown` primitives are not enough on
 * their own: they accept `http:` and show any link label. This wrapper
 * enforces, on top of `SafeMarkdownLink`:
 *   - https only; `javascript:`, `http:`, `data:` and credentialed URLs render
 *     as plain text, never as an anchor;
 *   - the real host is always visible, and a label that looks like a
 *     different URL/host is replaced by the real host;
 *   - images and raw HTML render as inert text (nothing loads, nothing runs);
 *   - bare URLs are not auto-linked;
 *   - content over the shared limits (or flagged `plain`) renders as plain text.
 * Links keep `target="_blank"` exactly as `safeMarkdown` does, so they leave
 * the privileged webview; the label is never trusted.
 */
import type { ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';

import { SafeMarkdownLink } from './safeMarkdown';

/**
 * Mirrors `ENDPOINT_MESSAGE_LIMITS` in
 * `packages/shared/src/validators/endpointMessage.ts` (apps/helper does not
 * depend on @breeze/shared). Keep the two in step.
 */
export const MESSAGE_TITLE_MAX = 120;
export const MESSAGE_BODY_MAX = 2000;

/** Parsed https URL without credentials, or null. */
function parseHttps(href: string | undefined): URL | null {
  if (!href) return null;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !url.hostname) return null;
  if (url.username || url.password) return null;
  return url;
}

/** Visible text of react-markdown children. */
function textOf(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'object' && 'props' in node) {
    return textOf((node as { props: { children?: ReactNode } }).props.children);
  }
  return '';
}

/** The host a label claims to be, or null when it does not look like a URL/host. */
function claimedHostOfToken(token: string): string | null {
  // Strip wrapping/trailing punctuation: "(https://x.example)." etc.
  const t = token.replace(/^[("'<[]+/, '').replace(/[)"'>\],.;:!?]+$/, '');
  if (!t) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) {
    try {
      return new URL(t).hostname.toLowerCase();
    } catch {
      return t.toLowerCase();
    }
  }
  // Bare host or host/path: "www.bank.example", "bank.example/login". The TLD
  // must be alphabetic (2+) so "e.g." and "v1.2.3" are not hosts.
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(:\d+)?([/?#]\S*)?$/i.test(t)) {
    try {
      return new URL(`https://${t}`).hostname.toLowerCase();
    } catch {
      return t.toLowerCase();
    }
  }
  return null;
}

/**
 * The first host a label claims anywhere in its text ("Sign in at
 * https://login.contoso.com", "visit login.contoso.com now"), or null when no
 * token looks like a URL/host.
 */
function claimedHost(label: string): string | null {
  for (const token of label.split(/\s+/)) {
    const h = claimedHostOfToken(token);
    if (h !== null) return h;
  }
  return null;
}

function MessageLink({ href, children }: { href?: string; children?: ReactNode }) {
  const url = parseHttps(href);
  if (!url) {
    // Not a link at all: the label as inert text.
    return <span>{children}</span>;
  }
  const host = url.hostname.toLowerCase();
  const label = textOf(children);
  const claimed = claimedHost(label);
  if (claimed !== null) {
    // A URL-looking label: show only the real destination host.
    return <SafeMarkdownLink href={url.href}>{url.host}</SafeMarkdownLink>;
  }
  return (
    <>
      <SafeMarkdownLink href={url.href}>{children}</SafeMarkdownLink>{' '}
      <span className="helper-message-host">({url.host || host})</span>
    </>
  );
}

function MessageImage({ src, alt }: { src?: string; alt?: string }) {
  // Never an <img> or a link: show the markdown source so the user sees it
  // is not an image.
  return <span>{`![${alt ?? ''}](${src ?? ''})`}</span>;
}

const components: Components = {
  a: ({ href, children }) => <MessageLink href={href}>{children}</MessageLink>,
  img: ({ src, alt }) => <MessageImage src={typeof src === 'string' ? src : undefined} alt={alt} />,
};

const ALLOWED = ['p', 'strong', 'em', 'ul', 'ol', 'li', 'a', 'img', 'br', 'code'];

export function MessageMarkdown({
  body,
  plain = false,
}: {
  body: string;
  /** Render as plain text regardless (oversize/invalid content). */
  plain?: boolean;
}) {
  if (plain || body.length > MESSAGE_BODY_MAX) {
    return <p className="helper-message-plain">{body}</p>;
  }
  return (
    <div className="helper-message-markdown">
      <ReactMarkdown
        components={components}
        allowedElements={ALLOWED}
        unwrapDisallowed
        // Keep the raw href so scheme checks happen here, not in the default
        // sanitiser (which would silently blank some schemes).
        urlTransform={(u) => u}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}
