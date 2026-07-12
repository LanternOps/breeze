import { useCallback, useEffect, useState } from "react";
import { ShieldCheck, Layers } from "lucide-react";
import { fetchWithAuth } from "../../stores/auth";
import { friendlyFetchError } from "../../lib/utils";
import { useTranslation } from "react-i18next";
import { i18n } from "@/lib/i18n";
type BaselineFeature = {
  featureType: string;
  label: string;
  applied: boolean;
  inlineSettings: Record<string, unknown> | null;
  behavior: string;
};
function summarize(settings: Record<string, unknown> | null): string[] {
  if (!settings) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(settings)) {
    if (v === null || v === undefined) continue;
    const label = k
      .replace(/_/g, " ")
      .replace(/([A-Z])/g, " $1")
      .trim()
      .toLowerCase();
    if (typeof v === "boolean") out.push(`${label}: ${v ? "on" : "off"}`);
    else if (typeof v === "string" || typeof v === "number")
      out.push(`${label}: ${v}`);
    else if (Array.isArray(v))
      out.push(`${label}: ${v.length} item${v.length !== 1 ? "s" : ""}`);
    if (out.length >= 6) break;
  }
  return out;
}
export default function BreezeDefaultsPage() {
  useTranslation("policies");
  useTranslation("policies");
  const [features, setFeatures] = useState<BaselineFeature[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const res = await fetchWithAuth("/configuration-policies/baseline");
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const data = await res.json();
      // Surface a malformed 200 (missing/non-array features) as an error rather
      // than silently rendering an empty page — this endpoint always returns a
      // populated array, so a non-array means schema drift or a broken response.
      if (!Array.isArray(data.features)) {
        throw new Error(
          i18n.t(
            "policies:configurationPolicies.breezeDefaultsPage.receivedAnInvalidResponseFromTheServer",
          ),
        );
      }
      setFeatures(data.features);
    } catch (err) {
      setError(friendlyFetchError(err));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  if (loading) {
    return (
      <div className="flex items-center justify-center rounded-lg border bg-card py-12 shadow-xs">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={load}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          {i18n.t("common:actions.retry")}
        </button>
      </div>
    );
  }
  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Layers className="h-5 w-5" />
        </div>
        <div>
          <h2 className="text-lg font-semibold">
            {i18n.t(
              "policies:configurationPolicies.breezeDefaultsPage.breezeDefaults",
            )}
          </h2>
          <p className="text-sm text-muted-foreground">
            {i18n.t(
              "policies:configurationPolicies.breezeDefaultsPage.howDevicesBehaveOutOfTheBox",
            )}
          </p>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {features.map((f) => {
          const settings = summarize(f.inlineSettings);
          return (
            <div
              key={f.featureType}
              className="rounded-lg border bg-card p-5 shadow-xs"
            >
              <div className="flex items-start justify-between gap-2">
                <h4 className="font-semibold">{f.label}</h4>
                <span
                  className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${f.applied ? "bg-primary/10 text-primary" : "bg-muted/50 text-muted-foreground"}`}
                >
                  {f.applied ? <ShieldCheck className="h-3 w-3" /> : null}
                  {f.applied
                    ? i18n.t(
                        "policies:configurationPolicies.breezeDefaultsPage.activeDefault",
                      )
                    : i18n.t(
                        "policies:configurationPolicies.breezeDefaultsPage.notEnforced",
                      )}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{f.behavior}</p>
              {settings.length > 0 && (
                <ul className="mt-3 space-y-0.5 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                  {settings.map((s) => (
                    <li key={s} className="capitalize">
                      {s}
                    </li>
                  ))}
                </ul>
              )}
              <a
                href={`/configuration-policies/new?feature=${encodeURIComponent(f.featureType)}`}
                className="mt-3 inline-block text-xs font-medium text-primary hover:underline"
              >
                {i18n.t(
                  "policies:configurationPolicies.breezeDefaultsPage.createOverridePolicy",
                )}
              </a>
            </div>
          );
        })}
      </div>
    </div>
  );
}
