import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import '../../lib/i18n';

type Tone = 'verified' | 'checking' | 'unverified' | 'failed';

/** GET /backup/snapshots `integrityStatus` → what the operator sees. */
const TONE_BY_STATUS: Record<string, Tone> = {
  attested: 'verified',
  producer_only: 'verified',
  pending: 'checking',
  unattested: 'unverified',
  unattested_legacy: 'unverified',
  attestation_failed: 'failed',
};

const TONE_CLASS: Record<Tone, string> = {
  verified: 'border-success/40 bg-success/10 text-success',
  checking: 'border-muted-foreground/30 bg-muted text-muted-foreground',
  unverified: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  failed: 'border-destructive/40 bg-destructive/10 text-destructive',
};

/**
 * Whether a snapshot's contents are covered by a verified integrity record.
 * Renders nothing when the API does not report a status (an older server) or
 * reports one this client does not know.
 */
export default function SnapshotIntegrityBadge({ status, className }: { status?: string | null; className?: string }) {
  const { t } = useTranslation('backup');
  const tone = status ? TONE_BY_STATUS[status] : undefined;
  if (!tone) return null;
  return (
    <span
      data-testid="snapshot-integrity-badge"
      data-status={status}
      className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium', TONE_CLASS[tone], className)}
    >
      {t(/* i18n-dynamic */ `snapshotIntegrityBadge.${tone}`)}
    </span>
  );
}
