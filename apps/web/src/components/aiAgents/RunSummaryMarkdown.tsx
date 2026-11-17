import ReactMarkdown from 'react-markdown';

/**
 * UI critique finding #1 — the run summary is the AGENT'S OWN ACCOUNT of what
 * it found, and the model writes it in markdown. Rendering it as one flat
 * paragraph printed literal `**hostname**` and ran `1. **Failed backup**
 * (high)` into the surrounding prose.
 *
 * The renderer is the app's existing one (`react-markdown`, already used by
 * AiChatMessages/ScriptAiMessages) restricted to a safe subset. Shared with
 * the Wisp thread's specialist report post (#11673), which carries the same
 * summary, so the report reads the same in both places. Two
 * properties are load-bearing:
 *
 *  - NO `rehype-raw`, and `skipHtml`. react-markdown 10 does NOT drop raw HTML
 *    nodes by default — without `rehype-raw` it converts them to plain TEXT
 *    (a model-authored `<img onerror=…>` renders as the literal escaped
 *    string, never becomes markup, so it was never an XSS risk either way),
 *    but that still puts the raw tag soup on screen as noise. `skipHtml`
 *    drops those nodes outright instead of rendering their source as text.
 *    `dangerouslySetInnerHTML` remains forbidden here for the same reason it
 *    is forbidden on the narrative section — neither renderer ever hands the
 *    model's own string to `innerHTML`.
 *  - `allowedElements` is a strict allowlist (paragraphs, emphasis, inline
 *    code, code blocks, both list kinds, links); `unwrapDisallowed` keeps the
 *    TEXT of anything else (a heading, a table cell) instead of dropping
 *    content.
 */
const SUMMARY_ALLOWED_ELEMENTS = ['p', 'strong', 'em', 'code', 'pre', 'ul', 'ol', 'li', 'br', 'a'];

/** Only `http(s)` survives as a link; every other scheme (`javascript:`,
 *  `data:`, a bare relative path) renders as its own label text. */
function isSafeHttpUrl(href: string | undefined): boolean {
  return typeof href === 'string' && /^https?:\/\//i.test(href);
}

export default function RunSummaryMarkdown({ markdown }: { markdown: string }) {
  return (
    <ReactMarkdown
      allowedElements={SUMMARY_ALLOWED_ELEMENTS}
      unwrapDisallowed
      skipHtml
      components={{
        p: ({ children }) => <p className="mt-2 first:mt-0">{children}</p>,
        strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
        em: ({ children }) => <em className="italic">{children}</em>,
        code: ({ children }) => (
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]">{children}</code>
        ),
        pre: ({ children }) => (
          <pre className="mt-2 overflow-x-auto rounded bg-muted p-2 font-mono text-[0.9em]">{children}</pre>
        ),
        ul: ({ children }) => <ul className="mt-2 list-disc space-y-1 pl-5">{children}</ul>,
        ol: ({ children }) => <ol className="mt-2 list-decimal space-y-1 pl-5">{children}</ol>,
        a: ({ href, children }) =>
          isSafeHttpUrl(href) ? (
            <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
              {children}
            </a>
          ) : (
            <>{children}</>
          ),
      }}
    >
      {markdown}
    </ReactMarkdown>
  );
}
