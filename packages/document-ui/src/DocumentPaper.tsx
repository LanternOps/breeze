import type { ReactElement, ReactNode } from 'react';
import type { DocumentThemeId } from '@breeze/shared';

/**
 * A utility class used by this package and by no host app. The built-CSS tests
 * (apps/web, apps/portal) look for it in the emitted stylesheet: if the host's
 * `@source` glob stops covering `packages/document-ui/src`, it disappears.
 */
export const PACKAGE_PROBE_CLASS = 'sm:px-[3.25rem]';

export function DocumentPaper({
  theme,
  testId,
  children,
}: {
  theme: DocumentThemeId;
  testId?: string;
  children: ReactNode;
}): ReactElement {
  return (
    <article
      data-document-root
      data-doc-theme={theme}
      data-testid={testId ?? 'document-root'}
      className={`doc-paper overflow-hidden rounded-xl border bg-card ${PACKAGE_PROBE_CLASS}`}
    >
      <div className="doc-accent-bg h-1.5" aria-hidden />
      <div className="space-y-10 px-4 py-7 sm:py-9">{children}</div>
    </article>
  );
}
