import { useId, type ReactNode } from 'react';
import { RefreshCcw } from 'lucide-react';
import { Trans, useTranslation } from 'react-i18next';
import '@/lib/i18n';

/**
 * Agent + watchdog version-pin selectors (issue #2124). Shared by the partner
 * defaults tab and the org defaults editor so both render identical controls.
 *
 * A pin value is a registered version string or the 'latest' sentinel (= no pin
 * → track the globally promoted latest).
 *
 * Semantics: INHERIT-WITH-OVERRIDE, keyed on PRESENCE
 * (`resolveInheritedAgentVersionPins` in @breeze/shared). A partner pin is an
 * inherited default. An org with no key for a component inherits it; an org
 * that stores its own value, including 'latest', overrides it. So the org view
 * offers two distinct options (issue #10584):
 *   - '' (empty)  → "Inherit partner default": REMOVES the org's key.
 *   - 'latest'    → "Always latest promoted, ignore partner pin": saves 'latest'.
 * The partner view has nothing to inherit from, so its empty option saves the
 * 'latest' sentinel and 'latest' is displayed as that empty option.
 *
 * The selector always edits the CURRENT level's own value; the caption + option
 * labels explain the effective source (global latest / partner default / this level).
 */

export type PinnableVersions = {
  components: {
    agent: { versions: string[]; promoted: string[] };
    watchdog: { versions: string[]; promoted: string[] };
  };
};

export type AgentVersionPinsValue = {
  agent?: string;
  watchdog?: string;
};

type Props = {
  value: AgentVersionPinsValue;
  onChange: (value: AgentVersionPinsValue) => void;
  pinnable: PinnableVersions | null;
  context: 'partner' | 'organization';
  /** Org view only: the partner's pins, shown as the inherited default. */
  inheritedPins?: AgentVersionPinsValue;
  /** Partner view: the inheritance badge beside each component's label. */
  labelAddon?: (key: (typeof COMPONENTS)[number]) => ReactNode;
  /** Partner view: the inheritance line under each component's select. */
  footer?: (key: (typeof COMPONENTS)[number]) => ReactNode;
};

const COMPONENTS = ['agent', 'watchdog'] as const;

/** Select value of the org view's explicit "latest, ignore partner pin" option. */
const LATEST_OVERRIDE = 'latest';

/** '' | 'latest' | undefined → no pin. Otherwise the concrete version. */
function normalize(raw: string | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim();
  if (t === '' || t.toLowerCase() === 'latest') return null;
  return t;
}

export default function AgentVersionPinSelectors({
  value,
  onChange,
  pinnable,
  context,
  inheritedPins,
  labelAddon,
  footer,
}: Props) {
  const { t } = useTranslation('settings');
  const idPrefix = useId();
  const setPin = (key: 'agent' | 'watchdog', raw: string) => {
    if (raw === '' && context === 'organization') {
      // Inherit: drop the org's own key so the partner default applies again.
      // Storing 'latest' here would override the partner pin (#10584).
      const { [key]: _removed, ...rest } = value;
      onChange(rest);
      return;
    }
    // Partner: the empty option is the explicit 'latest' sentinel.
    onChange({ ...value, [key]: raw === '' ? 'latest' : raw });
  };

  return (
    <div className="space-y-4 border-t pt-6" data-testid="agent-version-pins">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <RefreshCcw className="h-4 w-4" />
        {t('agentVersionPins.title')}
      </h3>
      <p className="text-xs text-muted-foreground">
        <Trans i18nKey="agentVersionPins.description" t={t} components={{ strong: <strong /> }} />
        {/* The partner view states inheritance with a per-pin badge (spec §5.3). */}
        {context === 'organization' && t('agentVersionPins.organizationDescription')}
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        {COMPONENTS.map((key) => {
          const options = pinnable?.components?.[key]?.versions ?? [];
          const promoted = pinnable?.components?.[key]?.promoted?.[0];
          const isOrg = context === 'organization';
          const ownVal = normalize(value[key]);
          // The org stores its own value for this component (presence, as the
          // resolver keys on). A set-but-normalizes-to-null value ('latest') is
          // an explicit "track latest, ignore the partner pin" override.
          const hasOwn = value[key] !== undefined;
          const ownLatest = isOrg && hasOwn && ownVal == null;
          const inheritedVal = isOrg ? normalize(inheritedPins?.[key]) : null;
          // 'latest' is a sentinel, never a version: show it as its own option
          // (org) or as the empty option (partner), not as an unregistered pin.
          const selectValue = ownVal ?? (ownLatest ? LATEST_OVERRIDE : '');

          const latestLabel = promoted
            ? t('agentVersionPins.latestVersion', { version: promoted })
            : t('agentVersionPins.latest');
          // Empty-option label. Org: "inherit the partner default", surfacing the
          // inherited value (or global latest when the partner has no pin).
          // Partner: the global latest it resolves to.
          const emptyLabel = isOrg
            ? inheritedVal != null
              ? t('agentVersionPins.inheritDefault', { version: inheritedVal })
              : t('agentVersionPins.inheritDefaultLatest')
            : latestLabel;
          const latestOverrideLabel = promoted
            ? t('agentVersionPins.latestOverrideVersion', { version: promoted })
            : t('agentVersionPins.latestOverride');

          let caption: string;
          if (ownLatest) {
            caption = inheritedVal
              ? t('agentVersionPins.overridesDefault', { version: inheritedVal })
              : t('agentVersionPins.latestOrganization');
          } else if (ownVal) {
            if (context === 'partner') {
              caption = t('agentVersionPins.pinnedAll');
            } else {
              caption = inheritedVal
                ? t('agentVersionPins.overridesDefault', { version: inheritedVal })
                : t('agentVersionPins.pinnedOrganization');
            }
          } else if (inheritedVal != null) {
            caption = t('agentVersionPins.inherited', { version: inheritedVal });
          } else {
            caption = promoted ? t('agentVersionPins.globalLatestVersion', { version: promoted }) : t('agentVersionPins.globalLatest');
          }

          const selectId = `${idPrefix}-${key}`;
          return (
            <div key={key} className="space-y-1 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <label htmlFor={selectId} className="font-medium">{t(/* i18n-dynamic */ `agentVersionPins.components.${key}`)}</label>
                {labelAddon?.(key)}
              </div>
              <select
                id={selectId}
                value={selectValue}
                onChange={(e) => setPin(key, e.target.value)}
                data-testid={`agent-pin-${context}-${key}`}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              >
                <option value="">{emptyLabel}</option>
                {isOrg && <option value={LATEST_OVERRIDE}>{latestOverrideLabel}</option>}
                {options.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
                {/* Preserve a stored pin whose build is no longer registered so a
                    save doesn't silently drop it. */}
                {ownVal && !options.includes(ownVal) && (
                  <option value={selectValue}>{t('agentVersionPins.unregistered', { version: selectValue })}</option>
                )}
              </select>
              <span
                className="block text-xs text-muted-foreground"
                data-testid={`agent-pin-source-${context}-${key}`}
              >
                {caption}
              </span>
              {footer?.(key)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
