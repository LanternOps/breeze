import { useMemo } from 'react';
import { renderMarkdown } from '../lib/markdown';

/**
 * Renders an assistant message's Markdown as sanitized HTML (spec §11).
 *
 * The HTML is sanitized by `renderMarkdown` (DOMPurify) before it reaches
 * dangerouslySetInnerHTML, so no untrusted markup or scripts can execute.
 * Memoized on `text` so streaming appends only re-sanitize when content
 * actually changes. User messages stay plain text and must NOT use this.
 */
export function MarkdownMessage({
  text,
  className,
  testId,
}: {
  text: string;
  className?: string;
  testId?: string;
}) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return (
    <div
      className={className}
      data-testid={testId}
      // Safe: `html` is DOMPurify-sanitized markdown output, not raw user input.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
