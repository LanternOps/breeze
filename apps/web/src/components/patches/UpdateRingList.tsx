import { useMemo, useState } from 'react';
import {
  Search,
  ChevronLeft,
  ChevronRight,
  Pencil,
  Trash2,
  Layers,
} from 'lucide-react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

export type UpdateRingStatus = 'active' | 'disabled';

export type CategoryRule = {
  category: string;
  autoApprove: boolean;
  autoApproveSeverities?: Array<'critical' | 'important' | 'moderate' | 'low'>;
  /** Opt-in: also auto-approve patches with no severity rating in this
   *  category override (#3758). Absent on rules saved before the opt-in
   *  existed. */
  autoApproveUnrated?: boolean;
  deferralDaysOverride?: number | null;
};

// Ring-owned auto-approval gate (#1317): the WHAT-installs settings live on the
// ring, not the config policy.
export type RingAutoApprove = {
  enabled: boolean;
  severities: Array<'critical' | 'important' | 'moderate' | 'low'>;
  deferralDays: number;
  /** Third-party app updates auto-approve independently of severity. Absent on
   *  rings saved before the gate existed. */
  thirdPartyApps?: boolean;
  /** null = inherit the ring's hold. */
  thirdPartyDeferralDays?: number | null;
  /** Opt-in: also auto-approve patches with no severity rating (#3758).
   *  Absent on rings saved before the opt-in existed. */
  autoApproveUnrated?: boolean;
};

export type UpdateRingItem = {
  id: string;
  name: string;
  description?: string | null;
  enabled: boolean;
  ringOrder: number;
  deferralDays: number;
  deadlineDays?: number | null;
  gracePeriodHours: number;
  autoApprove?: RingAutoApprove;
  categoryRules?: CategoryRule[];
  compliancePercent?: number;
  deviceCount?: number;
  updatedAt?: string;
};

type UpdateRingListProps = {
  rings: UpdateRingItem[];
  onEdit?: (ring: UpdateRingItem) => void;
  onDelete?: (ring: UpdateRingItem) => void;
  onSelect?: (ring: UpdateRingItem) => void;
  pageSize?: number;
};

function formatDate(dateString: string | undefined, t: TFunction<'patches'>): string {
  if (!dateString) return t('updateRingList.emptyValue');
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;
  return date.toLocaleDateString();
}

function ComplianceBadge({ percent, t }: { percent?: number; t: TFunction<'patches'> }) {
  if (percent === undefined) return <span className="text-muted-foreground">{t('updateRingList.emptyValue')}</span>;

  const color =
    percent >= 90
      ? 'bg-success/15 text-success border-success/30'
      : percent >= 70
        ? 'bg-warning/15 text-warning border-warning/30'
        : 'bg-destructive/15 text-destructive border-destructive/30';

  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium',
        color
      )}
    >
      {percent}%
    </span>
  );
}

// Summarizes the ring's auto-approval gate: OS severities and third-party apps
// are independent switches, so a ring can auto-approve one, both, or neither.
function AutoApproveBadges({ ring, t }: { ring: UpdateRingItem; t: TFunction<'patches'> }) {
  const aa = ring.autoApprove;
  const osOn = !!aa?.enabled && aa.severities.length > 0;
  const tpOn = !!aa?.enabled && !!aa.thirdPartyApps;
  if (!osOn && !tpOn) {
    return <span className="text-muted-foreground">{t('updateRingList.badges.manual')}</span>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {osOn && (
        <span
          className="inline-flex items-center rounded-full border bg-muted/40 px-2 py-0.5 text-xs"
          data-testid={`ring-badge-os-${ring.id}`}
        >
          {t('updateRingList.badges.os', {
            severities: aa!.severities.map((s) => t(/* i18n-dynamic */ `updateRingForm.severities.${s}`)).join(', '),
          })}
        </span>
      )}
      {tpOn && (
        <span
          className="inline-flex items-center rounded-full border bg-muted/40 px-2 py-0.5 text-xs"
          data-testid={`ring-badge-third-party-${ring.id}`}
        >
          {t('updateRingList.badges.thirdParty')}
        </span>
      )}
    </div>
  );
}

export default function UpdateRingList({
  rings,
  onEdit,
  onDelete,
  onSelect,
  pageSize = 8,
}: UpdateRingListProps) {
  const { t } = useTranslation('patches');
  const [query, setQuery] = useState('');
  const [currentPage, setCurrentPage] = useState(1);

  const filteredRings = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return rings.filter((ring) => {
      if (normalizedQuery.length === 0) return true;
      return (
        ring.name.toLowerCase().includes(normalizedQuery) ||
        ring.description?.toLowerCase().includes(normalizedQuery)
      );
    });
  }, [rings, query]);

  const totalPages = Math.ceil(filteredRings.length / pageSize);
  const startIndex = (currentPage - 1) * pageSize;
  const paginatedRings = filteredRings.slice(startIndex, startIndex + pageSize);

  return (
    <div className="rounded-lg border bg-card p-6 shadow-xs">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Layers className="h-5 w-5 text-primary" />
          <div>
            <h2 className="text-lg font-semibold">{t('updateRingList.title')}</h2>
            <p className="text-sm text-muted-foreground">
              {t('updateRingList.summary', { shown: filteredRings.length, total: rings.length })}
            </p>
          </div>
        </div>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            placeholder={t('updateRingList.searchPlaceholder')}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCurrentPage(1);
            }}
            className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring sm:w-48"
          />
        </div>
      </div>

      <div className="mt-6 overflow-x-auto rounded-md border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">{t('updateRingList.table.order')}</th>
              <th className="px-4 py-3">{t('updateRingList.table.ring')}</th>
              <th className="px-4 py-3">{t('updateRingList.table.deferral')}</th>
              <th className="px-4 py-3">{t('updateRingList.table.deadline')}</th>
              <th className="px-4 py-3">{t('updateRingList.table.autoApprove')}</th>
              <th className="px-4 py-3">{t('updateRingList.table.devices')}</th>
              <th className="px-4 py-3">{t('updateRingList.table.compliance')}</th>
              <th className="px-4 py-3">{t('updateRingList.table.updated')}</th>
              <th className="px-4 py-3 text-right">{t('updateRingList.table.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {paginatedRings.length === 0 ? (
              <tr>
                <td
                  colSpan={9}
                  className="px-4 py-6 text-center text-sm text-muted-foreground"
                >
                  {t('updateRingList.empty')}
                </td>
              </tr>
            ) : (
              paginatedRings.map((ring) => (
                <tr key={ring.id} className="text-sm">
                  <td className="px-4 py-3">
                    <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
                      {ring.ringOrder}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      onClick={() => onSelect?.(ring)}
                      className="text-left"
                    >
                      <div className="font-medium text-foreground hover:text-primary">
                        {ring.name}
                      </div>
                      {ring.description && (
                        <div className="text-xs text-muted-foreground line-clamp-1">
                          {ring.description}
                        </div>
                      )}
                    </button>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {ring.deferralDays === 0
                      ? t('updateRingList.none')
                      : t('updateRingList.days', { count: ring.deferralDays })}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {ring.deadlineDays == null
                      ? t('updateRingList.none')
                      : t('updateRingList.days', { count: ring.deadlineDays })}
                  </td>
                  <td className="px-4 py-3">
                    <AutoApproveBadges ring={ring} t={t} />
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {ring.deviceCount ?? t('updateRingList.emptyValue')}
                  </td>
                  <td className="px-4 py-3">
                    <ComplianceBadge percent={ring.compliancePercent} t={t} />
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {formatDate(ring.updatedAt, t)}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => onEdit?.(ring)}
                        aria-label={t('updateRingList.editRing', { name: ring.name })}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md border hover:bg-muted"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => onDelete?.(ring)}
                        aria-label={t('updateRingList.deleteRing', { name: ring.name })}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md border text-destructive hover:bg-destructive/10"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
          <span>
            {t('updateRingList.pageStatus', { current: currentPage, total: totalPages })}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCurrentPage((prev) => Math.max(prev - 1, 1))}
              disabled={currentPage === 1}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border disabled:opacity-50"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setCurrentPage((prev) => Math.min(prev + 1, totalPages))}
              disabled={currentPage === totalPages}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border disabled:opacity-50"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
