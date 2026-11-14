import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import {
  AI_TOOL_DOMAINS,
  AI_TOOL_PROFILES,
  CONTEXT_WINDOW_OVERRIDE_MAX,
  CONTEXT_WINDOW_OVERRIDE_MIN,
  type AiOfferingDto,
  type AiOfferingToolSurfaceDto,
  type AiSurfaceReadinessDto,
  type AiToolDomain,
  type AiToolProfile,
  type AiToolProfiledSurface,
} from '@breeze/shared';
import { formatNumber } from '../../../lib/i18n/format';
import { SURFACE_LABEL_KEYS } from './surfaceLabels';

/**
 * "Tools and context" in the model drawer (#11398): the tool profile, its
 * custom allow-list and the context window override, plus what each surface
 * resolves to now, its verify readiness and what a verify costs. The drawer
 * owns the draft and the save; this file owns the section and its patch.
 */

export interface ToolsDraft {
  profile: AiToolProfile;
  domains: AiToolDomain[];
  /** Custom tool names as typed (commas or new lines). */
  toolsText: string;
  /** The override as typed; '' = none. */
  windowOverride: string;
}

export function toolsDraftFrom(o: AiOfferingDto): ToolsDraft {
  return {
    profile: o.toolProfile.profile,
    domains: [...(o.toolProfile.allowlist?.domains ?? [])],
    toolsText: (o.toolProfile.allowlist?.tools ?? []).join(', '),
    windowOverride: o.contextWindow?.override != null ? String(o.contextWindow.override) : '',
  };
}

const parseTools = (text: string): string[] => [...new Set(text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))].sort();
const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export type ToolsPatchResult = Record<string, unknown> | 'invalid_custom' | 'invalid_window';

/**
 * The tool fields of the PATCH. The profile and the allow-list always travel
 * together when either changed (the API validates the merged state and a
 * custom profile needs its list; any other profile needs it cleared).
 */
export function buildToolsPatch(o: AiOfferingDto, d: ToolsDraft): ToolsPatchResult {
  const patch: Record<string, unknown> = {};
  const stored = o.toolProfile;
  const domains = [...new Set(d.domains)].sort();
  const tools = parseTools(d.toolsText);
  const storedDomains = [...(stored.allowlist?.domains ?? [])].sort();
  const storedTools = [...(stored.allowlist?.tools ?? [])].sort();
  const listChanged = d.profile === 'custom' && (!sameList(domains, storedDomains) || !sameList(tools, storedTools));
  if (d.profile !== stored.profile || listChanged) {
    if (d.profile === 'custom' && domains.length + tools.length === 0) return 'invalid_custom';
    patch.toolProfile = d.profile;
    patch.toolAllowlist = d.profile === 'custom' ? { domains, tools } : null;
  }
  if (stored.windowOverrideSupported) {
    const raw = d.windowOverride.trim().replace(/[,\s_]/g, '');
    let value: number | null = null;
    if (raw !== '') {
      value = Number(raw);
      if (!Number.isInteger(value) || value < CONTEXT_WINDOW_OVERRIDE_MIN || value > CONTEXT_WINDOW_OVERRIDE_MAX) return 'invalid_window';
    }
    if (value !== (o.contextWindow?.override ?? null)) patch.contextWindowOverride = value;
  }
  return patch;
}

/** A refusal's per-surface gaps (`tool_profile_underpowered` details). */
export type ToolGaps = Array<{ surface: string; missing: string[]; tooSmall?: boolean }>;

// Literal key maps: the i18n keyUsage test cannot check template keys.
const PROFILE_KEYS: Record<AiToolProfile, string> = {
  auto: 'aiModels.offering.tools.profile.auto',
  full: 'aiModels.offering.tools.profile.full',
  standard: 'aiModels.offering.tools.profile.standard',
  minimal: 'aiModels.offering.tools.profile.minimal',
  custom: 'aiModels.offering.tools.profile.custom',
};
const PROFILE_HINT_KEYS: Record<AiToolProfile, string> = {
  auto: 'aiModels.offering.tools.profileHint.auto',
  full: 'aiModels.offering.tools.profileHint.full',
  standard: 'aiModels.offering.tools.profileHint.standard',
  minimal: 'aiModels.offering.tools.profileHint.minimal',
  custom: 'aiModels.offering.tools.profileHint.custom',
};
const RESOLVED_KEYS: Record<AiOfferingToolSurfaceDto['resolved'], string> = {
  full: 'aiModels.offering.tools.profile.full',
  standard: 'aiModels.offering.tools.profile.standard',
  minimal: 'aiModels.offering.tools.profile.minimal',
  custom: 'aiModels.offering.tools.profile.custom',
  too_small: 'aiModels.offering.tools.tooSmall',
};
const REASON_KEYS: Record<AiOfferingToolSurfaceDto['reason'], string> = {
  explicit: 'aiModels.offering.tools.reason.explicit',
  auto_window: 'aiModels.offering.tools.reason.auto_window',
  auto_unknown_window: 'aiModels.offering.tools.reason.auto_unknown_window',
  auto_unmeasured: 'aiModels.offering.tools.reason.auto_unmeasured',
};
const WINDOW_SOURCE_KEYS = {
  override: 'aiModels.offering.tools.windowSource.override',
  discovered: 'aiModels.offering.tools.windowSource.discovered',
} as const;
const DOMAIN_KEYS: Record<AiToolDomain, string> = {
  core: 'aiModels.offering.tools.domainCore',
  devices: 'common:longTail.mcpDomains.labels.devices',
  scripts: 'common:longTail.mcpDomains.labels.scripts',
  patching: 'common:longTail.mcpDomains.labels.patching',
  monitoring: 'common:longTail.mcpDomains.labels.monitoring',
  network: 'common:longTail.mcpDomains.labels.network',
  security: 'common:longTail.mcpDomains.labels.security',
  backup: 'common:longTail.mcpDomains.labels.backup',
  tickets: 'common:longTail.mcpDomains.labels.tickets',
  billing: 'common:longTail.mcpDomains.labels.billing',
  accounts: 'common:longTail.mcpDomains.labels.accounts',
  integrations: 'common:longTail.mcpDomains.labels.integrations',
  admin: 'common:longTail.mcpDomains.labels.admin',
  ai: 'common:longTail.mcpDomains.labels.ai',
};
const PROFILE_RANK = { minimal: 0, standard: 1, full: 2 } as const;

/** "12 min ago" / "3 h ago" / "2 d ago". Honest age only: nothing here changes how an old observation is used. */
function ageText(iso: string, t: TFunction<'settings'>, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000));
  if (minutes < 60) return t('aiModels.offering.tools.ageMinutes', { n: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 48) return t('aiModels.offering.tools.ageHours', { n: hours });
  return t('aiModels.offering.tools.ageDays', { n: Math.round(hours / 24) });
}

function windowFacts(o: AiOfferingDto, t: TFunction<'settings'>): string {
  const w = o.contextWindow;
  if (!o.toolProfile.windowOverrideSupported || !w) return t('aiModels.offering.tools.windowNotLearned');
  if (w.effective === null) return t('aiModels.offering.tools.capacityUnknown');
  const tokens = formatNumber(w.effective);
  if (w.source === 'observed' && w.observed) {
    return t('aiModels.offering.tools.windowObserved', { tokens, age: ageText(w.observed.at, t) });
  }
  const sourceKey = w.source === 'override' ? WINDOW_SOURCE_KEYS.override : WINDOW_SOURCE_KEYS.discovered;
  return t('aiModels.offering.tools.windowKnown', { tokens, source: t(/* i18n-dynamic */ sourceKey) });
}

function readinessText(r: AiSurfaceReadinessDto, surface: AiToolProfiledSurface, basicVerified: boolean, t: TFunction<'settings'>, surfaceLabel: string): string {
  const tokens = r.promptTokens !== null ? t('aiModels.offering.tools.readiness.tokens', { tokens: formatNumber(r.promptTokens) }) : '';
  switch (r.state) {
    case 'passed': return tokens ? `${t('aiModels.offering.tools.readiness.passed')} · ${tokens}` : t('aiModels.offering.tools.readiness.passed');
    case 'failed': return t('aiModels.offering.tools.readiness.failed', { summary: r.summary ?? '' }).trim();
    case 'inconclusive': return t('aiModels.offering.tools.readiness.inconclusive', { summary: r.summary ?? '' }).trim();
    case 'stale': return t('aiModels.offering.tools.readiness.stale');
    case 'absent':
      if (surface === 'office_chat') return t('aiModels.offering.tools.readiness.officeNotChecked');
      return basicVerified ? t('aiModels.offering.tools.readiness.absentVerified', { surface: surfaceLabel }) : t('aiModels.offering.tools.readiness.absent');
  }
}

export interface OfferingToolsSectionProps {
  offering: AiOfferingDto;
  draft: ToolsDraft;
  onChange: (patch: Partial<ToolsDraft>) => void;
  disabled: boolean;
  /** The last save's `tool_profile_underpowered` gaps, shown inline. */
  gaps: ToolGaps | null;
}

export default function OfferingToolsSection({ offering, draft, onChange, disabled, gaps }: OfferingToolsSectionProps) {
  const { t } = useTranslation('settings');
  const tp = offering.toolProfile;
  const w = offering.contextWindow;
  const verification = offering.verification;
  const surfaceLabel = (s: string) => (s in SURFACE_LABEL_KEYS ? t(/* i18n-dynamic */ SURFACE_LABEL_KEYS[s as AiToolProfiledSurface]) : s);
  const inputClass = 'h-10 w-full rounded-md border bg-background px-3 text-sm';
  const toggleDomain = (domain: AiToolDomain, on: boolean) =>
    onChange({ domains: on ? [...new Set([...draft.domains, domain])] : draft.domains.filter((d) => d !== domain) });

  return (
    <fieldset className="space-y-3 rounded-md border p-3" disabled={disabled} data-testid="ai-offering-tools-section">
      <legend className="px-1 text-sm font-medium">{t('aiModels.offering.tools.title')}</legend>
      <p className="text-xs text-muted-foreground">{t('aiModels.offering.tools.partnerOnly')}</p>

      <div className="space-y-1">
        <label className="text-sm font-medium" htmlFor="ai-offering-tool-profile">{t('aiModels.offering.tools.profileLabel')}</label>
        <select id="ai-offering-tool-profile" data-testid="ai-offering-tool-profile" className={inputClass} value={draft.profile}
          onChange={(e) => onChange({ profile: e.target.value as AiToolProfile })}>
          {AI_TOOL_PROFILES.map((p) => <option key={p} value={p}>{t(/* i18n-dynamic */ PROFILE_KEYS[p])}</option>)}
        </select>
        <p className="text-xs text-muted-foreground">{t(/* i18n-dynamic */ PROFILE_HINT_KEYS[draft.profile])}</p>
        <p className="text-xs text-muted-foreground">{t('aiModels.offering.tools.appliesWhen')}</p>
      </div>

      {draft.profile === 'custom' && (
        <div className="space-y-2" data-testid="ai-offering-tool-custom">
          <p className="text-xs font-medium">{t('aiModels.offering.tools.domainsLabel')}</p>
          <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
            {AI_TOOL_DOMAINS.map((domain) => (
              <label key={domain} className="flex items-center gap-2 text-sm">
                <input type="checkbox" data-testid={`ai-offering-tool-domain-${domain}`} checked={draft.domains.includes(domain)}
                  onChange={(e) => toggleDomain(domain, e.target.checked)} />
                {t(/* i18n-dynamic */ DOMAIN_KEYS[domain])}
              </label>
            ))}
          </div>
          <label className="block space-y-1 text-xs font-medium" htmlFor="ai-offering-tool-list">
            {t('aiModels.offering.tools.toolsLabel')}
            <textarea id="ai-offering-tool-list" data-testid="ai-offering-tool-list" rows={3}
              className="w-full rounded-md border bg-background px-3 py-2 font-mono text-xs" value={draft.toolsText}
              onChange={(e) => onChange({ toolsText: e.target.value })} />
          </label>
          <p className="text-xs text-muted-foreground">{t('aiModels.offering.tools.toolsHint')}</p>
        </div>
      )}

      {tp.droppedCustomNames.length > 0 && (
        <p data-testid="ai-offering-dropped-tools" role="status" className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
          {t('aiModels.offering.tools.droppedTools', { tools: tp.droppedCustomNames.join(', ') })}
        </p>
      )}

      {gaps && gaps.length > 0 && (
        <div data-testid="ai-offering-tools-error" role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <p>{t('aiModels.offering.tools.underpowered')}</p>
          <ul className="mt-1 list-disc pl-4">
            {gaps.map((g) => (
              <li key={g.surface}>
                {g.missing.length > 0 && t('aiModels.offering.tools.underpoweredSurface', { surface: surfaceLabel(g.surface), tools: g.missing.join(', ') })}
                {g.missing.length > 0 && g.tooSmall && ' · '}
                {g.tooSmall && t('aiModels.offering.tools.underpoweredTooSmall', { surface: surfaceLabel(g.surface) })}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="space-y-1">
        <p data-testid="ai-offering-context-facts" className="text-sm">{windowFacts(offering, t)}</p>
        {w?.observed && !w.observed.fresh && (
          <p data-testid="ai-offering-context-observed-stale" className="text-xs text-muted-foreground">
            {t('aiModels.offering.tools.observedStale', { tokens: formatNumber(w.observed.value), age: ageText(w.observed.at, t) })}
          </p>
        )}
        {tp.windowOverrideSupported && (
          <>
            <label className="text-sm font-medium" htmlFor="ai-offering-context-window">{t('aiModels.offering.tools.overrideLabel')}</label>
            <input id="ai-offering-context-window" data-testid="ai-offering-context-window" className={inputClass} inputMode="numeric"
              placeholder={w?.discovered != null ? formatNumber(w.discovered) : ''} value={draft.windowOverride}
              onChange={(e) => onChange({ windowOverride: e.target.value })} />
            <p className="text-xs text-muted-foreground">{t('aiModels.offering.tools.overrideHint')}</p>
          </>
        )}
      </div>

      <div className="space-y-1">
        <p className="text-xs font-medium">{t('aiModels.offering.tools.surfacesTitle')}</p>
        <ul className="space-y-1.5">
          {tp.surfaces.map((s) => {
            const readiness = verification?.surfaces[s.surface];
            const tooBig = s.resolved !== 'custom' && s.resolved !== 'too_small' && s.autoProfile !== null
              && (s.autoProfile === 'too_small' || PROFILE_RANK[s.autoProfile] < PROFILE_RANK[s.resolved]);
            return (
              <li key={s.surface} className="rounded-md bg-muted/40 px-2 py-1.5 text-xs">
                <div data-testid={`ai-offering-tool-surface-${s.surface}`}>
                  <span className="font-medium">{surfaceLabel(s.surface)}</span>
                  {': '}
                  {t(/* i18n-dynamic */ RESOLVED_KEYS[s.resolved])}
                  {' · '}
                  <span className="text-muted-foreground">{t(/* i18n-dynamic */ REASON_KEYS[s.reason])}</span>
                  {s.missingRequired.length > 0 && (
                    <span className="block text-destructive">
                      {s.surface === 'ai_agents'
                        // Only device-troubleshooting runs need these; other agent runs keep their outcome tools.
                        ? t('aiModels.offering.tools.missingRequiredTroubleshooting', { tools: s.missingRequired.join(', ') })
                        : t('aiModels.offering.tools.missingRequired', { tools: s.missingRequired.join(', ') })}
                    </span>
                  )}
                  {s.resolved === 'too_small' && <span className="block text-destructive">{t('aiModels.offering.tools.tooSmallHint')}</span>}
                </div>
                {tooBig && (
                  <p data-testid={`ai-offering-tool-fit-${s.surface}`} className="text-amber-700 dark:text-amber-400">
                    {t('aiModels.offering.tools.fitSuggestion', {
                      profile: t(/* i18n-dynamic */ RESOLVED_KEYS[s.autoProfile!]),
                      tokens: formatNumber(w?.effective ?? 0),
                    })}
                  </p>
                )}
                {readiness && (
                  <p data-testid={`ai-offering-readiness-${s.surface}`} className="text-muted-foreground">
                    {readinessText(readiness, s.surface, verification?.state === 'verified', t, surfaceLabel(s.surface))}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      {verification && (
        <p data-testid="ai-offering-verify-cost" className="text-xs text-muted-foreground">{t('aiModels.offering.tools.verifyCost')}</p>
      )}
    </fieldset>
  );
}
