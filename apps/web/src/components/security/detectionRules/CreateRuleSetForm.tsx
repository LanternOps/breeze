import { useState } from "react";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { ActionError } from "@/lib/runAction";
import { useDefaultOwnerScope } from "@/hooks/useDefaultOwnerScope";
import { useOrgStore } from "@/stores/orgStore";
import { showToast } from "../../shared/Toast";
import { createRuleSet, type CreateRuleSetInput, type YaraRuleSetSummary } from "./ruleSetsApi";

/**
 * "New rule set". The "All orgs" owner is offered only to partner-scope users
 * (Partner-Wide First); the server re-checks `canManagePartnerWidePolicies`
 * and a denial is toasted by runAction. A partner-scope user creating an org
 * set names the org explicitly — the route has no ambient org for them.
 */
export default function CreateRuleSetForm({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (set: YaraRuleSetSummary) => void;
}) {
  const { t } = useTranslation("security");
  const { isPartnerScope, defaultOwnerScope } = useDefaultOwnerScope();
  const organizations = useOrgStore((s) => s.organizations);
  const currentOrgId = useOrgStore((s) => s.currentOrgId);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [ownerScope, setOwnerScope] = useState<"organization" | "partner">(
    isPartnerScope ? defaultOwnerScope : "organization",
  );
  const [orgId, setOrgId] = useState<string>(currentOrgId ?? "");
  const [saving, setSaving] = useState(false);

  const needsOrg = isPartnerScope && ownerScope === "organization";
  const canSubmit = name.trim().length > 0 && (!needsOrg || orgId !== "") && !saving;

  const submit = async () => {
    if (!canSubmit) return;
    const input: CreateRuleSetInput = {
      name: name.trim(),
      ...(description.trim() ? { description: description.trim() } : {}),
      ownerScope: isPartnerScope ? ownerScope : "organization",
      ...(needsOrg ? { orgId } : {}),
    };
    setSaving(true);
    try {
      const res = await createRuleSet(input);
      onCreated(res.data);
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) showToast({ type: "error", message: t("common:states.error") });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      data-testid="rule-set-create-form"
      className="space-y-4 rounded-lg border bg-card p-5"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h3 className="text-sm font-semibold">{t("detectionRules.create.title")}</h3>
      <div className="grid gap-4 md:grid-cols-2">
        <label className="block text-sm">
          <span className="text-xs uppercase text-muted-foreground">{t("detectionRules.create.name")}</span>
          <input
            data-testid="rule-set-create-name"
            value={name}
            maxLength={255}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
          />
        </label>
        <label className="block text-sm">
          <span className="text-xs uppercase text-muted-foreground">{t("detectionRules.create.description")}</span>
          <input
            data-testid="rule-set-create-description"
            value={description}
            maxLength={2000}
            onChange={(e) => setDescription(e.target.value)}
            className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
          />
        </label>
      </div>

      {isPartnerScope && (
        <fieldset className="space-y-2 rounded-md border p-3" data-testid="rule-set-create-owner">
          <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">
            {t("detectionRules.create.owner")}
          </legend>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="ruleSetOwnerScope"
              data-testid="rule-set-create-owner-partner"
              checked={ownerScope === "partner"}
              onChange={() => setOwnerScope("partner")}
            />
            {t("detectionRules.create.ownerAllOrgs")}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="ruleSetOwnerScope"
              data-testid="rule-set-create-owner-org"
              checked={ownerScope === "organization"}
              onChange={() => setOwnerScope("organization")}
            />
            {t("detectionRules.create.ownerOrganization")}
          </label>
          {needsOrg && (
            <select
              data-testid="rule-set-create-org"
              aria-label={t("detectionRules.create.organization")}
              value={orgId}
              onChange={(e) => setOrgId(e.target.value)}
              className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              <option value="">{t("detectionRules.create.selectOrganization")}</option>
              {organizations.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          )}
        </fieldset>
      )}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          data-testid="rule-set-create-cancel"
          onClick={onCancel}
          className="rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted"
        >
          {t("common:actions.cancel")}
        </button>
        <button
          type="submit"
          data-testid="rule-set-create-submit"
          disabled={!canSubmit}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {saving && <Loader2 className="h-4 w-4 animate-spin" />}
          {t("detectionRules.create.submit")}
        </button>
      </div>
    </form>
  );
}
