import { trustStatusLabel, trustStatusPillRole, type TrustControlStatus, type TrustPillRole } from '@breeze/shared';

const ROLE_CLASSES: Record<TrustPillRole, string> = {
  success: 'border-success/30 bg-success/10 text-success',
  warning: 'border-warning/40 bg-warning/15 text-warning',
  danger: 'border-destructive/40 bg-destructive/10 text-destructive',
  neutral: 'border-border bg-muted text-muted-foreground',
};

export function TrustStatusPill({ status }: { status: TrustControlStatus }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${ROLE_CLASSES[trustStatusPillRole(status)]}`}>
      {trustStatusLabel(status)}
    </span>
  );
}
