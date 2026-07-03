import { RefreshCcw } from 'lucide-react';

/**
 * Agent + watchdog version-pin selectors (issue #2124). Shared by the partner
 * defaults tab and the org defaults editor so both render identical controls.
 *
 * A pin value is a registered version string or the 'latest' sentinel (= no pin
 * → track the globally promoted latest). The empty select option maps to
 * 'latest'.
 *
 * Semantics: INHERIT-WITH-OVERRIDE. A partner pin is an inherited default; an
 * org may set its own pin (including 'latest') to override it. The selector
 * always edits the CURRENT level's own value; the caption + empty-option label
 * explain the effective source (global latest / partner default / this level).
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
};

const COMPONENTS: Array<{ key: 'agent' | 'watchdog'; label: string }> = [
  { key: 'agent', label: 'Agent target' },
  { key: 'watchdog', label: 'Watchdog target' },
];

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
}: Props) {
  const setPin = (key: 'agent' | 'watchdog', raw: string) => {
    // Empty select → 'latest' sentinel so the saved object is explicit (and, for
    // an org, deliberately overrides an inherited partner pin back to latest).
    onChange({ ...value, [key]: raw === '' ? 'latest' : raw });
  };

  return (
    <div className="space-y-4 rounded-lg border bg-muted/40 p-4" data-testid="agent-version-pins">
      <div className="flex items-center gap-2 text-sm font-medium">
        <RefreshCcw className="h-4 w-4" />
        Update version targets
      </div>
      <p className="text-xs text-muted-foreground">
        Pin the agent and watchdog to a specific registered version, or leave on{' '}
        <strong>Latest promoted</strong> to track the globally promoted release. Agent and watchdog
        are independent.
        {context === 'partner'
          ? ' A pin here is the default for all your organizations; an organization can override it.'
          : ' An organization pin overrides the partner default.'}
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        {COMPONENTS.map(({ key, label }) => {
          const options = pinnable?.components?.[key]?.versions ?? [];
          const promoted = pinnable?.components?.[key]?.promoted?.[0];
          const ownVal = normalize(value[key]);
          const inheritedVal = context === 'organization' ? normalize(inheritedPins?.[key]) : null;
          const selectValue = value[key] ?? '';

          // Empty-option label: for an org that hasn't set its own pin, the empty
          // state means "inherit the partner default", so surface that value.
          const emptyLabel =
            inheritedVal != null
              ? `Inherit partner default (${inheritedVal})`
              : promoted
                ? `Latest promoted (${promoted})`
                : 'Latest promoted';

          let caption: string;
          if (ownVal) {
            if (context === 'partner') {
              caption = 'Pinned for all organizations';
            } else {
              caption = inheritedVal
                ? `Overrides partner default (${inheritedVal})`
                : 'Pinned for this organization';
            }
          } else if (inheritedVal != null) {
            caption = `Inherited from partner: ${inheritedVal}`;
          } else {
            caption = promoted ? `Global latest promoted (${promoted})` : 'Global latest promoted';
          }

          return (
            <label key={key} className="space-y-1 text-sm">
              <span className="font-medium">{label}</span>
              <select
                value={selectValue}
                onChange={(e) => setPin(key, e.target.value)}
                data-testid={`agent-pin-${context}-${key}`}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              >
                <option value="">{emptyLabel}</option>
                {options.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
                {/* Preserve a stored pin whose build is no longer registered so a
                    save doesn't silently drop it. */}
                {selectValue && !options.includes(selectValue) && (
                  <option value={selectValue}>{selectValue} (unregistered)</option>
                )}
              </select>
              <span
                className="block text-xs text-muted-foreground"
                data-testid={`agent-pin-source-${context}-${key}`}
              >
                {caption}
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
