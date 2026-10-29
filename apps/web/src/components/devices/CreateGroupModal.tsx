import { useEffect, useRef, useState, type FormEvent } from "react";
import type { FilterConditionGroup } from "@breeze/shared";
import { Dialog } from "../shared/Dialog";
import { FilterBuilder } from "../filters/FilterBuilder";
import { useDeviceFilterFields } from "../filters/useDeviceFilterFields";
import { fetchWithAuth } from "../../stores/auth";
import { useTranslation } from "react-i18next";
import "../../lib/i18n";
import { useDefaultOwnerScope } from '@/hooks/useDefaultOwnerScope';
import { ActionError, runAction } from '@/lib/runAction';
import { showToast } from '../shared/Toast';
import { GroupOwnerScopeField } from './GroupOwnerScopeField';
import { partnerGroupFilterFields, partnerGroupFilterHasRefusedField, usePartnerGroupCapabilities, type GroupOwnerScope } from './partnerGroups';

type GroupType = "static" | "dynamic";

interface CreateGroupModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated: (groupId: string, ownerScope: GroupOwnerScope) => void;
}

const makeEmptyFilter = (): FilterConditionGroup => ({
  operator: "AND",
  conditions: [{ field: "hostname", operator: "contains", value: "" }],
});

export default function CreateGroupModal({
  isOpen,
  onClose,
  onCreated,
}: CreateGroupModalProps) {
  const { t } = useTranslation("devices");
  const { defaultOwnerScope } = useDefaultOwnerScope();
  const { canCreatePartnerGroup } = usePartnerGroupCapabilities();
  const [ownerScope, setOwnerScope] = useState<GroupOwnerScope>(canCreatePartnerGroup ? defaultOwnerScope : 'organization');
  const wasOpen = useRef(isOpen);
  useEffect(() => {
    // The modal stays mounted on DevicesPage. Follow the ambient default while
    // closed and when opening, without replacing a choice made in the form.
    if (!isOpen || !wasOpen.current) {
      setOwnerScope(canCreatePartnerGroup ? defaultOwnerScope : 'organization');
    }
    wasOpen.current = isOpen;
  }, [isOpen, canCreatePartnerGroup, defaultOwnerScope]);
  const isPartner = canCreatePartnerGroup && ownerScope === 'partner';
  const [name, setName] = useState("");
  const [type, setType] = useState<GroupType>("static");
  const [filterConditions, setFilterConditions] =
    useState<FilterConditionGroup>(makeEmptyFilter());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Static catalog + org/partner custom fields (#8843).
  const filterFields = useDeviceFilterFields();

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    if (isPartner && partnerGroupFilterHasRefusedField(filterConditions)) {
      setError(t('errors:PARTNER_GROUP_FILTER_UNSUPPORTED'));
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const body: Record<string, unknown> = isPartner
        ? { ownerScope: 'partner', name: name.trim(), type: 'dynamic', filterConditions }
        : { name: name.trim(), type, ...(type === 'dynamic' ? { filterConditions } : {}) };
      const newGroupId = await runAction<string>({
        request: () => fetchWithAuth("/device-groups", {
          method: "POST",
          body: JSON.stringify(body),
        }),
        parseSuccess: (data) => {
          const group = data as { data?: { id?: unknown }; id?: unknown } | null;
          const id = group?.data?.id ?? group?.id;
          if (!id || typeof id !== 'string') {
            throw new Error(t('createGroupModal.missingGroupId'));
          }
          return id;
        },
        successMessage: t('createGroupModal.created'),
        errorFallback: t('createGroupModal.failedToCreateGroup'),
      });

      // Reset form
      setName("");
      setType("static");
      setOwnerScope(canCreatePartnerGroup ? defaultOwnerScope : 'organization');
      setFilterConditions(makeEmptyFilter());
      onCreated(newGroupId, isPartner ? 'partner' : 'organization');
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      const message = err instanceof Error ? err.message : t("createGroupModal.failedToCreateGroup");
      setError(message);
      if (!(err instanceof ActionError)) {
        showToast({ type: 'error', message });
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleClose = () => {
    setName("");
    setType("static");
    setOwnerScope(canCreatePartnerGroup ? defaultOwnerScope : 'organization');
    setFilterConditions(makeEmptyFilter());
    setError(null);
    onClose();
  };

  return (
    <Dialog
      open={isOpen}
      onClose={handleClose}
      title={t("createGroupModal.newDeviceGroup")}
      maxWidth="lg"
    >
      <div className="p-6">
        <h2 className="text-lg font-semibold mb-4">
          {t("createGroupModal.newDeviceGroup")}
        </h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="group-name"
              className="block text-sm font-medium mb-1"
            >
              {t("createGroupModal.name")}
            </label>
            <input
              id="group-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("createGroupModal.eGProductionServers")}
              required
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            />
          </div>

          {canCreatePartnerGroup && <GroupOwnerScopeField value={ownerScope} onChange={setOwnerScope} disabled={submitting} />}

          {!isPartner && <div>
            <label className="block text-sm font-medium mb-1">
              {t("createGroupModal.type")}
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setType("static")}
                className={`rounded-md border px-4 py-2 text-sm font-medium transition ${
                  type === "static"
                    ? "bg-primary text-primary-foreground"
                    : "bg-background hover:bg-muted"
                }`}
              >
                {t("createGroupModal.static")}{" "}
              </button>
              <button
                type="button"
                onClick={() => setType("dynamic")}
                className={`rounded-md border px-4 py-2 text-sm font-medium transition ${
                  type === "dynamic"
                    ? "bg-primary text-primary-foreground"
                    : "bg-background hover:bg-muted"
                }`}
              >
                {t("createGroupModal.dynamic")}{" "}
              </button>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {type === "static"
                ? t("createGroupModal.manuallyAddAndRemoveDevicesAfter")
                : t("createGroupModal.devicesAreAutoAssignedBasedOn")}
            </p>
          </div>}

          {(isPartner || type === "dynamic") && (
            <div>
              <label className="block text-sm font-medium mb-1">
                {t("createGroupModal.filterRules")}
              </label>
              <FilterBuilder
                value={filterConditions}
                onChange={setFilterConditions}
                filterFields={isPartner ? partnerGroupFilterFields(filterFields) : filterFields}
                showPreview={false}
              />
            </div>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={handleClose}
              className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted"
            >
              {t("createGroupModal.cancel")}{" "}
            </button>
            <button
              type="submit"
              disabled={submitting || !name.trim()}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {submitting
                ? t("createGroupModal.creating")
                : t("createGroupModal.createGroup")}
            </button>
          </div>
        </form>
      </div>
    </Dialog>
  );
}
