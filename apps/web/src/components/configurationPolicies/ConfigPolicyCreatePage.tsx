import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { i18n } from "@/lib/i18n";
import PolicyLinkSelector from "./featureTabs/PolicyLinkSelector";
import type { DraftParent } from "./page/usePolicyDraft";

type StartFromProps = {
  /**
   * `GET /configuration-policies/eligible-parents` for the chosen owner, or
   * null while an organization-managed draft has no organization yet.
   */
  eligibleUrl: string | null;
  parent: DraftParent | null;
  onChange: (parent: DraftParent | null) => void;
};

/**
 * "Start from" on the create page (spec "Create: inactive until activated";
 * plan W03d C1). This used to be a two-card chooser that had to be answered
 * before anything else; now it is optional and sits on the policy page:
 * Blank, or Based on a parent policy. Copy of an existing policy (#12309) is
 * offered on that policy's page and in the list, not here.
 * The parent is fixed at the first save; the page says so beside it.
 */
export default function ConfigPolicyCreatePage({ eligibleUrl, parent, onChange }: StartFromProps) {
  useTranslation("policies");
  const [mode, setMode] = useState<"blank" | "parent">(parent ? "parent" : "blank");
  const [pendingId, setPendingId] = useState<string | null>(parent?.id ?? null);
  // A parent valid for one owner is not valid for another: the draft clears
  // it when the owner changes, and the picker follows.
  useEffect(() => {
    if (!parent) setPendingId(null);
  }, [parent]);

  return (
    <fieldset className="space-y-2" data-testid="config-policy-start-from">
      <legend className="text-sm font-medium">{i18n.t('policies:configurationPolicies.policyCreate.startFromLegend')}</legend>
      <div className="flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name="config-policy-start-from"
            data-testid="config-policy-start-blank"
            checked={mode === "blank"}
            onChange={() => {
              setMode("blank");
              setPendingId(null);
              onChange(null);
            }}
          />
          {i18n.t('policies:configurationPolicies.policyCreate.startFromBlank')}
        </label>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name="config-policy-start-from"
            data-testid="config-policy-start-parent"
            checked={mode === "parent"}
            onChange={() => setMode("parent")}
          />
          {i18n.t('policies:configurationPolicies.policyCreate.startFromParent')}
        </label>
      </div>
      {mode === "parent" && (
        <div className="max-w-md">
          {eligibleUrl ? (
            <PolicyLinkSelector
              fetchUrl={eligibleUrl}
              selectedId={pendingId}
              onSelect={(id) => {
                setPendingId(id);
                if (!id) onChange(null);
              }}
              onPolicyNameResolved={(name) => {
                if (pendingId && pendingId !== parent?.id) onChange({ id: pendingId, name });
              }}
            />
          ) : (
            <p className="text-sm text-muted-foreground" data-testid="config-policy-start-parent-needs-org">
              {i18n.t('policies:configurationPolicies.policyCreate.parentNeedsOrganization')}
            </p>
          )}
          <p className="mt-1 text-xs text-muted-foreground">{i18n.t('policies:configurationPolicies.policyCreate.parentHint')}</p>
        </div>
      )}
    </fieldset>
  );
}

/** The eligible-parents read for a draft's owner (#5080: filtered on the server). */
export function eligibleParentsUrl(owner: { kind: "msp" } | { kind: "org"; orgId: string | null }): string | null {
  if (owner.kind === "msp") return "/configuration-policies/eligible-parents?ownerScope=partner";
  return owner.orgId
    ? `/configuration-policies/eligible-parents?ownerScope=organization&orgId=${encodeURIComponent(owner.orgId)}`
    : null;
}
