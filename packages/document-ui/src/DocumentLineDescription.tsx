import type { ReactElement, ReactNode } from 'react';
import type { DocumentDate } from '@breeze/shared/documents';

export interface DocumentLineDescriptionProps {
  title: string;
  blurb: string | null;
  workDate: DocumentDate | null;
  note: string | null;
  descriptor: string[];
  ticketText: string | null;
  qtyFold: string | null;
  /** Row key, used for the package-owned test ids (`document-line-*-<rowKey>`). */
  rowKey?: string;
  /** Decorative lead-in before the title (e.g. a child-line arrow); hidden from assistive tech. */
  titlePrefix?: ReactNode;
  /** Host-owned trailing text after the title (e.g. an internal "hidden" marker). */
  titleSuffix?: ReactNode;
}

const MUTED = 'mt-0.5 text-xs text-muted-foreground';

/** The description cell. The blurb carries `whitespace-pre-line` by construction,
 *  so a multi-line description can never collapse into one run (#9401). */
export function DocumentLineDescription({
  title, blurb, workDate, note, descriptor, ticketText, qtyFold, rowKey, titlePrefix, titleSuffix,
}: DocumentLineDescriptionProps): ReactElement {
  const id = (name: string) => (rowKey ? `document-line-${name}-${rowKey}` : undefined);
  return (
    <>
      {titlePrefix != null && <span aria-hidden="true">{titlePrefix}</span>}
      {title}
      {titleSuffix}
      {workDate && (
        <div className={MUTED} data-testid={id('date')}>
          <time dateTime={workDate.iso}>{workDate.text}</time>
        </div>
      )}
      {/* P-7: on phones Qty and Price fold under the description instead of clipping the table. */}
      {qtyFold && <div className={`${MUTED} tabular-nums sm:hidden`} data-testid={id('qty')}>{qtyFold}</div>}
      {blurb && <p className={`${MUTED} whitespace-pre-line`} data-testid={id('blurb')}>{blurb}</p>}
      {descriptor.map((d, i) => <div key={i} className={MUTED}>{d}</div>)}
      {note && <div className={MUTED} data-testid={id('worked-vs-billed')}>{note}</div>}
      {ticketText && <div className={MUTED} data-testid={id('ticket')}>{ticketText}</div>}
    </>
  );
}
