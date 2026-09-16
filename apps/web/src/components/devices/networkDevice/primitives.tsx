// Tiny presentational building blocks shared by every section on the network
// device detail page — a titled card and a label/value pair — kept separate
// so section modules don't each redefine the same two-line wrapper.

import type { ReactNode, RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { isBlank } from './format';

export function Section({
  title,
  children,
  testId,
  sectionRef,
}: {
  title: ReactNode;
  children: ReactNode;
  testId?: string;
  /** Programmatic focus target for an in-page shortcut. */
  sectionRef?: RefObject<HTMLDivElement | null>;
}) {
  return (
    <div
      ref={sectionRef}
      tabIndex={sectionRef ? -1 : undefined}
      className="rounded-md border bg-card p-4 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
      data-testid={testId}
    >
      <h3 className="text-sm font-semibold">{title}</h3>
      <div className="mt-3">{children}</div>
    </div>
  );
}

/** Announce missing values instead of reading or skipping a bare dash. */
export function UnknownValue() {
  const { t } = useTranslation('common');
  return <span aria-label={t('states.unknown')}>—</span>;
}

export function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium break-words">{isBlank(value) || value == null || value === '—' ? <UnknownValue /> : value}</dd>
    </div>
  );
}
