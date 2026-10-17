import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { formatAddress } from '@/lib/formatAddress';
import { ResponsiveTable, DataCard, CardField, CardActions } from '../shared/ResponsiveTable';
import { ActionMenu, type ActionMenuItem } from '../shared/ActionMenu';

export type Site = {
  id: string;
  name: string;
  timezone: string;
  deviceCount: number;
  // jsonb on the wire (untyped); every value is checked before display.
  address?: {
    line1?: unknown;
    line2?: unknown;
    city?: unknown;
    state?: unknown;
    postalCode?: unknown;
    country?: unknown;
  } | null;
  contact?: { name?: unknown; email?: unknown; phone?: unknown } | null;
};

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

const siteAddressText = (site: Site): string =>
  formatAddress({
    line1: str(site.address?.line1),
    city: str(site.address?.city),
    region: str(site.address?.state),
  });

/**
 * Below this many sites the list needs neither a count nor a search box: the
 * eye takes in the rows faster than it could type a filter, and the chrome
 * ("1 of 1 sites", an empty search field) read as an unfinished page. Mirrors
 * `OrgSwitcher`'s `SEARCH_THRESHOLD` (shown at `>=`). Exported for the test.
 */
export const SITE_SEARCH_THRESHOLD = 6;

type SiteListProps = {
  sites: Site[];
  onAddSite?: () => void;
  onEdit?: (site: Site) => void;
  onDelete?: (site: Site) => void;
  onSiteClick?: (site: Site) => void;
};

export default function SiteList({ sites, onAddSite, onEdit, onDelete, onSiteClick }: SiteListProps) {
  const { t } = useTranslation('settings');
  const [query, setQuery] = useState('');
  const showSearch = sites.length >= SITE_SEARCH_THRESHOLD;

  const filteredSites = useMemo(() => {
    // A query typed before the list shrank below the threshold must not keep
    // filtering behind a search box that is no longer on screen.
    const normalizedQuery = showSearch ? query.trim().toLowerCase() : '';

    if (!normalizedQuery) {
      return sites;
    }

    return sites.filter(site => site.name.toLowerCase().includes(normalizedQuery));
  }, [query, sites, showSearch]);

  // Row pieces shared by the desktop table and the mobile cards. With
  // `onSiteClick` the whole row opens the site (like the Devices tab's rows)
  // and "Open" is the keyboard path, so the name itself stays plain text —
  // one tab stop per action, not two that do the same thing.
  const renderSiteName = (site: Site) => site.name;

  const renderAddress = (site: Site) => siteAddressText(site) || '—';

  const renderContact = (site: Site) => {
    const name = str(site.contact?.name)?.trim();
    const phone = str(site.contact?.phone)?.trim();
    if (!name && !phone) return '—';
    return (
      <span className="flex flex-col">
        {name && <span>{name}</span>}
        {phone && (
          <a
            href={`tel:${phone}`}
            data-testid={`site-${site.id}-contact-phone`}
            onClick={(event) => event.stopPropagation()}
            className="text-primary hover:underline"
          >
            {phone}
          </a>
        )}
      </span>
    );
  };

  // #9022: the primary action says what it does ("Open" navigates; "Edit"
  // only when there is nowhere to open), and Delete leaves the row for the
  // overflow menu instead of sitting red at parity with it. The wrapper stops
  // clicks here (including the portalled menu's, which bubble through the
  // React tree) from also firing the row's open.
  const renderActions = (site: Site) => {
    const menuItems: ActionMenuItem[] = [];
    if (onSiteClick && onEdit) {
      menuItems.push({ id: 'edit', label: t('common:actions.edit'), onSelect: () => onEdit(site), testId: `site-${site.id}-edit` });
    }
    if (onDelete) {
      menuItems.push({
        id: 'delete',
        label: t('common:actions.delete'),
        onSelect: () => onDelete(site),
        tone: 'destructive',
        separatorBefore: menuItems.length > 0,
        testId: `site-${site.id}-delete`,
      });
    }
    return (
      <div className="flex items-center justify-end gap-1" onClick={(event) => event.stopPropagation()}>
        <button
          type="button"
          data-testid={`site-${site.id}-open`}
          onClick={() => (onSiteClick ? onSiteClick(site) : onEdit?.(site))}
          aria-label={
            onSiteClick
              ? t('siteList.actions.openSite', { name: site.name })
              : t('siteList.actions.editSite', { name: site.name })
          }
          className="inline-flex h-8 items-center rounded-md px-2.5 text-sm font-medium text-primary hover:underline"
        >
          {onSiteClick ? t('siteList.actions.open') : t('common:actions.edit')}
        </button>
        <ActionMenu
          label={t('siteList.actions.rowMenu', { name: site.name })}
          items={menuItems}
          testId={`site-${site.id}-menu`}
          triggerClassName="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground"
        />
      </div>
    );
  };

  return (
    <div className="rounded-lg border bg-card p-6 shadow-xs">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">
            {t('siteList.title')}
          </h2>
          {showSearch && (
            <p className="text-sm text-muted-foreground">
              {t('siteList.count', { filtered: filteredSites.length, total: sites.length })}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          {showSearch && (
            <input
              type="search"
              placeholder={t('siteList.searchPlaceholder')}
              aria-label={t('siteList.searchPlaceholder')}
              value={query}
              onChange={event => setQuery(event.target.value)}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring sm:w-56"
            />
          )}
          <button
            type="button"
            onClick={onAddSite}
            className="flex h-9 w-full items-center justify-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition hover:opacity-90 sm:w-auto"
          >
            {t('siteList.actions.add')}
          </button>
        </div>
      </div>

      <ResponsiveTable
        variant="flat"
        className="mt-6"
        table={
          <table className="min-w-full divide-y">
            <thead className="bg-muted/40">
              <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3">{t('common:labels.name')}</th>
                <th className="px-4 py-3">{t('siteList.columns.address')}</th>
                <th className="px-4 py-3">{t('siteList.columns.contact')}</th>
                <th className="px-4 py-3">{t('siteList.columns.timezone')}</th>
                <th className="px-4 py-3">{t('siteList.columns.devices')}</th>
                <th className="px-4 py-3 text-right">{t('common:labels.actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {filteredSites.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-sm text-muted-foreground">
                    {t('siteList.empty')}
                  </td>
                </tr>
              ) : (
                filteredSites.map(site => (
                  <tr
                    key={site.id}
                    data-testid={`site-row-${site.id}`}
                    onClick={onSiteClick ? () => onSiteClick(site) : undefined}
                    className={`transition hover:bg-muted/40 ${onSiteClick ? 'cursor-pointer' : ''}`}
                  >
                    <td className="px-4 py-3 text-sm font-medium">{renderSiteName(site)}</td>
                    <td className="px-4 py-3 text-sm">{renderAddress(site)}</td>
                    <td className="px-4 py-3 text-sm">{renderContact(site)}</td>
                    <td className="px-4 py-3 text-sm">{site.timezone}</td>
                    <td className="px-4 py-3 text-sm tabular-nums">{site.deviceCount}</td>
                    <td className="px-4 py-3 text-right">{renderActions(site)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        }
        cards={
          filteredSites.length === 0 ? (
            <DataCard>
              <p className="py-2 text-center text-sm text-muted-foreground">
                {t('siteList.empty')}
              </p>
            </DataCard>
          ) : (
            filteredSites.map(site => (
              <DataCard key={site.id} onClick={onSiteClick ? () => onSiteClick(site) : undefined}>
                <div className="text-sm font-semibold">{renderSiteName(site)}</div>
                <div className="mt-3 space-y-2 border-t pt-3">
                  <CardField label={t('siteList.columns.address')}>
                    <span className="text-sm">{renderAddress(site)}</span>
                  </CardField>
                  <CardField label={t('siteList.columns.contact')}>
                    <span className="text-sm">{renderContact(site)}</span>
                  </CardField>
                  <CardField label={t('siteList.columns.timezone')}>
                    <span className="text-sm">{site.timezone}</span>
                  </CardField>
                  <CardField label={t('siteList.columns.devices')}>
                    <span className="text-sm">{site.deviceCount}</span>
                  </CardField>
                </div>
                <CardActions>{renderActions(site)}</CardActions>
              </DataCard>
            ))
          )
        }
      />
    </div>
  );
}
