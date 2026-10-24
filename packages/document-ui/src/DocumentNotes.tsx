import type { ReactElement } from 'react';

/** A labelled free-text block under a horizontal rule (invoice notes, short terms). */
export function DocumentNotes({ label, text, testId }: { label: string; text: string; testId?: string }): ReactElement {
  return (
    <section className="space-y-2 border-t pt-6" data-testid={testId}>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</h3>
      <p className="max-w-prose whitespace-pre-wrap text-pretty text-xs leading-relaxed text-muted-foreground">{text}</p>
    </section>
  );
}
