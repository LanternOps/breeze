import { useEffect, useRef, useState } from 'react';
import { Building2, ChevronDown, Mail, MapPin, Phone, Settings } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatDate } from '@/lib/dateTimeFormat';
import { statusColors, statusLabelKeys } from '@/lib/orgStatus';
import type { Organization } from '@/stores/orgStore';
import type { OrgRecordOrg, OrgSummary } from './orgRecordFetch';

export interface OrgRecordHeaderProps {
  org: OrgRecordOrg;
  summary: OrgSummary | null;
  /** Read-only: the whole archive lifecycle, not just `status === 'archived'`. */
  archived: boolean;
  /** Name of the org the OrgSwitcher points at, when that is NOT this record. */
  mismatchedScopeOrgName: string | null;
  onWorkHere: () => void;
  onOpenSettings: () => void;
  /** Omitted (with `onMerge`) while the record is read-only. */
  onArchive?: () => void;
  /** Merge is a partner-scope operation; system-scope sessions do not get it. */
  onMerge?: () => void;
}

/**
 * Identity header for the organization record: who this customer is, what
 * state they are in, and the three things you do from here (work in their
 * context, open their settings, run a lifecycle action).
 *
 * The status pill is ALWAYS rendered here, unlike the organizations list where
 * it is exception-only: the list uses absence to mean "nothing to see", which
 * only works when every row is visible side by side. On a page about one
 * customer there is nothing to compare against, so the state has to be stated.
 */
export default function OrgRecordHeader({
  org,
  summary,
  archived,
  mismatchedScopeOrgName,
  onWorkHere,
  onOpenSettings,
  onArchive,
  onMerge,
}: OrgRecordHeaderProps) {
  const { t } = useTranslation('organizations');
  const { t: tSettings } = useTranslation('settings');
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDocumentClick = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocumentClick);
    return () => document.removeEventListener('mousedown', onDocumentClick);
  }, [menuOpen]);

  // statusColors/statusLabelKeys are keyed by the store's Organization union.
  // A status the client does not know about still has to render something, so
  // fall back to the raw value rather than an empty pill.
  const statusKey = org.status as Organization['status'];
  const statusClass = statusColors[statusKey] ?? 'border-border bg-muted text-muted-foreground';
  const statusLabelKey = statusLabelKeys[statusKey];
  const statusLabel = statusLabelKey ? tSettings(/* i18n-dynamic */ statusLabelKey) : org.status;

  const primary = summary?.contacts?.primary ?? null;
  const siteCount = summary?.sites.count;
  const hasLifecycleActions = !archived && (onArchive || onMerge);

  return (
    <div data-testid="org-record-header" className="flex flex-col gap-4 border-b pb-5">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"
            aria-hidden="true"
          >
            <Building2 className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-xl font-semibold tracking-tight">{org.name}</h1>
              <span
                data-testid="org-record-status"
                className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${statusClass}`}
              >
                {statusLabel}
              </span>
              {org.type && (
                <span
                  data-testid="org-record-type"
                  className="inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
                >
                  {org.type === 'internal' ? t('orgRecord.header.type.internal') : t('orgRecord.header.type.customer')}
                </span>
              )}
            </div>

            <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
              {org.createdAt && <span>{t('orgRecord.header.created', { date: formatDate(org.createdAt) })}</span>}
              {typeof siteCount === 'number' && (
                <span className="inline-flex items-center gap-1">
                  <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
                  {t('orgRecord.header.sites', { count: siteCount })}
                </span>
              )}
            </div>

            {primary ? (
              <div
                data-testid="org-record-primary-contact"
                className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm"
              >
                <span className="text-muted-foreground">{t('orgRecord.header.primaryContact')}:</span>
                <span className="font-medium">{primary.name}</span>
                {primary.email && (
                  <a className="inline-flex items-center gap-1 text-primary hover:underline" href={`mailto:${primary.email}`}>
                    <Mail className="h-3.5 w-3.5" aria-hidden="true" />
                    {primary.email}
                  </a>
                )}
                {primary.phone && (
                  <a className="inline-flex items-center gap-1 text-primary hover:underline" href={`tel:${primary.phone}`}>
                    <Phone className="h-3.5 w-3.5" aria-hidden="true" />
                    {primary.phone}
                  </a>
                )}
              </div>
            ) : (
              summary && (
                <p className="mt-1 text-sm text-muted-foreground">{t('orgRecord.header.noPrimaryContact')}</p>
              )
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 md:justify-end">
          {!archived && (
            <button
              type="button"
              data-testid="org-record-work-here"
              onClick={onWorkHere}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              {t('orgRecord.actions.workHere')}
            </button>
          )}
          <button
            type="button"
            data-testid="org-record-settings"
            onClick={onOpenSettings}
            className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-accent"
          >
            <Settings className="h-3.5 w-3.5" aria-hidden="true" />
            {t('orgRecord.actions.settings')}
          </button>
          {hasLifecycleActions && (
            <div className="relative" ref={menuRef}>
              <button
                type="button"
                data-testid="org-record-more"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-label={t('orgRecord.actions.more')}
                onClick={() => setMenuOpen((open) => !open)}
                className="inline-flex items-center gap-1 rounded-md border px-2 py-1.5 text-sm font-medium hover:bg-accent"
              >
                <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
              {menuOpen && (
                <div
                  role="menu"
                  className="absolute right-0 z-20 mt-1 w-40 overflow-hidden rounded-md border bg-popover py-1 shadow-md"
                >
                  {onArchive && (
                    <button
                      type="button"
                      role="menuitem"
                      data-testid="org-record-archive"
                      onClick={() => {
                        setMenuOpen(false);
                        onArchive();
                      }}
                      className="block w-full px-3 py-1.5 text-left text-sm hover:bg-accent"
                    >
                      {t('orgRecord.actions.archive')}
                    </button>
                  )}
                  {onMerge && (
                    <button
                      type="button"
                      role="menuitem"
                      data-testid="org-record-merge"
                      onClick={() => {
                        setMenuOpen(false);
                        onMerge();
                      }}
                      className="block w-full px-3 py-1.5 text-left text-sm hover:bg-accent"
                    >
                      {t('orgRecord.actions.merge')}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {mismatchedScopeOrgName && (
        <p
          data-testid="org-record-scope-chip"
          className="inline-flex w-fit items-center gap-1.5 rounded-md border border-primary/30 bg-primary/5 px-2 py-1 text-xs text-muted-foreground"
          title={t('orgRecord.header.scopeChipHint', { orgName: mismatchedScopeOrgName })}
        >
          <Building2 className="h-3 w-3" aria-hidden="true" />
          {t('orgRecord.header.scopeChip', { orgName: mismatchedScopeOrgName })}
        </p>
      )}
    </div>
  );
}
