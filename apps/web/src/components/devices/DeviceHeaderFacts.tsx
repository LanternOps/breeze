// The device header's identity strip: the facts a tech needs before acting on
// a device, on every tab. A fact earns a place here only if it (1) changes the
// next move — fix, RMA, call someone — (2) fits in about three words,
// and (3) is not already on the page. Anything else belongs in a named section
// of the Details tab, never as another card at the bottom of Overview.
//
// Every fact is conditional: an unknown value renders nothing rather than a
// dash, so a bare device gets no row at all.
//
// The row must not move the page as it loads (see "Load stability" below): it
// is one fixed-height line, and the facts that need a fetch appear together.
import { useEffect, useLayoutEffect, useReducer, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, MapPin, Network, Phone, ShieldAlert, ShieldCheck, ShieldX, UserRound } from 'lucide-react';
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
import { isPlacementResponse, type PlacementFields } from './PhysicalPlacementCard';
import type { WarrantyData } from './DeviceWarrantyCard';
import type { Device } from './DeviceList';

type Props = {
  device: Device;
  /** Opens a device tab (the warranty panel links to its full record). */
  onOpenTab?: (tab: 'hardware') => void;
};

// ── Load stability ───────────────────────────────────────────────────────
//
// Each fact fetches on its own. Rendered as they land, the row grew from one
// line to two and pushed the tabs down, and late chips slid in mid-row. Now:
//  - every source reports when it has SETTLED (answered, failed, or was never
//    asked), so "still loading" is never confused with "nothing to show";
//  - the fetched facts appear together once all have settled, or after
//    REVEAL_DEADLINE_MS so one slow endpoint never holds back the rest;
//  - the row is a single fixed-height line (useOneLine), so anything late can
//    only fold behind "N more", never push the page down.

const REVEAL_DEADLINE_MS = 1000;

type Settled<T> = { value: T; settled: boolean };

/**
 * Loads once per `key` (the request's identity); a null key means the source
 * is not asked, which counts as settled. `load` must resolve, never reject,
 * and be a stable module-level function.
 */
function useKeyedLoad<T>(key: string | null, load: (key: string) => Promise<T>, empty: T): Settled<T> {
  const [state, setState] = useState<{ key: string; value: T } | null>(null);
  useEffect(() => {
    if (key === null) return;
    let cancelled = false;
    void load(key).then((value) => {
      if (!cancelled) setState({ key, value });
    });
    return () => {
      cancelled = true;
    };
  }, [key, load]);
  if (key === null) return { value: empty, settled: true };
  return state?.key === key ? { value: state.value, settled: true } : { value: empty, settled: false };
}

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

// Shape carries the state too, so it never rests on colour alone.
const WARRANTY_ICON: Record<string, ReactNode> = {
  active: <ShieldCheck />,
  subscription_active: <ShieldCheck />,
  expiring: <ShieldAlert />,
  expired: <ShieldX />,
};

const WARRANTY_TONE: Record<string, FactTone> = {
  active: 'neutral',
  subscription_active: 'neutral',
  expiring: 'warning',
  expired: 'danger',
};

async function loadWarranty(deviceId: string): Promise<KnownWarranty | null> {
  const body = await fetchWithAuth(`/devices/${deviceId}/warranty`)
    // The route wraps the record: { warranty: {...} | null }.
    .then(async (res) => (res.ok ? ((await res.json()) as { warranty?: Partial<WarrantyData> | null } | null)?.warranty ?? null : null))
    .catch(() => null);
  // "unknown" does not change the next move; the Hardware tab holds the lookup.
  if (!body || typeof body.status !== 'string' || !(body.status in WARRANTY_TONE)) return null;
  return {
    status: body.status,
    warrantyStartDate: body.warrantyStartDate ?? null,
    warrantyEndDate: body.warrantyEndDate ?? null,
    dataSource: body.dataSource ?? null,
  };
}

function formatDay(value: string | null): string | null {
  if (!value) return null;
  const d = parseDateOnly(value);
  if (isNaN(d.getTime())) return value;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// ── Placement ────────────────────────────────────────────────────────────

async function loadPlacement(deviceId: string): Promise<PlacementFields | null> {
  const body = await fetchWithAuth(`/devices/${deviceId}/placement`)
    .then(async (res) => (res.ok ? ((await res.json()) as unknown) : null))
    .catch(() => null);
  return isPlacementResponse(body) ? body.placement : null;
}

// ── Linked network assets (#3261 Task 4) ─────────────────────────────────

type LinkedNetworkAsset = { id: string; label: string };

const NO_ASSETS: LinkedNetworkAsset[] = [];

/** The endpoint 400s ("orgId is required") for partner/all-orgs sessions unless told which org owns the device. */
function networkAssetsQuery(deviceId: string, orgId?: string): string {
  const params = new URLSearchParams({ linkedDeviceId: deviceId });
  if (orgId) params.set('orgId', orgId);
  return params.toString();
}

async function loadLinkedNetworkAssets(query: string): Promise<LinkedNetworkAsset[]> {
  return fetchWithAuth(`/discovery/assets?${query}`)
    .then(async (res) => {
      if (!res.ok) return NO_ASSETS;
      const raw = asList<Record<string, unknown>>(await res.json(), 'assets');
      return raw
        .filter((a) => typeof a?.id === 'string')
        .map((a) => ({
          id: a.id as string,
          label: String(a.label || a.hostname || a.ipAddress || a.id),
        }));
    })
    .catch(() => NO_ASSETS);
}

// ── Contacts ─────────────────────────────────────────────────────────────

// Who a tech calls first while working a device: the technical contact, then
// the person on site, then escalation; billing and portal contacts last.
const CONTACT_ROLE_ORDER = ['technical', 'site', 'escalation', 'admin', 'after_hours', 'billing', 'portal'];

const roleRank = (role: string) => {
  const i = CONTACT_ROLE_ORDER.indexOf(role);
  return i === -1 ? CONTACT_ROLE_ORDER.length : i;
};

const digits = (v: string | null | undefined) => (v ? v.replace(/\D/g, '') : '');

/**
 * Responsibilities in the chip's order (role rank, primary first), each role's
 * contacts de-duplicated: the same person entered twice (same email, or same
 * phone however it is formatted) is listed once.
 */
function orderedResponsibilities(items: Responsibility[]): Responsibility[] {
  return [...items]
    .filter((r) => r.contacts.length > 0)
    .sort((a, b) => roleRank(a.role) - roleRank(b.role))
    .map((r) => {
      const seen = new Set<string>();
      const contacts = [...r.contacts]
        .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary))
        .filter((c) => {
          const keys = [c.email?.trim().toLowerCase(), digits(c.phone || c.mobile)].filter(Boolean) as string[];
          if (keys.some((k) => seen.has(k))) return false;
          keys.forEach((k) => seen.add(k));
          return true;
        });
      return { ...r, contacts };
    });
}

function pickContact(ordered: Responsibility[]): { role: string; contact: ResponsibleContact } | null {
  for (const r of ordered) {
    const reachable = r.contacts.find((c) => contactDisplayName(c));
    if (reachable) return { role: r.role, contact: reachable };
  }
  return null;
}

// min-h-6: links in the panels are pointer targets too (24px floor).
const PANEL_LINK = 'inline-flex min-h-6 items-center font-medium text-foreground underline decoration-muted-foreground/50 underline-offset-4 hover:decoration-foreground';

function ContactLinks({ contact }: { contact: ResponsibleContact }) {
  const phone = contact.phone || contact.mobile;
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-0.5">
      {phone && <a href={`tel:${phone}`} className={PANEL_LINK}>{phone}</a>}
      {contact.email && <a href={`mailto:${contact.email}`} className={PANEL_LINK}>{contact.email}</a>}
    </div>
  );
}

// ── One line ─────────────────────────────────────────────────────────────

type Fact = { key: string; rank: number; node: ReactNode };

// Lower rank stays visible longer when the line is short: an alert first (it
// is the reason to look), then the identifiers a tech pastes, then context.
// (Billing coverage is not a header fact; it lives in the Details tab's
// Asset record.)
const RANK = {
  warrantyAlert: 1,
  model: 2,
  serial: 3,
  ip: 4,
  contact: 5,
  warranty: 6,
  placement: 7,
  networkAsset: 8,
} as const;

const MORE = 'more';
const NOTHING_FOLDED: ReadonlySet<string> = new Set();

/**
 * The facts to fold behind the "N more" toggle so the rest, plus the toggle,
 * fit `available` px. Facts are placed in rank order; one that does not fit is
 * folded, but a smaller, lower-ranked one may still take the space. The
 * top-ranked fact always stays.
 */
export function factsToFold(
  items: Array<{ key: string; rank: number; width: number }>,
  available: number,
  gap: number,
  toggleWidth: number,
): ReadonlySet<string> {
  const total = items.reduce((sum, i) => sum + i.width, 0) + gap * Math.max(items.length - 1, 0);
  if (total <= available) return NOTHING_FOLDED;
  const budget = available - gap - toggleWidth;
  const folded = new Set<string>();
  let used = 0;
  let kept = 0;
  for (const item of [...items].sort((a, b) => a.rank - b.rank)) {
    const need = item.width + (kept > 0 ? gap : 0);
    if (kept === 0 || used + need <= budget) {
      used += need;
      kept += 1;
    } else {
      folded.add(item.key);
    }
  }
  return folded;
}

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((k) => b.has(k));

/**
 * Measures each fact (a folded one keeps its last measured width) and folds
 * what does not fit on one line. Runs before paint, so nothing flashes; a
 * ResizeObserver re-fits on window resizes and late font swaps.
 */
function useOneLine(facts: Fact[]) {
  const listRef = useRef<HTMLUListElement>(null);
  const widths = useRef(new Map<string, number>());
  const [folded, setFolded] = useState<ReadonlySet<string>>(NOTHING_FOLDED);
  const [, refit] = useReducer((n: number) => n + 1, 0);
  const present = facts.length > 0;
  const factKeys = facts.map((f) => f.key).join();

  useLayoutEffect(() => {
    const ul = listRef.current;
    if (!ul) return;
    for (const li of ul.querySelectorAll<HTMLElement>(':scope > li[data-fact]')) {
      if (!li.hidden) widths.current.set(li.dataset.fact!, li.getBoundingClientRect().width);
    }
    const gap = parseFloat(getComputedStyle(ul).columnGap) || 0;
    const next = factsToFold(
      facts.map((f) => ({ key: f.key, rank: f.rank, width: widths.current.get(f.key) ?? 0 })),
      ul.clientWidth,
      gap,
      widths.current.get(MORE) ?? 0,
    );
    setFolded((prev) => (sameSet(prev, next) ? prev : next));
  });

  useEffect(() => {
    const ul = listRef.current;
    if (!ul || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => refit());
    observer.observe(ul);
    for (const li of ul.querySelectorAll(':scope > li')) observer.observe(li);
    return () => observer.disconnect();
  }, [present, factKeys]);

  return { listRef, folded };
}

// ── Row ──────────────────────────────────────────────────────────────────

const ICON = 'h-3.5 w-3.5 shrink-0 text-muted-foreground';

export default function DeviceHeaderFacts({ device, onOpenTab }: Props) {
  const { t } = useTranslation(['devices', 'contactResponsibilities']);
  const warranty = useKeyedLoad(device.id, loadWarranty, null);
  const placement = useKeyedLoad(device.id, loadPlacement, null);
  const assets = useKeyedLoad(networkAssetsQuery(device.id, device.orgId || undefined), loadLinkedNetworkAssets, NO_ASSETS);
  const contacts = useContactResponsibilities({ orgId: device.orgId, siteId: device.siteId || undefined, deviceId: device.id });
  const [expanded, setExpanded] = useState(false);

  const model = modelLabel(device.manufacturer, device.model);
  const serial = device.serialNumber?.trim() || null;
  const ip = device.lanIp?.trim() || null;

  // Settled = answered, failed, or never asked (no permission, nothing to ask).
  const settled =
    warranty.settled &&
    placement.settled &&
    assets.settled &&
    (!contacts.canRead || !device.orgId || contacts.failed || contacts.items !== null);
  const [deadlineFor, setDeadlineFor] = useState<string | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setDeadlineFor(device.id), REVEAL_DEADLINE_MS);
    return () => clearTimeout(timer);
  }, [device.id]);
  const revealed = settled || deadlineFor === device.id;

  // Fetched facts are withheld until `revealed`, then appear together.
  const shown = <T,>(value: T, empty: T): T => (revealed ? value : empty);
  const warrantyFact = shown(warranty.value, null);
  const placementFact = shown(placement.value, null);
  const assetFacts = shown(assets.value, NO_ASSETS);
  const responsibilities = revealed && contacts.canRead && !contacts.failed && contacts.items ? orderedResponsibilities(contacts.items) : [];
  const picked = pickContact(responsibilities);
  const placementText = placementFact
    ? [
        placementFact.room,
        placementFact.rack ? `${t('physicalPlacementCard.rack')} ${placementFact.rack}` : null,
        // "U12" is rack-unit notation, the same in every locale.
        placementFact.rackUnit != null ? `U${placementFact.rackUnit}` : null,
      ].filter(Boolean).join(', ')
    : '';

  const facts: Fact[] = [];

  if (model) {
    facts.push({ key: 'model', rank: RANK.model, node: <span data-testid="device-fact-model" className="text-foreground">{model}</span> });
  }
  if (serial) {
    facts.push({
      key: 'serial',
      rank: RANK.serial,
      node: (
        <span data-testid="device-fact-serial" className="inline-flex items-center gap-1">
          <abbr title={t('deviceHeaderFacts.serial')} className="text-xs font-medium no-underline">
            {t('deviceHeaderFacts.serialShort')}
          </abbr>
          <span className="font-mono text-foreground">{serial}</span>
          <CopyButton compact value={serial} label={t('deviceHeaderFacts.serial')} testId="device-fact-serial-copy" />
        </span>
      ),
    });
  }
  if (ip) {
    facts.push({
      key: 'ip',
      rank: RANK.ip,
      node: (
        <span data-testid="device-fact-ip" className="inline-flex items-center gap-1">
          <span className="text-xs font-medium">{t('deviceHeaderFacts.lanIp')}</span>
          <span className="font-mono text-foreground">{ip}</span>
          <CopyButton compact value={ip} label={t('deviceHeaderFacts.lanIp')} testId="device-fact-ip-copy" />
        </span>
      ),
    });
  }
  if (warrantyFact) {
    const warranty = warrantyFact;
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
      rank: WARRANTY_TONE[warranty.status] === 'neutral' ? RANK.warranty : RANK.warrantyAlert,
      node: (
        <FactPopover
          testId="device-fact-warranty"
          tone={WARRANTY_TONE[warranty.status]}
          icon={WARRANTY_ICON[warranty.status]}
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
    // A person's name (or email). A bare phone number is not a name: it reads
    // as a phone field, so a nameless contact shows its role and a call button.
    const name = picked.contact.name?.trim() || picked.contact.email?.trim() || null;
    const phone = picked.contact.phone || picked.contact.mobile;
    facts.push({
      key: 'contact',
      rank: RANK.contact,
      node: (
        <span className="inline-flex min-w-0 items-center gap-0.5">
          <FactPopover
            testId="device-fact-contact"
            icon={<UserRound />}
            label={name ? `${roleLabel}: ${name}` : roleLabel}
            panel={
              <div className="space-y-3">
                <ul className="space-y-2.5">
                  {responsibilities.map((r) => (
                    <li key={r.role}>
                      <p data-testid="device-fact-contact-role" className="text-xs font-medium text-muted-foreground">
                        {t(/* i18n-dynamic */ `contactResponsibilities:roles.${r.role}`, { defaultValue: r.role })}
                        <span className="font-normal"> · {t(/* i18n-dynamic */ `contactResponsibilities:scope.${r.level}`, { defaultValue: r.level })}</span>
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
            <span className="text-muted-foreground group-hover:text-foreground group-aria-expanded:text-foreground">{roleLabel}</span>
            {name && <> {name}</>}
          </FactPopover>
          {phone && (
            <a
              href={`tel:${phone}`}
              data-testid="device-fact-contact-call"
              aria-label={t('deviceHeaderFacts.call', { name: name ?? roleLabel })}
              title={phone}
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Phone className="h-3.5 w-3.5" aria-hidden="true" />
            </a>
          )}
        </span>
      ),
    });
  }
  if (placementText) {
    facts.push({
      key: 'placement',
      rank: RANK.placement,
      node: (
        <span data-testid="device-fact-placement" className="inline-flex items-center gap-1.5" title={t('physicalPlacementCard.title')}>
          <MapPin className={ICON} aria-hidden="true" />
          <span className="sr-only">{t('physicalPlacementCard.title')}: </span>
          <span className="text-foreground">{placementText}</span>
        </span>
      ),
    });
  }
  if (assetFacts.length === 1) {
    const asset = assetFacts[0]!;
    facts.push({
      key: 'network-asset',
      rank: RANK.networkAsset,
      node: (
        <a
          href={`/devices/network/${asset.id}`}
          data-testid="device-network-asset-link"
          className="inline-flex min-h-6 items-center gap-1.5 hover:text-foreground"
        >
          <Network className={ICON} aria-hidden="true" />
          <span>{t('deviceDetails.networkAsset')}</span>
          <span className="text-foreground underline decoration-muted-foreground/50 underline-offset-4">{asset.label}</span>
        </a>
      ),
    });
  } else if (assetFacts.length > 1) {
    facts.push({
      key: 'network-asset',
      rank: RANK.networkAsset,
      node: (
        <FactPopover
          testId="device-network-asset-list"
          icon={<Network />}
          panel={
            <ul className="space-y-1">
              {assetFacts.map((asset) => (
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

  const { listRef, folded } = useOneLine(facts);

  // Nothing to show once every source has answered: no row. Until then the
  // line is held, even past the reveal deadline, so a device whose only facts
  // are fetched does not collapse and then grow back when a slow one lands.
  if (facts.length === 0 && settled) return null;

  const foldable = folded.size > 0;
  return (
    <ul
      ref={listRef}
      data-testid="device-header-facts"
      aria-label={t('deviceHeaderFacts.ariaLabel')}
      aria-busy={settled ? undefined : true}
      className={`flex items-center gap-x-5 text-sm text-muted-foreground ${expanded ? 'flex-wrap gap-y-1.5' : 'h-7 flex-nowrap'}`}
    >
      {facts.map((f) => (
        <li key={f.key} data-fact={f.key} hidden={!expanded && folded.has(f.key)} className="flex max-w-full shrink-0 items-center">
          {f.node}
        </li>
      ))}
      {/* Always rendered so its width is known before it is needed; inert until then. */}
      <li data-fact={MORE} aria-hidden={foldable ? undefined : true} className={foldable ? 'flex shrink-0 items-center' : 'invisible absolute'}>
        <button
          type="button"
          data-testid="device-facts-more"
          aria-expanded={expanded}
          tabIndex={foldable ? undefined : -1}
          onClick={() => setExpanded((v) => !v)}
          className="-mx-1.5 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-sm text-foreground hover:bg-muted focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        >
          {expanded ? t('deviceHeaderFacts.showLess') : t('deviceHeaderFacts.more', { count: Math.max(folded.size, 1) })}
          <ChevronDown className={`h-3 w-3 shrink-0 text-muted-foreground transition-transform ${expanded ? 'rotate-180' : ''}`} aria-hidden="true" />
        </button>
      </li>
    </ul>
  );
}
