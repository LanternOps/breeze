import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import type { BoardRow, ReadinessChip } from '@/lib/orgReadiness';

export type ChipSection = 'setup' | 'account' | 'all';

const TONE_CLASS: Record<ReadinessChip['tone'], string> = {
  warning: 'border-warning/40 bg-warning/10 text-warning-strong hover:bg-warning/20',
  destructive: 'border-destructive/30 bg-destructive/10 text-destructive hover:bg-destructive/20',
};

export interface ReadinessChipsProps {
  row: BoardRow;
  /** `all` = setup then account, for the phone card's single "Still needed" list. */
  section: ChipSection;
  /** `org-board-chip` on the table, `org-board-card-chip` on the phone cards (both render in jsdom). */
  testIdPrefix?: string;
}

/**
 * Exception-only readiness cell: one anchor per missing thing (each repairs
 * somewhere), a single quiet check when nothing is missing, a dash when the
 * section does not apply or the org was not in the payload, "Unavailable"
 * when the row's batch failed, and a skeleton while the batch is in flight.
 * Chips stop click propagation so the row's open-record hit area never fires
 * on top of a repair link.
 */
export function ReadinessChips({ row, section, testIdPrefix = 'org-board-chip' }: ReadinessChipsProps) {
  const { t } = useTranslation('organizations');
  const orgName = row.org.name;

  if (row.state === 'pending') {
    return (
      <span data-testid="org-board-chips-pending" className="inline-flex items-center gap-1.5" aria-busy="true">
        <span className="skeleton h-5 w-24 rounded-full" aria-hidden="true" />
        <span className="sr-only">{t('orgBoard.band.pending')}</span>
      </span>
    );
  }
  if (row.state === 'failed') {
    return (
      <span data-testid="org-board-chips-unavailable" className="text-xs text-muted-foreground">
        {t('orgBoard.chips.unavailable')}
      </span>
    );
  }
  const chips = row.chips;
  if (!chips) return <span className="text-muted-foreground">—</span>;
  if (section === 'account' && !chips.accountApplicable) {
    return (
      <span className="text-muted-foreground" title={t('orgBoard.chips.notApplicable')}>
        —
      </span>
    );
  }
  const list = section === 'setup' ? chips.setup : section === 'account' ? chips.account : [...chips.setup, ...chips.account];
  if (list.length === 0) {
    return (
      <span data-testid="org-board-chips-complete" className="inline-flex items-center gap-1 text-xs font-medium text-success">
        <Check className="h-3.5 w-3.5" aria-hidden="true" />
        {t('orgBoard.chips.complete')}
      </span>
    );
  }
  return (
    <span className="flex flex-wrap gap-1">
      {list.map((chip) => {
        const label = t(/* i18n-dynamic */ `orgBoard.chips.${chip.key}`, { count: chip.count });
        return (
          <a
            key={chip.key}
            href={chip.href}
            data-testid={`${testIdPrefix}-${chip.key}`}
            aria-label={t('orgBoard.chips.link', { chip: label, orgName })}
            title={t(/* i18n-dynamic */ `orgBoard.repair.${chip.target}`, { orgName })}
            onClick={(event) => event.stopPropagation()}
            className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium leading-none transition ${TONE_CLASS[chip.tone]}`}
          >
            {label}
          </a>
        );
      })}
    </span>
  );
}
