import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { RestorePointStatus } from '@breeze/shared';
import { cn } from '@/lib/utils';

/**
 * The single renderer for a System Restore outcome (#4609 W08). Every page
 * imports this; none writes its own copy.
 *
 * Language is a hard constraint: the ledger records requests and observations,
 * never a promise that a restore point exists or can be restored, so no
 * string here may say "rollback available" / "you can roll back".
 */

/**
 * Structural superset of the agent-reported `RestorePointOutcome` (a stored
 * command result) and a ledger row's inline slice: `status` may be the
 * server-only 'requested', and any field may be null. `status` is widened to
 * string so a status from a newer API (version skew) renders generic copy
 * instead of crashing.
 */
export type RestorePointBadgeOutcome = {
  status: RestorePointStatus | (string & {});
  requestId?: string;
  durationMs?: number | null;
  message?: string | null;
  attemptedAt?: string | null;
  existingPointAgeMinutes?: number | null;
  frequencyMinutes?: number | null;
};

type Tone = 'neutral' | 'positive' | 'warning' | 'danger';

const TONE_CLASS: Record<Tone, string> = {
  neutral: 'border-border bg-muted text-muted-foreground',
  positive: 'border-success/30 bg-success/15 text-success',
  warning: 'border-warning/30 bg-warning/15 text-warning',
  danger: 'border-destructive/30 bg-destructive/15 text-destructive',
};

/** Agent free text can be arbitrarily long; the badge stays one short line. */
const MESSAGE_MAX_CHARS = 200;

function truncate(value: string): string {
  return value.length > MESSAGE_MAX_CHARS ? `${value.slice(0, MESSAGE_MAX_CHARS - 1)}…` : value;
}

/** 240 -> "4h", 90 -> "1h 30m", 45 -> "45m". */
function formatMinutes(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  if (total < 60) return `${total}m`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function formatClock(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

interface StatusEntry {
  tone: Tone;
  text: (t: TFunction, o: RestorePointBadgeOutcome) => string;
}

// Exhaustive over the shared union on purpose: adding a status to
// RESTORE_POINT_STATUSES fails typecheck here until it has approved copy.
const STATUS_MAP: Record<RestorePointStatus, StatusEntry> = {
  requested: { tone: 'neutral', text: (t) => t('badge.requested') },
  created: {
    tone: 'positive',
    text: (t, o) => {
      const time = formatClock(o.attemptedAt);
      return time ? t('badge.created', { time }) : t('badge.createdNoTime');
    },
  },
  existing_accepted: {
    // Neutral, not an error: the throttle is Windows' own protection and a
    // reused point is usually the answer the technician wanted.
    tone: 'neutral',
    text: (t, o) => {
      const hasAge = typeof o.existingPointAgeMinutes === 'number';
      const hasLimit = typeof o.frequencyMinutes === 'number';
      if (hasAge && hasLimit) {
        return t('badge.existingAccepted', {
          age: formatMinutes(o.existingPointAgeMinutes as number),
          limit: formatMinutes(o.frequencyMinutes as number),
        });
      }
      if (hasAge) {
        return t('badge.existingAcceptedAgeOnly', { age: formatMinutes(o.existingPointAgeMinutes as number) });
      }
      return t('badge.existingAcceptedNoDetail');
    },
  },
  skipped_disabled: { tone: 'warning', text: (t) => t('badge.skippedDisabled') },
  skipped_definition_only: { tone: 'neutral', text: (t) => t('badge.skippedDefinitionOnly') },
  skipped_no_mutation: { tone: 'neutral', text: (t) => t('badge.skippedNoMutation') },
  unsupported: { tone: 'neutral', text: (t) => t('badge.unsupported') },
  busy: { tone: 'warning', text: (t) => t('badge.busy') },
  insufficient_privileges: { tone: 'warning', text: (t) => t('badge.insufficientPrivileges') },
  verification_failed: { tone: 'warning', text: (t) => t('badge.verificationFailed') },
  failed: {
    tone: 'danger',
    text: (t, o) => {
      const message = o.message?.trim();
      // Plain string interpolation only; React renders the result as a text node.
      return message ? t('badge.failed', { message: truncate(message), interpolation: { escapeValue: false } }) : t('badge.failedNoMessage');
    },
  },
};

const UNKNOWN_ENTRY: StatusEntry = { tone: 'neutral', text: (t) => t('badge.unknown') };

function entryFor(status: string): StatusEntry {
  return Object.prototype.hasOwnProperty.call(STATUS_MAP, status)
    ? STATUS_MAP[status as RestorePointStatus]
    : UNKNOWN_ENTRY;
}

export default function RestorePointBadge({
  outcome,
  className,
}: {
  outcome: RestorePointBadgeOutcome | null | undefined;
  className?: string;
}) {
  const { t } = useTranslation('restorePoints');
  if (!outcome) return null;
  const entry = entryFor(outcome.status);
  return (
    <span
      data-testid="restore-point-badge"
      data-tone={entry.tone}
      className={cn(
        'inline-flex max-w-full items-center rounded-md border px-2 py-0.5 text-xs font-medium break-words',
        TONE_CLASS[entry.tone],
        className,
      )}
    >
      {entry.text(t, outcome)}
    </span>
  );
}

export { RestorePointBadge };
