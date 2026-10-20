import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Building2, Check, ChevronDown, Mail, MapPin, Phone, Settings } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { usePermissions } from '@/lib/permissions';
import { ENABLE_ENDPOINT_MESSAGING } from '@/lib/featureFlags';
import { formatDate } from '@/lib/dateTimeFormat';
import { formatAddress } from '@/lib/formatAddress';
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
  /** The OrgSwitcher already points at this record's org. */
  workingHere?: boolean;
  /** The partner's own billing country: the address leaves a matching country off. */
  partnerCountry?: string | null;
  onWorkHere: () => void;
  onOpenSettings: () => void;
  /** Omitted (with `onMerge`) while the record is read-only. */
  onArchive?: () => void;
  /** Merge is a partner-scope operation; system-scope sessions do not get it. */
  onMerge?: () => void;
  /** Opens the endpoint-message dialog targeting every device in the org. */
  onSendMessage?: () => void;
}

/**
 * Identity header for the organization record: who this customer is, what
 * state they are in, and what you do from here (work in their context —
 * shown as a quiet "Working here" state once you already are — open their
 * settings, message their devices, run a lifecycle action).
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
  workingHere = false,
  partnerCountry = null,
  onWorkHere,
  onOpenSettings,
  onArchive,
  onMerge,
  onSendMessage,
}: OrgRecordHeaderProps) {
  const { t } = useTranslation('organizations');
  const { t: tSettings } = useTranslation('settings');
  const { can } = usePermissions();
  const canSendMessage = ENABLE_ENDPOINT_MESSAGING && can('endpoint_messages', 'send'); // #8968: hidden until the build enables messaging
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const scopeLineId = useId();

  const closeMenu = useCallback((returnFocus: boolean) => {
    setMenuOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onDocumentClick = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocumentClick);
    return () => document.removeEventListener('mousedown', onDocumentClick);
  }, [menuOpen]);

  const menuItems = () =>
    Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);

  // Same APG menu pattern as OverflowTabs' More menu: opening moves focus to
  // the first item, arrows wrap, Home/End jump, Escape closes and hands focus
  // back to the trigger (#9021).
  useEffect(() => {
    if (menuOpen) menuItems()[0]?.focus();
  }, [menuOpen]);

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const items = menuItems();
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    switch (event.key) {
      case 'ArrowDown': next = (current + 1) % items.length; break;
      case 'ArrowUp': next = (current - 1 + items.length) % items.length; break;
      case 'Home': next = 0; break;
      case 'End': next = items.length - 1; break;
      case 'Escape':
        event.preventDefault();
        closeMenu(true);
        return;
      case 'Tab':
        closeMenu(false);
        return;
      default:
        return;
    }
    event.preventDefault();
    items[next]?.focus();
  };

  // statusColors/statusLabelKeys are keyed by the store's Organization union.
  // A status the client does not know about still has to render something, so
  // fall back to the raw value rather than an empty pill.
  const statusKey = org.status as Organization['status'];
  const statusClass = statusColors[statusKey] ?? 'border-border bg-muted text-muted-foreground';
  const statusLabelKey = statusLabelKeys[statusKey];
  const statusLabel = statusLabelKey ? tSettings(/* i18n-dynamic */ statusLabelKey) : org.status;

  const primary = summary?.contacts?.primary ?? null;
  const siteCount = summary?.sites.count;
  const billingAddress = formatAddress({
    line1: org.billingAddressLine1,
    line2: org.billingAddressLine2,
    city: org.billingAddressCity,
    region: org.billingAddressRegion,
    postalCode: org.billingAddressPostalCode,
    country: org.billingAddressCountry,
  }, { homeCountry: partnerCountry });
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
                  className="inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium text-foreground"
                >
                  {org.type === 'internal' ? t('orgRecord.header.type.internal') : t('orgRecord.header.type.customer')}
                </span>
              )}
            </div>

            {mismatchedScopeOrgName && !workingHere && (
              // #9019: the mismatch used to live in a 12px chip whose meaning was
              // a `title` tooltip — out of reach for keyboard and touch users.
              <p
                id={scopeLineId}
                data-testid="org-record-scope-chip"
                className="mt-1 text-sm text-muted-foreground"
              >
                {t('orgRecord.header.scopeLine', { currentOrg: mismatchedScopeOrgName, orgName: org.name })}
              </p>
            )}

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
                // #9024: the same "missing · fix it" shape as the billing line below.
                <p data-testid="org-record-no-primary-contact" className="mt-1 text-sm text-muted-foreground">
                  {t('orgRecord.header.noPrimaryContact')}
                  <span aria-hidden="true"> · </span>
                  <a data-testid="org-record-primary-contact-link" href="#contacts" className="text-primary hover:underline">
                    {t('orgRecord.header.addContactLink')}
                  </a>
                </p>
              )
            )}

            {billingAddress ? (
              <div
                data-testid="org-record-billing-address"
                className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm"
              >
                <span className="text-muted-foreground">{t('orgRecord.header.billingAddress')}:</span>
                <span>{billingAddress}</span>
              </div>
            ) : (
              <p data-testid="org-record-no-billing-address" className="mt-1 text-sm text-muted-foreground">
                {t('orgRecord.header.noBillingAddress')}
                <span aria-hidden="true"> · </span>
                <a
                  data-testid="org-record-billing-address-link"
                  href={`/settings/organizations/${org.id}#billing`}
                  className="text-primary hover:underline"
                >
                  {t('orgRecord.header.billingSettingsLink')}
                </a>
              </p>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 md:justify-end">
          {!archived &&
            (workingHere ? (
              // #9019: a state, not an action — same slot as the button so
              // the row doesn't jump when the switch lands.
              <span
                role="status"
                data-testid="org-record-working-here"
                aria-label={t('orgRecord.header.workingHereLabel', { orgName: org.name })}
                className="inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-sm font-medium text-muted-foreground"
              >
                <Check className="h-4 w-4" aria-hidden="true" />
                {t('orgRecord.header.workingHere')}
              </span>
            ) : (
              <button
                type="button"
                data-testid="org-record-work-here"
                onClick={onWorkHere}
                aria-describedby={mismatchedScopeOrgName ? scopeLineId : undefined}
                className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                {t('orgRecord.actions.workHere')}
              </button>
            ))}
          {!archived && onSendMessage && canSendMessage && (
            <button
              type="button"
              data-testid="org-record-send-message"
              onClick={onSendMessage}
              className="inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm font-medium hover:bg-accent"
            >
              {t('orgRecord.actions.sendMessage')}
            </button>
          )}
          <button
            type="button"
            data-testid="org-record-settings"
            onClick={onOpenSettings}
            className="inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm font-medium hover:bg-accent"
          >
            <Settings className="h-3.5 w-3.5" aria-hidden="true" />
            {t('orgRecord.actions.settings')}
          </button>
          {hasLifecycleActions && (
            <div className="relative" ref={menuRef}>
              <button
                type="button"
                ref={triggerRef}
                data-testid="org-record-more"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-label={t('orgRecord.actions.more')}
                onClick={() => setMenuOpen((open) => !open)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown' && !menuOpen) { e.preventDefault(); setMenuOpen(true); }
                  if (e.key === 'Escape' && menuOpen) { e.preventDefault(); closeMenu(true); }
                }}
                className="inline-flex h-9 items-center gap-1 rounded-md border px-2 text-sm font-medium hover:bg-accent"
              >
                <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
              {menuOpen && (
                <div
                  role="menu"
                  aria-label={t('orgRecord.actions.more')}
                  onKeyDown={handleMenuKeyDown}
                  className="absolute right-0 z-20 mt-1 w-40 overflow-hidden rounded-md border bg-popover py-1 shadow-md"
                >
                  {onArchive && (
                    <button
                      type="button"
                      role="menuitem"
                      data-testid="org-record-archive"
                      onClick={() => {
                        closeMenu(true);
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
                        closeMenu(true);
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
    </div>
  );
}
