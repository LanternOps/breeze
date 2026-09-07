// Tiny presentational building blocks shared by every section on the network
// device detail page — a titled card and a label/value pair — kept separate
// so section modules don't each redefine the same two-line wrapper.

import type { ReactNode } from 'react';
import { isBlank } from './format';

export function Section({
  title,
  children,
  testId,
}: {
  title: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div className="rounded-md border bg-card p-4" data-testid={testId}>
      <h3 className="text-sm font-semibold">{title}</h3>
      <div className="mt-3">{children}</div>
    </div>
  );
}

export function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium break-words">{isBlank(value) ? '—' : (value ?? '—')}</dd>
    </div>
  );
}
