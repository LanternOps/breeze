import { useCallback, useEffect, useState } from "react";
import { Save } from "lucide-react";
import { fetchWithAuth } from "../../stores/auth";
import { extractApiError } from "@/lib/apiError";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";

type MappingRow = {
  id: string;
  breezeField: string;
  required: boolean;
  psaField: string;
  defaultValue: string;
  options: string[];
};

const defaultMappings: MappingRow[] = [
  {
    id: "map-1",
    breezeField: "Account name",
    required: true,
    psaField: "Company",
    defaultValue: "",
    options: ["Company", "Organization", "Account"],
  },
  {
    id: "map-2",
    breezeField: "Ticket summary",
    required: true,
    psaField: "Subject",
    defaultValue: "",
    options: ["Subject", "Summary", "Title"],
  },
  {
    id: "map-3",
    breezeField: "Priority",
    required: true,
    psaField: "Priority",
    defaultValue: "P3",
    options: ["Priority", "Urgency", "Severity"],
  },
  {
    id: "map-4",
    breezeField: "Assigned team",
    required: false,
    psaField: "Service board",
    defaultValue: "NOC",
    options: ["Service board", "Queue", "Team"],
  },
  {
    id: "map-5",
    breezeField: "Asset type",
    required: false,
    psaField: "Configuration type",
    defaultValue: "Endpoint",
    options: ["Configuration type", "Asset class", "Device type"],
  },
];

export default function PSAMappingEditor() {
  const { t } = useTranslation("integrations");
  const [mappings, setMappings] = useState<MappingRow[]>(defaultMappings);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState<string>();

  const fetchMappings = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const response = await fetchWithAuth("/psa/mappings");
      if (response.status === 404) {
        // No mappings saved yet, use defaults
        return;
      }
      if (!response.ok) {
        const errData = await response.json().catch(() => null);
        throw new Error(
          extractApiError(
            errData,
            t("psaMappingEditor.failedToLoadPSAMappings"),
          ),
        );
      }
      const data = await response.json();
      const savedMappings = data.mappings ?? data.data ?? data ?? [];
      if (Array.isArray(savedMappings) && savedMappings.length > 0) {
        setMappings(savedMappings);
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("psaMappingEditor.failedToLoadPSAMappings"),
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMappings();
  }, [fetchMappings]);

  const updateMapping = (
    id: string,
    field: "psaField" | "defaultValue",
    value: string,
  ) => {
    setMappings((prev) =>
      prev.map((row) => (row.id === id ? { ...row, [field]: value } : row)),
    );
    setSuccess(undefined);
  };

  const handleSave = async () => {
    setSaving(true);
    setError(undefined);
    setSuccess(undefined);

    try {
      const response = await fetchWithAuth("/psa/mappings", {
        method: "PUT",
        body: JSON.stringify({ mappings }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(
          extractApiError(data, t("psaMappingEditor.failedToSavePSAMappings")),
        );
      }

      setSuccess("PSA mappings saved successfully.");
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("psaMappingEditor.failedToSavePSAMappings"),
      );
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-4 text-sm text-muted-foreground">
            {t("psaMappingEditor.loadingPSAMappings")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border bg-card p-6 shadow-xs">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">
            {t("psaMappingEditor.psaFieldMapping")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t("psaMappingEditor.alignBreezeFieldsWithPSAFieldsForConsistent")}
          </p>
        </div>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Save className="h-4 w-4" />
          {saving
            ? t("psaMappingEditor.saving")
            : t("psaMappingEditor.saveMapping")}
        </button>
      </div>

      {error && (
        <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {success && (
        <div className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {success}
        </div>
      )}

      <div className="mt-6 grid gap-4 lg:grid-cols-[1fr_1fr]">
        <div className="rounded-lg border bg-muted/30 px-4 py-3 text-sm font-semibold text-muted-foreground">
          {t("psaMappingEditor.breezeFields")}
        </div>
        <div className="rounded-lg border bg-muted/30 px-4 py-3 text-sm font-semibold text-muted-foreground">
          {t("psaMappingEditor.psaFields")}
        </div>
      </div>

      <div className="mt-4 space-y-3">
        {mappings.map((row) => (
          <div
            key={row.id}
            className="grid gap-4 rounded-lg border bg-background p-4 lg:grid-cols-[1fr_1fr]"
          >
            <div>
              <div className="flex items-center gap-2">
                <p className="text-sm font-medium">{row.breezeField}</p>
                {row.required && (
                  <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 chart-legend-xs text-amber-700">
                    {t("common:labels.required")}
                  </span>
                )}
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                {t("psaMappingEditor.chooseHowThisMapsInYourPSA")}
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="text-xs font-medium text-muted-foreground">
                  {t("psaMappingEditor.psaField")}
                </label>
                <select
                  value={row.psaField}
                  onChange={(event) =>
                    updateMapping(row.id, "psaField", event.target.value)
                  }
                  className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                >
                  {row.options.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">
                  {t("psaMappingEditor.defaultValue")}
                </label>
                <input
                  type="text"
                  value={row.defaultValue}
                  onChange={(event) =>
                    updateMapping(row.id, "defaultValue", event.target.value)
                  }
                  className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
