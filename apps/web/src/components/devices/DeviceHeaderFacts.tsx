// The device header's identity strip: the facts a tech needs before acting on
// a device, on every tab. A fact earns a place here only if it (1) changes the
// next move — fix, RMA, call someone, bill it — (2) fits in about three words,
// and (3) is not already on the page. Anything else belongs in a named section
// of the Details tab, never as another card at the bottom of Overview.
//
// Every fact is conditional: an unknown value renders nothing rather than a
// dash, so a bare device gets no row at all.
import { useEffect, useState, type ReactNode } from 'react';
import { MapPin, Network, Receipt, ShieldCheck, UserRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { fetchWithAuth } from '../../stores/auth';
import { asList } from '@/lib/asList';
import { parseDateOnly } from '@/lib/dateOnly';
import { FactPopover, type FactTone } from '../shared/FactPopover';
import { CopyButton } from './networkDevice/CopyButton';
import {
  contactDisplayName,
  useContactResponsibilities,
  type Responsibility,
  type ResponsibleContact,
} from '../shared/useContactResponsibilities';
import { useDeviceBilling } from './useDeviceBilling';
import { isPlacementResponse, type PlacementFields } from './PhysicalPlacementCard';
import type { WarrantyData } from './DeviceWarrantyCard';
import type { Device } from './DeviceList';

type Props = {
  device: Device;
  /** Opens a device tab (the warranty and billing panels link to their full record). */
  onOpenTab?: (tab: 'hardware' | 'details') => void;
};

// ── Model ────────────────────────────────────────────────────────────────

const LEGAL_SUFFIX = /[,.]?\s+(inc|corp|corporation|co|ltd|llc|gmbh|limited)\.?$/i;

/** "Dell Inc." → "Dell", "LENOVO" → "Lenovo"; short all-caps marks (HP) stay. */
function shortManufacturer(raw: string): string {
  const stripped = raw.trim().replace(LEGAL_SUFFIX, '');
  return /^[A-Z]{4,}$/.test(stripped) ? stripped[0] + stripped.slice(1).toLowerCase() : stripped;
}

export function modelLabel(manufacturer?: string | null, model?: string | null): string | null {
  const make = manufacturer ? shortManufacturer(manufacturer) : '';
  const m = model?.trim() ?? '';
  if (!m) return make || null;
  if (!make || m.toLowerCase().startsWith(make.toLowerCase())) return m;
  return `${make} ${m}`;
}

// ── Warranty ─────────────────────────────────────────────────────────────

type KnownWarranty = Pick<WarrantyData, 'status' | 'warrantyStartDate' | 'warrantyEndDate' | 'dataSource'>;

const WARRANTY_TONE: Record<string, FactTone> = {
  active: 'neutral',
  subscription_active: 'neutral',
  expiring: 'warning',
  expired: 'danger',
};

function useWarranty(deviceId: string): KnownWarranty | null {
  const [warranty, setWarranty] = useState<KnownWarranty | null>(null);
  useEffect(() => {
    let cancelled = false;
    setWarranty(null);
    fetchWithAuth(`/devices/${deviceId}/warranty`)
      .then(async (res) => (res.ok ? ((await res.json()) as Partial<WarrantyData> | null) : null))
      .catch(() => null)
      .then((body) => {
        if (cancelled || !body || typeof body.status !== 'string') return;
        // "unknown" does not change the next move; the Hardware tab holds the lookup.
        if (!(body.status in WARRANTY_TONE)) return;
        setWarranty({
          status: body.status,
          warrantyStartDate: body.warrantyStartDate ?? null,
          warrantyEndDate: body.warrantyEndDate ?? null,
          dataSource: body.dataSource ?? null,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [deviceId]);
  return warranty;
}

function formatDay(value: string | null): string | null {
  if (!value) return null;
  const d = parseDateOnly(value);
  if (isNaN(d.getTime())) return value;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// ── Placement ────────────────────────────────────────────────────────────

function usePlacement(deviceId: string): PlacementFields | null {
  const [placement, setPlacement] = useState<PlacementFields | null>(null);
  useEffect(() => {
    let cancelled = false;
    setPlacement(null);
    fetchWithAuth(`/devices/${deviceId}/placement`)
      .then(async (res) => (res.ok ? ((await res.json()) as unknown) : null))
      .catch(() => null)
      .then((body) => {
        if (!cancelled && isPlacementResponse(body)) setPlacement(body.placement);
      });
    return () => {
      cancelled = true;
    };
  }, [deviceId]);
  return placement;
}

// ── Linked network assets (#3261 Task 4) ─────────────────────────────────

type LinkedNetworkAsset = { id: string; label: string };

function useLinkedNetworkAssets(deviceId: string, orgId?: string): LinkedNetworkAsset[] {
  const [assets, setAssets] = useState<LinkedNetworkAsset[]>([]);
  useEffect(() => {
    let cancelled = false;
    setAssets([]);
    // The endpoint 400s ("orgId is required") for partner/all-orgs sessions
    // unless told which org owns the device.
    const params = new URLSearchParams({ linkedDeviceId: deviceId });
    if (orgId) params.set('orgId', orgId);
    fetchWithAuth(`/discovery/assets?${params.toString()}`)
      .then(async (res) => {
        if (!res.ok) return [];
        const raw = asList<Record<string, unknown>>(await res.json(), 'assets');
        return raw
          .filter((a) => typeof a?.id === 'string')
          .map((a) => ({
            id: a.id as string,
            label: String(a.label || a.hostname || a.ipAddress || a.id),
          }));
      })
      .catch(() => [])
      .then((mapped) => {
        if (!cancelled) setAssets(mapped);
      });
    return () => {
      cancelled = true;
    };
  }, [deviceId, orgId]);
  return assets;
}

// ── Contacts ─────────────────────────────────────────────────────────────

// Who a tech calls first while working a device: the technical contact, then
// the person on site, then escalation; billing and portal contacts last.
const CONTACT_ROLE_ORDER = ['technical', 'site', 'escalation', 'admin', 'after_hours', 'billing', 'portal'];

function pickContact(items: Responsibility[]): { role: string; contact: ResponsibleContact } | null {
  const rank = (role: string) => {
    const i = CONTACT_ROLE_ORDER.indexOf(role);
    return i === -1 ? CONTACT_ROLE_ORDER.length : i;
  };
  for (const r of [...items].sort((a, b) => rank(a.role) - rank(b.role))) {
    const named = [...r.contacts]
      .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary))
      .find((c) => contactDisplayName(c));
    if (named) return { role: r.role, contact: named };
  }
  return null;
}

const PANEL_LINK = 'font-medium text-foreground underline decoration-muted-foreground/50 underline-offset-4 hover:decoration-foreground';

function ContactLinks({ contact }: { contact: ResponsibleContact }) {
  const phone = contact.phone || contact.mobile;
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-0.5">
      {phone && <a href={`tel:${phone}`} className={PANEL_LINK}>{phone}</a>}
      {contact.email && <a href={`mailto:${contact.email}`} className={PANEL_LINK}>{contact.email}</a>}
    </div>
  );
}

// ── Row ──────────────────────────────────────────────────────────────────

const ICON = 'h-3.5 w-3.5 shrink-0 text-muted-foreground';

export default function DeviceHeaderFacts({ device, onOpenTab }: Props) {
  const { t } = useTranslation(['devices', 'contactResponsibilities']);
  const warranty = useWarranty(device.id);
  const placement = usePlacement(device.id);
  const assets = useLinkedNetworkAssets(device.id, device.orgId || undefined);
  const contacts = useContactResponsibilities({ orgId: device.orgId, siteId: device.siteId || undefined, deviceId: device.id });
  const billing = useDeviceBilling(device.id);

  const model = modelLabel(device.manufacturer, device.model);
  const serial = device.serialNumber?.trim() || null;
  const ip = device.lanIp?.trim() || null;
  const picked = contacts.canRead && !contacts.failed && contacts.items ? pickContact(contacts.items) : null;
  // Error is tested before `uncovered`, so a coverage failure never reads as "not billed".
  const notBilled = billing.allowed && !billing.hidden && !billing.loading && !billing.error && billing.data?.uncovered === true;
  const placementText = placement
    ? [
        placement.room,
        placement.rack ? `${t('physicalPlacementCard.rack')} ${placement.rack}` : null,
        // "U12" is rack-unit notation, the same in every locale.
        placement.rackUnit != null ? `U${placement.rackUnit}` : null,
      ].filter(Boolean).join(', ')
    : '';

  const facts: Array<{ key: string; node: ReactNode }> = [];

  if (model) {
    facts.push({ key: 'model', node: <span data-testid="device-fact-model" className="text-foreground">{model}</span> });
  }
  if (serial) {
    facts.push({
      key: 'serial',
      node: (
        <span data-testid="device-fact-serial" className="inline-flex items-center gap-1">
          <abbr title={t('deviceHeaderFacts.serial')} className="text-xs font-medium no-underline">
            {t('deviceHeaderFacts.serialShort')}
          </abbr>
          <span className="font-mono text-foreground">{serial}</span>
          <CopyButton value={serial} label={t('deviceHeaderFacts.serial')} testId="device-fact-serial-copy" />
        </span>
      ),
    });
  }
  if (ip) {
    facts.push({
      key: 'ip',
      node: (
        <span data-testid="device-fact-ip" className="inline-flex items-center gap-1">
          <span className="sr-only">{t('deviceHeaderFacts.lanIp')}</span>
          <span className="font-mono text-foreground">{ip}</span>
          <CopyButton value={ip} label={t('deviceHeaderFacts.lanIp')} testId="device-fact-ip-copy" />
        </span>
      ),
    });
  }
  if (warranty) {
    const end = formatDay(warranty.warrantyEndDate);
    const start = formatDay(warranty.warrantyStartDate);
    const statusKey = warranty.status === 'subscription_active' ? 'appleCareSubscription' : warranty.status;
    const statusLabel = t(/* i18n-dynamic */ `deviceWarrantyCard.status.${statusKey}`);
    const chipText =
      warranty.status === 'subscription_active' || !end
        ? t('deviceHeaderFacts.warrantyStatus', { status: statusLabel })
        : t(/* i18n-dynamic */ `deviceHeaderFacts.warranty.${warranty.status}`, { date: end });
    facts.push({
      key: 'warranty',
      node: (
        <FactPopover
          testId="device-fact-warranty"
          tone={WARRANTY_TONE[warranty.status]}
          icon={<ShieldCheck />}
          panel={
            <div className="space-y-2">
              <p className="font-medium">{t('deviceWarrantyCard.compactTitle')} · {statusLabel}</p>
              {(start || end) && (
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-muted-foreground">
                  {start && <><dt>{t('deviceWarrantyCard.startDate')}</dt><dd className="text-foreground">{start}</dd></>}
                  {end && <><dt>{t('deviceWarrantyCard.endDate')}</dt><dd className="text-foreground">{end}</dd></>}
                </dl>
              )}
              {onOpenTab && (
                <button type="button" onClick={() => onOpenTab('hardware')} className={PANEL_LINK}>
                  {t('deviceHeaderFacts.warrantyDetails')}
                </button>
              )}
            </div>
          }
        >
          {chipText}
        </FactPopover>
      ),
    });
  }
  if (picked) {
    const roleLabel = t(/* i18n-dynamic */ `contactResponsibilities:roles.${picked.role}`, { defaultValue: picked.role });
    const name = contactDisplayName(picked.contact) as string;
    facts.push({
      key: 'contact',
      node: (
        <FactPopover
          testId="device-fact-contact"
          icon={<UserRound />}
          label={`${roleLabel}: ${name}`}
          panel={
            <div className="space-y-3">
              <ul className="space-y-2.5">
                {contacts.items!.filter((r) => r.contacts.length > 0).map((r) => (
                  <li key={r.role}>
                    <p className="text-xs font-medium text-muted-foreground">
                      {t(/* i18n-dynamic */ `contactResponsibilities:roles.${r.role}`, { defaultValue: r.role })}
                    </p>
                    <ul className="mt-0.5 space-y-1.5">
                      {r.contacts.map((c) => (
                        <li key={c.contactId}>
                          {c.name && <p className="font-medium">{c.name}{c.title && <span className="font-normal text-muted-foreground"> · {c.title}</span>}</p>}
                          <ContactLinks contact={c} />
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
              {device.orgId && (
                <a href={`/organizations/${device.orgId}#contacts`} className={PANEL_LINK}>
                  {t('deviceHeaderFacts.manageContacts')}
                </a>
              )}
            </div>
          }
        >
          <span className="text-muted-foreground">{roleLabel}</span> {name}
        </FactPopover>
      ),
    });
  }
  if (notBilled) {
    facts.push({
      key: 'billing',
      node: (
        <FactPopover
          testId="device-fact-billing"
          tone="warning"
          icon={<Receipt />}
          panel={
            <div className="space-y-2">
              <p>{t('deviceBillingCard.uncovered')}</p>
              <div className="flex flex-wrap gap-x-4">
                <a href="/contracts" className={PANEL_LINK}>{t('deviceBillingCard.viewContracts')}</a>
                {onOpenTab && (
                  <button type="button" onClick={() => onOpenTab('details')} className={PANEL_LINK}>
                    {t('deviceHeaderFacts.billingDetails')}
                  </button>
                )}
              </div>
            </div>
          }
        >
          {t('deviceHeaderFacts.notBilled')}
        </FactPopover>
      ),
    });
  }
  if (placementText) {
    facts.push({
      key: 'placement',
      node: (
        <span data-testid="device-fact-placement" className="inline-flex items-center gap-1.5" title={t('physicalPlacementCard.title')}>
          <MapPin className={ICON} aria-hidden="true" />
          <span className="sr-only">{t('physicalPlacementCard.title')}: </span>
          {placementText}
        </span>
      ),
    });
  }
  if (assets.length === 1) {
    const asset = assets[0]!;
    facts.push({
      key: 'network-asset',
      node: (
        <a
          href={`/devices/network/${asset.id}`}
          data-testid="device-network-asset-link"
          className="inline-flex items-center gap-1.5 hover:text-foreground"
        >
          <Network className={ICON} aria-hidden="true" />
          <span className="sr-only">{t('deviceDetails.networkAsset')}: </span>
          <span className="text-foreground underline decoration-muted-foreground/50 underline-offset-4">{asset.label}</span>
        </a>
      ),
    });
  } else if (assets.length > 1) {
    facts.push({
      key: 'network-asset',
      node: (
        <FactPopover
          testId="device-network-asset-list"
          icon={<Network />}
          panel={
            <ul className="space-y-1">
              {assets.map((asset) => (
                <li key={asset.id}>
                  <a href={`/devices/network/${asset.id}`} className={PANEL_LINK}>{asset.label}</a>
                </li>
              ))}
            </ul>
          }
        >
          {t('deviceDetails.networkAssets')}
        </FactPopover>
      ),
    });
  }

  if (facts.length === 0) return null;

  return (
    <ul
      data-testid="device-header-facts"
      aria-label={t('deviceHeaderFacts.ariaLabel')}
      className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-sm text-muted-foreground"
    >
      {facts.map((f) => (
        <li key={f.key} className="flex min-w-0 max-w-full items-center">
          {f.node}
        </li>
      ))}
    </ul>
  );
}
