import { useState, useEffect } from "react";
import { Loader2, X } from "lucide-react";
import { fetchWithAuth } from "../../../stores/auth";
import { useTranslation } from "react-i18next";
import { i18n } from "@/lib/i18n";
type PolicyOption = {
  id: string;
  name: string;
};
type PolicyLinkSelectorProps = {
  fetchUrl: string;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onPolicyNameResolved?: (name: string) => void;
  /** Filter out this ID from the options (e.g. to exclude the current policy) */
  excludeId?: string;
};
export default function PolicyLinkSelector({
  fetchUrl,
  selectedId,
  onSelect,
  onPolicyNameResolved,
  excludeId,
}: PolicyLinkSelectorProps) {
  useTranslation("policies");
  const [options, setOptions] = useState<PolicyOption[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const response = await fetchWithAuth(fetchUrl);
        if (!response.ok)
          throw new Error(
            i18n.t(
              "policies:configurationPolicies.featureTabs.policyLinkSelector.failedToFetchPolicies",
            ),
          );
        const json = await response.json();
        const list = Array.isArray(json.data)
          ? json.data
          : Array.isArray(json)
            ? json
            : [];
        const mapped: PolicyOption[] = list.map((p: any) => ({
          id: p.id,
          name: p.name,
        }));
        if (!cancelled)
          setOptions(
            excludeId ? mapped.filter((o) => o.id !== excludeId) : mapped,
          );
      } catch {
        if (!cancelled) setOptions([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [fetchUrl]);
  useEffect(() => {
    if (selectedId && onPolicyNameResolved && options.length > 0) {
      const match = options.find((o) => o.id === selectedId);
      if (match) onPolicyNameResolved(match.name);
    }
  }, [selectedId, options, onPolicyNameResolved]);
  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {i18n.t(
          "policies:configurationPolicies.featureTabs.policyLinkSelector.loadingPolicies",
        )}
      </div>
    );
  }
  if (options.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {i18n.t(
          "policies:configurationPolicies.featureTabs.policyLinkSelector.noExistingPoliciesFound",
        )}
      </p>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <select
        value={selectedId ?? ""}
        onChange={(e) => onSelect(e.target.value || null)}
        className="h-10 flex-1 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
      >
        <option value="">
          {i18n.t(
            "policies:configurationPolicies.featureTabs.policyLinkSelector.selectAPolicy",
          )}
        </option>
        {options.map((opt) => (
          <option key={opt.id} value={opt.id}>
            {opt.name}
          </option>
        ))}
      </select>
      {selectedId && (
        <button
          type="button"
          onClick={() => onSelect(null)}
          className="inline-flex h-10 w-10 items-center justify-center rounded-md border text-muted-foreground hover:bg-muted"
          title={i18n.t(
            "policies:configurationPolicies.featureTabs.policyLinkSelector.clearSelection",
          )}
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
