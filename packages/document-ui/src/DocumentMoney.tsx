import type { ReactElement } from 'react';
import type { DocumentMoney as DocumentMoneyValue } from '@breeze/shared/documents';

/** A formatted amount; a recurrence suffix (OD-11) is visual text plus screen-reader text. */
export function DocumentMoney({ value }: { value: DocumentMoneyValue }): ReactElement {
  return (
    <span>
      {value.text}
      {value.suffix && (
        <>
          <span aria-hidden>{value.suffix.text}</span>
          <span className="sr-only"> {value.suffix.srText}</span>
        </>
      )}
    </span>
  );
}
