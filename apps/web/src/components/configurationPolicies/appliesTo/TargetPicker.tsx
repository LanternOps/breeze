import { useEffect, useMemo, useRef, useState } from 'react';
import { Building2, ChevronLeft, Lock, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { extractApiError } from '@/lib/apiError';
import { fetchWithAuth } from '../../../stores/auth';
import { configTargetLevelLabel } from '../configPolicyLabels';
import type { ConfigPolicyTargetLevel } from '../appliesToSummary';

// One drill-down picker for every target level (#12467, plan W02c P2; spec
// "Applies-to editor"). Every list is searched on the server, never filtered
// from a truncated first page.
//
// - An org-managed policy only ever queries its own organization (#6339): the
//   organization level is that org, locked, and every narrower query pins it.
// - An MSP-managed policy picks an organization first, then a site, group or
//   device inside it. MSP-owned groups, which span organizations (#10521), are
//   offered only here; that is the rule the API and the database enforce.

export type PickerOwner = { kind: 'msp' } | { kind: 'org'; orgId: string; orgName: string | null };
export type PickedTarget = { level: ConfigPolicyTargetLevel; targetId: string; name: string };
type PickerLevel = Exclude<ConfigPolicyTargetLevel, 'partner'>;

type TargetPickerProps = {
  owner: PickerOwner;
  onPick: (target: PickedTarget) => void;
  /** Whether a target is already in the draft; such an option is shown but cannot be picked again. */
  isListed?: (level: ConfigPolicyTargetLevel, targetId: string) => boolean;
  /** Offer the Organization level (an MSP policy set to All organizations has no use for it). */
  offerOrganization?: boolean;
};

type Option = { id: string; name: string; extra?: string };

const LEVELS: readonly PickerLevel[] = ['organization', 'site', 'device_group', 'device'];
const SEARCH_DEBOUNCE_MS = 300;
const PAGE = 50;

const rows = (body: unknown): Record<string, unknown>[] => {
  const data = body && typeof body === 'object' ? (body as { data?: unknown }).data : undefined;
  return Array.isArray(data) ? data.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object') : [];
};

function toOption(row: Record<string, unknown>, withSite: boolean): Option | null {
  if (typeof row.id !== 'string') return null;
  const label = [row.displayName, row.hostname, row.name].find((v) => typeof v === 'string' && v.trim());
  return {
    id: row.id,
    name: (label as string | undefined) ?? row.id,
    ...(withSite && typeof row.siteName === 'string' ? { extra: row.siteName } : {}),
  };
}

async function load(url: string, init: { skipOrgIdInjection?: boolean } | undefined, withSite: boolean, fallback: string) {
  const response = init ? await fetchWithAuth(url, init) : await fetchWithAuth(url);
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(extractApiError(body, fallback));
  return rows(body).map((r) => toOption(r, withSite)).filter((o): o is Option => o !== null);
}

export default function TargetPicker({ owner, onPick, isListed, offerOrganization = true }: TargetPickerProps) {
  const { t } = useTranslation('policies');
  const levels = useMemo(
    () => (offerOrganization ? LEVELS : LEVELS.filter((l) => l !== 'organization')),
    [offerOrganization],
  );
  const [level, setLevel] = useState<PickerLevel>(levels[0]!);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  // The MSP drill-down's chosen organization; an org-managed policy is pinned to its own.
  const [mspOrg, setMspOrg] = useState<Option | null>(null);
  const [options, setOptions] = useState<Option[]>([]);
  const [mspGroups, setMspGroups] = useState<Option[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const reqRef = useRef(0);

  const org = owner.kind === 'org' ? { id: owner.orgId, name: owner.orgName ?? owner.orgId } : mspOrg;
  // What the list shows: organizations to choose from (MSP, no org yet) or targets.
  const choosingOrg = owner.kind === 'msp' && (level === 'organization' || !mspOrg);

  useEffect(() => {
    if (!levels.includes(level)) setLevel(levels[0]!);
  }, [levels, level]);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const req = ++reqRef.current;
    const fallback = t('configurationPolicies.targetPicker.loadFailed');
    const search = debounced ? `&search=${encodeURIComponent(debounced).replace(/%20/g, '+')}` : '';
    let pending: Promise<[Option[], Option[]]>;
    if (owner.kind === 'org' && level === 'organization') {
      pending = Promise.resolve([[{ id: owner.orgId, name: owner.orgName ?? owner.orgId }], []]);
    } else if (choosingOrg) {
      // Never the switcher's org: the MSP picks among all of its organizations.
      const orgs = load(`/orgs/organizations?limit=${PAGE}${search}`, { skipOrgIdInjection: true }, false, fallback);
      const groups = level === 'device_group'
        ? load(`/device-groups?ownerScope=partner${search}`, { skipOrgIdInjection: true }, false, fallback)
        : Promise.resolve([]);
      pending = Promise.all([orgs, groups]);
    } else {
      const orgId = org!.id;
      const url =
        level === 'site' ? `/orgs/sites?orgId=${orgId}&limit=${PAGE}${search}`
        : level === 'device_group' ? `/device-groups?orgId=${orgId}${search}`
        : `/devices?orgId=${orgId}&limit=${PAGE}${search}`;
      const groups = owner.kind === 'msp' && level === 'device_group'
        ? load(`/device-groups?ownerScope=partner${search}`, { skipOrgIdInjection: true }, false, fallback)
        : Promise.resolve([]);
      pending = Promise.all([load(url, undefined, level === 'device', fallback), groups]);
    }
    setLoading(true);
    setError(undefined);
    pending
      .then(([main, msp]) => {
        if (req !== reqRef.current) return;
        setOptions(main);
        setMspGroups(msp);
      })
      .catch((err: unknown) => {
        if (req !== reqRef.current) return;
        setOptions([]);
        setMspGroups([]);
        setError(err instanceof Error ? err.message : fallback);
      })
      .finally(() => {
        if (req === reqRef.current) setLoading(false);
      });
    // `org` is derived from owner and mspOrg, both listed.
  }, [owner.kind, owner.kind === 'org' ? owner.orgId : null, mspOrg?.id, level, debounced, choosingOrg, t]);

  const selectLevel = (next: PickerLevel) => {
    setLevel(next);
    setQuery('');
    setDebounced('');
  };

  const pick = (pickLevel: ConfigPolicyTargetLevel, option: Option) => {
    onPick({ level: pickLevel, targetId: option.id, name: option.name });
  };

  const optionButton = (pickLevel: ConfigPolicyTargetLevel, option: Option, testid: string, onClick: () => void, drill = false) => {
    // Choosing an organization to drill into is not picking it as a target.
    const listed = !drill && !!isListed?.(pickLevel, option.id);
    return (
      <li key={`${testid}`}>
        <button
          type="button"
          data-testid={testid}
          disabled={listed}
          onClick={onClick}
          className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{option.name}</span>
            {option.extra && <span className="block truncate text-xs text-muted-foreground">{option.extra}</span>}
          </span>
          {listed && <span className="shrink-0 text-xs text-muted-foreground">{t('configurationPolicies.targetPicker.alreadyListed')}</span>}
        </button>
      </li>
    );
  };

  const lockedOrg = owner.kind === 'org' && level === 'organization';

  return (
    <div data-testid="target-picker" className="space-y-3">
      <div role="group" aria-label={t('configurationPolicies.targetPicker.levelGroupLabel')} className="flex flex-wrap gap-1">
        {levels.map((l) => (
          <button
            key={l}
            type="button"
            data-testid={`target-picker-level-${l}`}
            aria-pressed={level === l}
            onClick={() => selectLevel(l)}
            className={cn(
              'h-8 rounded-md border px-3 text-sm font-medium transition',
              level === l ? 'border-primary bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-muted',
            )}
          >
            {configTargetLevelLabel(l)}
          </button>
        ))}
      </div>

      {owner.kind === 'msp' && level !== 'organization' && mspOrg && (
        <div className="flex items-center gap-2 text-sm">
          <Building2 className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <span data-testid="target-picker-chosen-org" className="font-medium">{mspOrg.name}</span>
          <button
            type="button"
            data-testid="target-picker-change-org"
            onClick={() => { setMspOrg(null); setQuery(''); setDebounced(''); }}
            className="inline-flex items-center gap-1 text-xs text-primary underline-offset-4 hover:underline"
          >
            <ChevronLeft className="h-3 w-3" aria-hidden="true" />
            {t('configurationPolicies.targetPicker.changeOrganization')}
          </button>
        </div>
      )}

      {lockedOrg ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Lock className="h-3.5 w-3.5" aria-hidden="true" />
          {t('configurationPolicies.targetPicker.lockedOrganizationHint')}
        </p>
      ) : (
        <>
          {choosingOrg && level !== 'organization' && (
            <p className="text-xs text-muted-foreground">{t('configurationPolicies.targetPicker.chooseOrganizationFirst')}</p>
          )}
          <div className="flex items-center rounded-md border px-3 py-2">
            <Search className="mr-2 h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <input
              data-testid="target-picker-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('configurationPolicies.targetPicker.searchPlaceholder')}
              aria-label={t('configurationPolicies.targetPicker.searchPlaceholder')}
              className="w-full bg-transparent text-sm outline-hidden placeholder:text-muted-foreground"
            />
          </div>
        </>
      )}

      {error ? (
        <p role="alert" className="text-sm text-destructive">{error}</p>
      ) : loading && options.length === 0 && mspGroups.length === 0 ? (
        <p role="status" className="text-sm text-muted-foreground">{t('configurationPolicies.targetPicker.loading')}</p>
      ) : (
        <div className="space-y-3">
          {mspGroups.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('configurationPolicies.targetPicker.mspGroupsHeading')}
              </h4>
              <ul className="mt-1 max-h-48 divide-y overflow-y-auto rounded-md border">
                {mspGroups.map((g) => optionButton('device_group', g, `target-picker-option-${g.id}`, () => pick('device_group', g)))}
              </ul>
            </div>
          )}
          {options.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('configurationPolicies.targetPicker.noResults')}</p>
          ) : (
            <ul className="max-h-64 divide-y overflow-y-auto rounded-md border">
              {options.map((o) =>
                choosingOrg && level !== 'organization'
                  ? optionButton('organization', o, `target-picker-org-${o.id}`, () => { setMspOrg(o); setQuery(''); setDebounced(''); }, true)
                  : optionButton(level, o, `target-picker-option-${o.id}`, () => pick(level, o)),
              )}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
