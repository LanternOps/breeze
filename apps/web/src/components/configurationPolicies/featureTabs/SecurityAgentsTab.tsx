import { useEffect, useState } from 'react';
import { ShieldCheck, Layers, AlertTriangle, Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { FeatureTabProps } from './types';
import { useFeatureLink } from './useFeatureLink';
import FeatureTabShell from './FeatureTabShell';
import '@/lib/i18n';

// Inline settings for the `security_agents` feature: which vendor security
// agents Breeze keeps installed on devices this policy reaches. The API schema
// is strict ({ version: 1, agents: [...] }) and `featurePolicyId` is always
// null; keys/tokens never live here (they come from the vendor integration).

type Vendor = 'huntress' | 'sentinelone' | 'controld' | 'nextdns';
type Platform = 'windows' | 'macos' | 'linux';
type AgentEntry = { vendor: Vendor; enabled: boolean; platforms?: Platform[] };

// Display order. `enableable` mirrors the API vendor registry
// (securityAgentVendors.ts): only Huntress can be armed today.
const VENDORS: ReadonlyArray<{ vendor: Vendor; name: string; enableable: boolean }> = [
  { vendor: 'huntress', name: 'Huntress', enableable: true },
  { vendor: 'sentinelone', name: 'SentinelOne', enableable: false },
  { vendor: 'controld', name: 'Control D', enableable: false },
  { vendor: 'nextdns', name: 'NextDNS', enableable: false },
];
const VENDOR_IDS = new Set<string>(VENDORS.map((v) => v.vendor));
const PLATFORMS = new Set<string>(['windows', 'macos', 'linux']);

const DEFAULT_SETUP_PATH = '/integrations#huntress';
const CATALOG_MISSING = 'security_agents_catalog_missing';
const EXECUTE_REQUIRED = 'security_agents_execute_required';

/** Parse a stored blob defensively; unknown vendors/keys are dropped (strict API schema). */
function readAgents(raw: unknown): Map<Vendor, AgentEntry> {
  const out = new Map<Vendor, AgentEntry>();
  const agents = (raw as { agents?: unknown } | null | undefined)?.agents;
  if (!Array.isArray(agents)) return out;
  for (const item of agents) {
    if (!item || typeof item !== 'object') continue;
    const { vendor, enabled, platforms } = item as Record<string, unknown>;
    if (typeof vendor !== 'string' || !VENDOR_IDS.has(vendor)) continue;
    const entry: AgentEntry = { vendor: vendor as Vendor, enabled: enabled === true };
    if (Array.isArray(platforms)) {
      const valid = platforms.filter((p): p is Platform => typeof p === 'string' && PLATFORMS.has(p));
      if (valid.length > 0) entry.platforms = valid;
    }
    out.set(entry.vendor, entry);
  }
  return out;
}

/** Only same-site absolute paths may become a link target (server value is untrusted). */
function safeSetupPath(body: unknown): string {
  const value = (body as { setupPath?: unknown } | null | undefined)?.setupPath;
  // Reject protocol-relative forms, including the backslash variants browsers normalize.
  return typeof value === 'string' && /^\/(?![\/\\])/.test(value) && !value.includes('\\')
    ? value
    : DEFAULT_SETUP_PATH;
}

export default function SecurityAgentsTab({
  policyId,
  existingLink,
  parentLink,
  linkedPolicyId,
  onLinkChanged,
  orgId,
}: FeatureTabProps) {
  const { t } = useTranslation('policies');
  const k = (key: string, opts?: Record<string, unknown>) =>
    t(/* i18n-dynamic */ `configurationPolicies.featureTabs.securityAgentsTab.${key}`, opts);
  const { save, remove, saving, error, errorDetail, clearError } = useFeatureLink(policyId);

  const source = (existingLink ?? parentLink)?.inlineSettings;
  const [stored, setStored] = useState(() => readAgents(source));
  const [enabled, setEnabled] = useState<Record<Vendor, boolean>>(() => enabledFrom(readAgents(source)));
  useEffect(() => {
    const next = readAgents((existingLink ?? parentLink)?.inlineSettings);
    setStored(next);
    setEnabled(enabledFrom(next));
  }, [existingLink, parentLink]);

  const inherited = !!parentLink && !existingLink;
  const partnerWide = orgId === null;

  const buildAgents = (): AgentEntry[] => {
    const agents: AgentEntry[] = [];
    for (const { vendor, enableable } of VENDORS) {
      const prior = stored.get(vendor);
      // Never send enabled:true for a vendor the API cannot arm yet.
      const on = enableable && enabled[vendor];
      if (!on && !prior) continue;
      const entry: AgentEntry = { vendor, enabled: on };
      if (prior?.platforms) entry.platforms = prior.platforms;
      agents.push(entry);
    }
    return agents;
  };

  const persist = async (id: string | null) => {
    clearError();
    const result = await save(id, {
      featureType: 'security_agents',
      featurePolicyId: null,
      inlineSettings: { version: 1, agents: buildAgents() },
    });
    if (result) onLinkChanged(result, 'security_agents');
  };
  const discard = async () => {
    if (existingLink && (await remove(existingLink.id))) onLinkChanged(null, 'security_agents');
  };

  const code = errorDetail?.code;
  const handledError = code === CATALOG_MISSING || code === EXECUTE_REQUIRED;
  const anyEnabled = VENDORS.some((v) => v.enableable && enabled[v.vendor]);

  return (
    <FeatureTabShell
      title={k('title')}
      description={k('description')}
      icon={<ShieldCheck className="h-5 w-5" />}
      isConfigured={!!existingLink || inherited}
      saving={saving}
      error={handledError ? undefined : error}
      onSave={() => void persist(existingLink?.id ?? null)}
      onRemove={existingLink && !linkedPolicyId ? discard : undefined}
      isInherited={inherited}
      onOverride={inherited ? () => void persist(null) : undefined}
      onRevert={!inherited && !!linkedPolicyId && !!existingLink ? discard : undefined}
    >
      {partnerWide && (
        <span
          data-testid="security-agents-partner-wide-badge"
          className="mb-4 inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
        >
          <Layers className="h-3 w-3" />
          {k('partnerWideBadge')}
        </span>
      )}

      {code === CATALOG_MISSING && (
        <div
          role="alert"
          data-testid="security-agents-catalog-missing"
          className="mb-4 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            {k('catalogMissing')}{' '}
            <a
              data-testid="security-agents-catalog-missing-link"
              href={safeSetupPath(errorDetail?.body)}
              className="font-medium underline"
            >
              {k('catalogMissingLink')}
            </a>
          </p>
        </div>
      )}
      {code === EXECUTE_REQUIRED && (
        <div
          role="alert"
          data-testid="security-agents-execute-required"
          className="mb-4 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>{k('executeRequired')}</p>
        </div>
      )}

      <fieldset disabled={inherited || saving} className="space-y-3">
        {VENDORS.map(({ vendor, name, enableable }) => (
          <div key={vendor} className="rounded-md border p-3">
            <label className="flex items-center gap-2 text-sm font-medium">
              <input
                data-testid={`security-agents-${vendor}-toggle`}
                type="checkbox"
                role="switch"
                checked={enableable && enabled[vendor]}
                disabled={!enableable}
                onChange={(e) => setEnabled((prev) => ({ ...prev, [vendor]: e.target.checked }))}
              />
              {k('deployVendor', { vendor: name })}
              {!enableable && (
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-normal text-muted-foreground">
                  {k('comingSoon')}
                </span>
              )}
            </label>
            {vendor === 'huntress' && (
              <ul className="mt-2 space-y-1 pl-6 text-xs text-muted-foreground">
                <li data-testid="security-agents-platform-windows">{k('platformWindows')}</li>
                <li data-testid="security-agents-platform-macos">{k('platformMacos')}</li>
                <li data-testid="security-agents-platform-linux">{k('platformLinux')}</li>
              </ul>
            )}
          </div>
        ))}
      </fieldset>

      {!anyEnabled && (
        <p className="mt-3 text-xs text-muted-foreground">{k('noneEnabledNote')}</p>
      )}

      <div
        data-testid="security-agents-keys-notice"
        className="mt-4 flex items-start gap-2 rounded-md bg-muted/50 p-3 text-xs text-muted-foreground"
      >
        <Info className="mt-0.5 h-4 w-4 shrink-0" />
        <p>{k('keysNotice')}</p>
      </div>
      <div
        data-testid="security-agents-closer-warning"
        className="mt-3 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-300"
      >
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <p>{k('closerWarning')}</p>
      </div>
    </FeatureTabShell>
  );
}

function enabledFrom(agents: Map<Vendor, AgentEntry>): Record<Vendor, boolean> {
  return {
    huntress: agents.get('huntress')?.enabled === true,
    sentinelone: false,
    controld: false,
    nextdns: false,
  };
}
