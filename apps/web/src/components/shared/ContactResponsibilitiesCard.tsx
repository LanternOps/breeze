import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { fetchWithAuth } from '../../stores/auth';
import { usePermissions } from '../../lib/permissions';

type ResponsibilityScope = 'device_group' | 'site' | 'organization';

type ResponsibleContact = {
  contactId: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  title: string | null;
  isPrimary: boolean;
};

type Responsibility = {
  role: string;
  level: ResponsibilityScope;
  contacts: ResponsibleContact[];
};

type Props = {
  orgId: string;
  siteId?: string;
  deviceId?: string;
  /**
   * Where contacts are assigned (the org record's Contacts tab). When set, an
   * empty result collapses to one muted line with an "Assign" link instead of
   * an empty card (#9029).
   */
  assignHref?: string;
};

/**
 * Read-only "Responsible contacts" card (spec 2026-10-06 contact-responsibility-scope, §12.3).
 * Shows the responsibilities resolved for one Site or one Device, with the scope that
 * explains each selection. It never edits: configuration lives on the organization card.
 */
export default function ContactResponsibilitiesCard({ orgId, siteId, deviceId, assignHref }: Props) {
  const { t } = useTranslation('contactResponsibilities');
  const { can } = usePermissions();
  // The route is gated on organizations:read; without it the card would only ever show an error.
  const canRead = can('organizations', 'read');
  const [items, setItems] = useState<Responsibility[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!canRead || !orgId || (!siteId && !deviceId)) return;
    let cancelled = false;
    setItems(null);
    setFailed(false);
    const query = deviceId
      ? `deviceId=${encodeURIComponent(deviceId)}`
      : `siteId=${encodeURIComponent(siteId as string)}`;
    fetchWithAuth(`/orgs/organizations/${orgId}/contact-responsibilities?${query}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<{ responsibilities: Responsibility[] }>;
      })
      .then((data) => {
        if (!cancelled) setItems(data.responsibilities ?? []);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [canRead, orgId, siteId, deviceId]);

  if (!canRead) return null;

  if (assignHref && !failed && items !== null && items.length === 0) {
    return (
      <p
        data-testid="contact-responsibilities-empty"
        className="flex flex-wrap items-center gap-x-1.5 rounded-lg border bg-card px-5 py-3 text-sm text-muted-foreground"
      >
        <span>{t('emptyCompact')}</span>
        <span aria-hidden="true">·</span>
        <a
          href={assignHref}
          className="font-medium text-foreground underline decoration-muted-foreground/50 underline-offset-4 hover:decoration-foreground"
        >
          {t('assign')}
        </a>
      </p>
    );
  }

  return (
    <section data-testid="contact-responsibilities-card" className="rounded-lg border bg-card p-6 shadow-xs" aria-labelledby="contact-responsibilities-title">
      <h2 id="contact-responsibilities-title" className="text-lg font-semibold">
        {t('title')}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>

      {failed && <p className="mt-4 text-sm text-destructive">{t('loadFailed')}</p>}
      {!failed && items === null && <p className="mt-4 text-sm text-muted-foreground">{t('loading')}</p>}
      {!failed && items !== null && items.length === 0 && (
        <p className="mt-4 text-sm text-muted-foreground">{t('empty')}</p>
      )}

      {!failed && items !== null && items.length > 0 && (
        <ul className="mt-4 divide-y">
          {items.map((responsibility) => (
            <li key={responsibility.role} className="py-3">
              <p className="text-sm font-medium">{t(/* i18n-dynamic */ `roles.${responsibility.role}`)}</p>
              <p className="text-xs text-muted-foreground">{t(/* i18n-dynamic */ `scope.${responsibility.level}`)}</p>
              <ul className="mt-2 space-y-1">
                {responsibility.contacts.map((contact) => (
                  <li key={contact.contactId} className="text-sm">
                    <span>{contact.name || contact.email || '—'}</span>
                    {contact.isPrimary && (
                      <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs">{t('primary')}</span>
                    )}
                    {contact.title && <span className="text-muted-foreground"> · {contact.title}</span>}
                    {contact.email && contact.name && (
                      <span className="text-muted-foreground"> · {contact.email}</span>
                    )}
                    {(contact.phone || contact.mobile) && (
                      <span className="text-muted-foreground"> · {contact.phone || contact.mobile}</span>
                    )}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
