import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Loader2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { YARA_BUILTIN_RULE_SET_ID, YARA_MAX_RULE_SETS_PER_POLICY } from "@breeze/shared";
import { listRuleSets, type YaraRuleSetSummary } from "../../security/detectionRules/ruleSetsApi";
import RuleSetBadges from "../../security/detectionRules/RuleSetBadges";
import type { FeatureLinkErrorDetail } from "./useFeatureLink";

/**
 * The policy that owns the security link. `orgId`: a string = org policy,
 * `null` = partner-wide policy, `undefined` = the editor did not say (then the
 * list is not filtered and the server gate stays the authority — never guess
 * partner-wide from undefined).
 */
export interface RuleSetPolicyOwner {
  orgId: string | null | undefined;
  partnerId: string | null;
}

const norm = (id: string) => id.trim().toLowerCase();

const NO_IDS: string[] = [];

/** The ids a gate 400 `YARA_RULE_SET_NOT_ATTACHABLE` named, from useFeatureLink's errorDetail. */
export function gateRuleSetIds(detail: FeatureLinkErrorDetail | undefined): string[] {
  if (detail?.code !== "YARA_RULE_SET_NOT_ATTACHABLE") return NO_IDS;
  const ids = (detail.body as { ruleSetIds?: unknown } | undefined)?.ruleSetIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : NO_IDS;
}

/**
 * The policy owner for the picker, from `FeatureTabProps`. A partner-wide
 * policy carries its partner, so partner-wide sets are matched to it; an org
 * policy's partner is not on the props, so its partner-wide sets are not
 * narrowed by partner here (the server gate resolves the org's partner and
 * stays the authority).
 */
export function useRuleSetPolicyOwner(
  orgId: string | null | undefined,
  partnerId: string | null | undefined,
): RuleSetPolicyOwner {
  return useMemo(() => ({ orgId, partnerId: partnerId ?? null }), [orgId, partnerId]);
}

/**
 * The sets a policy may attach — the same rule as the server's
 * `checkSecurityRuleSetsWrite`, applied to the POLICY owner, not the viewer:
 * an org policy may attach that org's sets, its partner's partner-wide sets
 * and the built-in pack; a partner-wide policy only partner-wide sets and the
 * built-in pack. Disabled, never-published and stale sets stay attachable (the
 * gate checks ownership only; each scan records their state).
 */
export function attachableRuleSets(sets: YaraRuleSetSummary[], owner: RuleSetPolicyOwner): YaraRuleSetSummary[] {
  if (owner.orgId === undefined) return sets;
  const partnerMatches = (s: YaraRuleSetSummary) => !owner.partnerId || s.partnerId === owner.partnerId;
  return sets.filter((s) => {
    if (s.isBuiltin) return true;
    if (s.orgId === null) return partnerMatches(s);
    return owner.orgId !== null && s.orgId === owner.orgId;
  });
}

export default function RuleSetPicker({
  value,
  onChange,
  policyOwner,
  disabled,
  onBlockingChange,
  preselectBuiltin = false,
  highlightIds = NO_IDS,
}: {
  value: string[];
  onChange: (ids: string[]) => void;
  policyOwner: RuleSetPolicyOwner;
  disabled: boolean;
  /** True while a saved id is unavailable for this policy (Save must be blocked). */
  onBlockingChange: (blocking: boolean) => void;
  /** Add the built-in pack once, on first load, when the security link is being created. */
  preselectBuiltin?: boolean;
  /** Ids a failed save named (gate `ruleSetIds`). */
  highlightIds?: string[];
}) {
  const { t } = useTranslation("policies");
  const [sets, setSets] = useState<YaraRuleSetSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const preselectDone = useRef(false);

  const { orgId, partnerId } = policyOwner;
  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Pin the request to the POLICY owner, not the org switcher (trap 2).
      // The route does not narrow on ?orgId= today; the pin keeps a future
      // narrowing from silently hiding the owner's sets.
      const rows = await listRuleSets(
        orgId === undefined ? {} : orgId === null ? { skipOrgIdInjection: true } : { orgIdOverride: orgId },
      );
      setSets(rows);
      setLoadFailed(false);
    } catch (err) {
      console.error("[RuleSetPicker] list:", err);
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  const attachable = useMemo(
    () => (sets ? attachableRuleSets(sets, { orgId, partnerId }) : []),
    [sets, orgId, partnerId],
  );
  const attachableIds = useMemo(() => new Set(attachable.map((s) => norm(s.id))), [attachable]);
  const selected = useMemo(() => new Set(value.map(norm)), [value]);
  const highlighted = useMemo(() => new Set(highlightIds.map(norm)), [highlightIds]);

  // Only a SUCCESSFUL list can make an id unavailable: a failed fetch is not deletion.
  const unavailable = sets && !loadFailed ? value.filter((id) => !attachableIds.has(norm(id))) : [];
  const blocking = unavailable.length > 0;

  useEffect(() => {
    onBlockingChange(blocking);
  }, [blocking, onBlockingChange]);

  useEffect(() => {
    if (!sets || preselectDone.current) return;
    preselectDone.current = true;
    if (preselectBuiltin && value.length === 0 && attachableIds.has(norm(YARA_BUILTIN_RULE_SET_ID))) {
      onChange([YARA_BUILTIN_RULE_SET_ID]);
    }
  }, [sets, preselectBuiltin, value.length, attachableIds, onChange]);

  const atCap = value.length >= YARA_MAX_RULE_SETS_PER_POLICY;
  const editable = !disabled && !loadFailed;

  const toggle = (id: string) => {
    if (selected.has(norm(id))) onChange(value.filter((v) => norm(v) !== norm(id)));
    else if (!atCap) onChange([...value, id]);
  };

  return (
    <section data-testid="rule-set-picker" className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold">
          {t("configurationPolicies.featureTabs.securityTab.ruleSets.title")}
        </h3>
        <p className="text-xs text-muted-foreground">
          {t("configurationPolicies.featureTabs.securityTab.ruleSets.description")}{" "}
          <a href="/security/detection-rules" className="font-medium text-primary hover:underline">
            {t("configurationPolicies.featureTabs.securityTab.ruleSets.manageLink")}
          </a>
        </p>
      </div>

      {loadFailed && (
        <div
          data-testid="rule-set-picker-load-error"
          role="alert"
          className="flex items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <span>{t("configurationPolicies.featureTabs.securityTab.ruleSets.loadError")}</span>
          <button
            type="button"
            data-testid="rule-set-picker-retry"
            onClick={() => void load()}
            className="rounded-md border border-destructive/40 bg-background px-2 py-1 font-medium"
          >
            {t("common:actions.retry")}
          </button>
        </div>
      )}

      {unavailable.length > 0 && (
        <div className="space-y-2">
          {unavailable.map((id) => (
            <div
              key={id}
              data-testid={`rule-set-unavailable-${id}`}
              data-highlighted={highlighted.has(norm(id)) ? "true" : "false"}
              className={`flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm ${
                highlighted.has(norm(id)) ? "border-destructive bg-destructive/10" : "border-amber-500/40 bg-amber-500/10"
              }`}
            >
              <div>
                <p className="font-medium">{t("configurationPolicies.featureTabs.securityTab.ruleSets.unavailable")}</p>
                <p className="font-mono text-xs text-muted-foreground">{id.slice(0, 8)}</p>
              </div>
              <button
                type="button"
                data-testid={`rule-set-unavailable-remove-${id}`}
                disabled={disabled}
                onClick={() => onChange(value.filter((v) => v !== id))}
                className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
              >
                <X className="h-3.5 w-3.5" />
                {t("common:actions.remove")}
              </button>
            </div>
          ))}
          <p
            data-testid="rule-set-picker-blocking"
            role="alert"
            className="flex items-start gap-2 text-xs text-amber-800"
          >
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {t("configurationPolicies.featureTabs.securityTab.ruleSets.blocking")}
          </p>
        </div>
      )}

      {loading && !sets ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("configurationPolicies.featureTabs.securityTab.ruleSets.loading")}
        </div>
      ) : sets && attachable.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t("configurationPolicies.featureTabs.securityTab.ruleSets.none")}
        </p>
      ) : (
        <ul className="max-h-72 space-y-1 overflow-auto rounded-md border p-2">
          {attachable.map((s) => {
            const checked = selected.has(norm(s.id));
            const isHighlighted = highlighted.has(norm(s.id));
            return (
              <li
                key={s.id}
                data-testid={`rule-set-option-row-${s.id}`}
                data-highlighted={isHighlighted ? "true" : "false"}
                className={`rounded-md px-2 py-1.5 ${isHighlighted ? "bg-destructive/10 ring-1 ring-destructive" : ""}`}
              >
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    data-testid={`rule-set-option-${s.id}`}
                    checked={checked}
                    disabled={!editable || (!checked && atCap)}
                    onChange={() => toggle(s.id)}
                  />
                  <span className="font-medium">{s.name}</span>
                  <RuleSetBadges set={s} testIdPrefix="rule-set-option-badge" />
                </label>
              </li>
            );
          })}
        </ul>
      )}

      {value.length === 0 && (
        <p data-testid="rule-set-picker-legacy-note" className="text-xs text-muted-foreground">
          {t("configurationPolicies.featureTabs.securityTab.ruleSets.legacyNote")}
        </p>
      )}
      {atCap && (
        <p data-testid="rule-set-picker-cap" className="text-xs text-muted-foreground">
          {t("configurationPolicies.featureTabs.securityTab.ruleSets.cap", { max: YARA_MAX_RULE_SETS_PER_POLICY })}
        </p>
      )}
    </section>
  );
}
