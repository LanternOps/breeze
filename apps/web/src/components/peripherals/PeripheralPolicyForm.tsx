import { useState } from "react";
import { X, Plus, Trash2 } from "lucide-react";
import { fetchWithAuth } from "../../stores/auth";
import { useOrgStore } from "../../stores/orgStore";
import { useDefaultOwnerScope } from "@/hooks/useDefaultOwnerScope";
import { extractApiError } from "@/lib/apiError";
import { useTranslation } from "react-i18next";

type ExceptionRule = {
  vendor: string;
  product: string;
  serialNumber: string;
  allow: boolean;
  reason: string;
  expiresAt: string;
};

type PeripheralPolicy = {
  id: string;
  name: string;
  deviceClass: string;
  action: string;
  isActive: boolean;
  exceptions?: Array<Record<string, unknown>>;
};

type PeripheralPolicyFormProps = {
  policy?: PeripheralPolicy | null;
  onClose: (refresh?: boolean) => void;
};

const emptyException = (): ExceptionRule => ({
  vendor: "",
  product: "",
  serialNumber: "",
  allow: true,
  reason: "",
  expiresAt: "",
});

export default function PeripheralPolicyForm({
  policy,
  onClose,
}: PeripheralPolicyFormProps) {
  const { t } = useTranslation("peripherals");
  const isEdit = !!policy?.id;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  // Ownership axis (#2131, mirrors software PolicyForm #2126): partner-scope
  // creators may own the policy partner-wide ("all orgs"). Gate on the JWT
  // scope; default to partner-wide when viewing All orgs. Create-only.
  const currentOrgId = useOrgStore((s) => s.currentOrgId);
  const { isPartnerScope, defaultOwnerScope } = useDefaultOwnerScope();
  const [ownerScope, setOwnerScope] = useState<"organization" | "partner">(
    defaultOwnerScope,
  );

  const [name, setName] = useState(policy?.name ?? "");
  const [deviceClass, setDeviceClass] = useState(
    policy?.deviceClass ?? "storage",
  );
  const [action, setAction] = useState(policy?.action ?? "block");
  const [isActive, setIsActive] = useState(policy?.isActive ?? true);
  const [exceptions, setExceptions] = useState<ExceptionRule[]>(() => {
    if (!policy?.exceptions?.length) return [];
    return policy.exceptions.map((e) => ({
      vendor: String(e.vendor ?? ""),
      product: String(e.product ?? ""),
      serialNumber: String(e.serialNumber ?? ""),
      allow: e.allow !== false,
      reason: String(e.reason ?? ""),
      expiresAt: e.expiresAt ? String(e.expiresAt) : "",
    }));
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(undefined);

    const body: Record<string, unknown> = {
      name,
      deviceClass,
      action,
      targetType: "organization",
      targetIds: {},
      isActive,
      exceptions: exceptions
        .filter((ex) => ex.vendor || ex.product || ex.serialNumber)
        .map((ex) => ({
          ...(ex.vendor ? { vendor: ex.vendor } : {}),
          ...(ex.product ? { product: ex.product } : {}),
          ...(ex.serialNumber ? { serialNumber: ex.serialNumber } : {}),
          allow: ex.allow,
          ...(ex.reason ? { reason: ex.reason } : {}),
          ...(ex.expiresAt ? { expiresAt: ex.expiresAt } : {}),
        })),
    };

    if (isEdit) {
      body.id = policy!.id;
    } else if (isPartnerScope) {
      // Create-only: updates never move a policy between ownership axes.
      body.ownerScope = ownerScope;
    }

    try {
      const response = await fetchWithAuth("/peripherals/policies", {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(
          extractApiError(data, t("peripheralPolicyForm.errors.save")),
        );
      }
      onClose(true);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("peripheralPolicyForm.errors.generic"),
      );
    } finally {
      setSaving(false);
    }
  };

  const addException = () =>
    setExceptions((prev) => [...prev, emptyException()]);

  const removeException = (idx: number) =>
    setExceptions((prev) => prev.filter((_, i) => i !== idx));

  const updateException = (
    idx: number,
    field: keyof ExceptionRule,
    value: string | boolean,
  ) =>
    setExceptions((prev) =>
      prev.map((ex, i) => (i === idx ? { ...ex, [field]: value } : ex)),
    );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-lg border bg-card shadow-xl">
        <div className="flex items-center justify-between border-b px-6 py-4">
          <h2 className="text-lg font-semibold">
            {isEdit
              ? t("peripheralPolicyForm.editTitle")
              : t("peripheralPolicyForm.createTitle")}
          </h2>
          <button
            type="button"
            onClick={() => onClose()}
            className="rounded-md p-1.5 hover:bg-muted"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 p-6">
          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          {/* Ownership scope — partner-scope creators only, create-only (#2131) */}
          {!isEdit && isPartnerScope && (
            <fieldset
              className="space-y-2 rounded-md border p-4"
              data-testid="peripheral-policy-owner"
            >
              <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">
                {t("peripheralPolicyForm.scope")}
              </legend>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  checked={ownerScope === "partner"}
                  onChange={() => setOwnerScope("partner")}
                  data-testid="peripheral-policy-owner-partner"
                />
                {t("peripheralPolicyForm.allOrganizations")}{" "}
                <span className="text-muted-foreground">
                  {t("peripheralPolicyForm.partnerWide")}
                </span>
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  checked={ownerScope === "organization"}
                  onChange={() => setOwnerScope("organization")}
                  data-testid="peripheral-policy-owner-org"
                />
                {t("peripheralPolicyForm.thisOrganization")}
              </label>
            </fieldset>
          )}

          <div>
            <label className="text-sm font-medium">
              {t("common:labels.name")}
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={200}
              className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="text-sm font-medium">
                {t("peripheralPolicyForm.deviceClass")}
              </label>
              <select
                value={deviceClass}
                onChange={(e) => setDeviceClass(e.target.value)}
                className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              >
                <option value="storage">
                  {t("peripheralPolicyForm.classes.storage")}
                </option>
                <option value="all_usb">
                  {t("peripheralPolicyForm.classes.all_usb")}
                </option>
                <option value="bluetooth">
                  {t("peripheralPolicyForm.classes.bluetooth")}
                </option>
                <option value="thunderbolt">
                  {t("peripheralPolicyForm.classes.thunderbolt")}
                </option>
              </select>
            </div>
            <div>
              <label className="text-sm font-medium">
                {t("peripheralPolicyForm.action")}
              </label>
              <select
                value={action}
                onChange={(e) => setAction(e.target.value)}
                className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              >
                <option value="allow">
                  {t("peripheralPolicyForm.actions.allow")}
                </option>
                <option value="block">
                  {t("peripheralPolicyForm.actions.block")}
                </option>
                <option value="read_only">
                  {t("peripheralPolicyForm.actions.read_only")}
                </option>
                <option value="alert">
                  {t("peripheralPolicyForm.actions.alert")}
                </option>
              </select>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <label className="text-sm font-medium">
              {t("common:states.active")}
            </label>
            <button
              type="button"
              role="switch"
              aria-checked={isActive}
              onClick={() => setIsActive(!isActive)}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition ${isActive ? "bg-primary" : "bg-muted"}`}
            >
              <span
                className={`inline-block h-4 w-4 rounded-full bg-white transition ${isActive ? "translate-x-6" : "translate-x-1"}`}
              />
            </button>
          </div>

          {/* Exceptions */}
          <div>
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">
                {t("peripheralPolicyForm.exceptions")}
              </label>
              <button
                type="button"
                onClick={addException}
                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
              >
                <Plus className="h-3 w-3" />{" "}
                {t("peripheralPolicyForm.addException")}
              </button>
            </div>
            {exceptions.length === 0 && (
              <p className="mt-1 text-xs text-muted-foreground">
                {t("peripheralPolicyForm.noExceptions")}
              </p>
            )}
            <div className="mt-2 space-y-3">
              {exceptions.map((ex, idx) => (
                <div
                  key={idx}
                  className="rounded-md border bg-muted/10 p-3 space-y-2"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-muted-foreground">
                      {t("peripheralPolicyForm.exceptionNumber", {
                        number: idx + 1,
                      })}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeException(idx)}
                      className="rounded-md p-1 text-destructive hover:bg-destructive/10"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-3">
                    <input
                      value={ex.vendor}
                      onChange={(e) =>
                        updateException(idx, "vendor", e.target.value)
                      }
                      placeholder={t("peripheralPolicyForm.vendor")}
                      className="h-8 rounded-md border bg-background px-2 text-xs focus:outline-hidden focus:ring-2 focus:ring-ring"
                    />
                    <input
                      value={ex.product}
                      onChange={(e) =>
                        updateException(idx, "product", e.target.value)
                      }
                      placeholder={t("peripheralPolicyForm.product")}
                      className="h-8 rounded-md border bg-background px-2 text-xs focus:outline-hidden focus:ring-2 focus:ring-ring"
                    />
                    <input
                      value={ex.serialNumber}
                      onChange={(e) =>
                        updateException(idx, "serialNumber", e.target.value)
                      }
                      placeholder={t("peripheralPolicyForm.serialNumber")}
                      className="h-8 rounded-md border bg-background px-2 text-xs focus:outline-hidden focus:ring-2 focus:ring-ring"
                    />
                  </div>
                  <div className="grid gap-2 sm:grid-cols-3">
                    <div className="flex items-center gap-2">
                      <label className="text-xs text-muted-foreground">
                        {t("peripheralPolicyForm.allow")}
                      </label>
                      <input
                        type="checkbox"
                        checked={ex.allow}
                        onChange={(e) =>
                          updateException(idx, "allow", e.target.checked)
                        }
                        className="rounded border"
                      />
                    </div>
                    <input
                      value={ex.reason}
                      onChange={(e) =>
                        updateException(idx, "reason", e.target.value)
                      }
                      placeholder={t("peripheralPolicyForm.reason")}
                      className="h-8 rounded-md border bg-background px-2 text-xs focus:outline-hidden focus:ring-2 focus:ring-ring"
                    />
                    <input
                      type="datetime-local"
                      value={ex.expiresAt ? ex.expiresAt.slice(0, 16) : ""}
                      onChange={(e) =>
                        updateException(
                          idx,
                          "expiresAt",
                          e.target.value
                            ? new Date(e.target.value).toISOString()
                            : "",
                        )
                      }
                      className="h-8 rounded-md border bg-background px-2 text-xs focus:outline-hidden focus:ring-2 focus:ring-ring"
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="flex justify-end gap-3 border-t pt-4">
            <button
              type="button"
              onClick={() => onClose()}
              className="h-10 rounded-md border px-4 text-sm font-medium hover:bg-muted"
            >
              {t("common:actions.cancel")}
            </button>
            <button
              type="submit"
              disabled={saving || !name.trim()}
              className="h-10 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {saving
                ? t("common:states.saving")
                : isEdit
                  ? t("peripheralPolicyForm.updatePolicy")
                  : t("peripheralPolicyForm.createPolicy")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
