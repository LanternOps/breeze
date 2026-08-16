import { useEffect, useId, useState } from "react";
import { CheckCircle2, ChevronDown, Loader2, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { fetchWithAuth } from "../../stores/auth";
import { i18n } from "@/lib/i18n";
import {
  KINDS_BY_PLATFORM,
  platformForKind,
  validatePackageIdForKind,
  type InstallMethodKind,
  type PackageIdError,
  type PackagePlatform,
} from "@/lib/packageIdValidation";

export interface SelectedPackageMethod {
  platform: PackagePlatform;
  kind: InstallMethodKind;
  packageId: string;
  name?: string;
  vendor?: string;
  homepageUrl?: string;
  breezeTested?: { version: string; testedAt: string };
}

interface PackageManagerPickerProps {
  methods: SelectedPackageMethod[];
  onChange: (methods: SelectedPackageMethod[]) => void;
}

interface SearchResult extends SelectedPackageMethod {
  latestVersion?: string;
  description?: string;
}

/** Keystroke-to-request delay. Long enough that typing a package name is one
 *  request, short enough that the results feel live. */
const DEBOUNCE_MS = 300;
const MIN_QUERY = 2;

const KIND_LABEL_KEYS: Record<InstallMethodKind, string> = {
  winget: "policies:software.addPackageModal.kindWinget",
  homebrew_cask: "policies:software.addPackageModal.kindHomebrewCask",
  homebrew_formula: "policies:software.addPackageModal.kindHomebrewFormula",
};

const PACKAGE_ID_ERROR_KEYS: Record<PackageIdError, string> = {
  empty: "policies:software.addPackageModal.errorPackageIdEmpty",
  too_long: "policies:software.addPackageModal.errorPackageIdTooLong",
  invalid_winget: "policies:software.addPackageModal.errorInvalidWinget",
  invalid_brew: "policies:software.addPackageModal.errorInvalidBrew",
};

/**
 * Search + manual entry for winget / Homebrew install methods.
 *
 * All fetching here is read-only, so it uses plain `fetchWithAuth` with local
 * error state rather than `runAction` — nothing is mutated until the parent
 * modal submits.
 */
export default function PackageManagerPicker({
  methods,
  onChange,
}: PackageManagerPickerProps) {
  const [platform, setPlatform] = useState<PackagePlatform>("windows");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [degraded, setDegraded] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualKind, setManualKind] = useState<InstallMethodKind>("winget");
  const [manualPackageId, setManualPackageId] = useState("");
  const [manualError, setManualError] = useState<PackageIdError | null>(null);
  const searchId = useId();
  const kindId = useId();
  const packageIdId = useId();

  // Switching the platform tab retargets both the search and the manual-entry
  // kind, so a Windows tab can never offer a Homebrew kind (the API rejects an
  // incoherent platform+kind pair with a 400).
  const selectPlatform = (next: PackagePlatform) => {
    setPlatform(next);
    setManualKind(KINDS_BY_PLATFORM[next][0]!);
    setManualError(null);
  };

  useEffect(() => {
    const q = query.trim();
    if (q.length < MIN_QUERY) {
      setResults([]);
      setDegraded(false);
      setSearchError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const res = await fetchWithAuth(
            `/software/package-search?platform=${platform}&q=${encodeURIComponent(q)}`,
          );
          if (cancelled) return;
          if (!res.ok) {
            setResults([]);
            setDegraded(false);
            setSearchError(
              i18n.t("policies:software.addPackageModal.searchFailed"),
            );
            return;
          }
          const body = (await res.json()) as {
            results?: SearchResult[];
            degraded?: boolean;
          } | null;
          if (cancelled) return;
          setResults(Array.isArray(body?.results) ? body!.results! : []);
          setDegraded(body?.degraded === true);
          setSearchError(null);
        } catch {
          if (!cancelled) {
            setResults([]);
            setSearchError(
              i18n.t("policies:software.addPackageModal.searchFailed"),
            );
          }
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, platform]);

  /** A catalog item may carry at most ONE method per platform+kind (unique in
   *  the DB, 400 from the import endpoint), so adding replaces rather than
   *  appends when that pair is already selected. */
  const addMethod = (method: SelectedPackageMethod) => {
    onChange([
      ...methods.filter(
        (m) => !(m.platform === method.platform && m.kind === method.kind),
      ),
      method,
    ]);
  };

  const removeMethod = (method: SelectedPackageMethod) => {
    onChange(
      methods.filter(
        (m) => !(m.platform === method.platform && m.kind === method.kind),
      ),
    );
  };

  const submitManual = () => {
    const packageId = manualPackageId.trim();
    const err = validatePackageIdForKind(manualKind, packageId);
    setManualError(err);
    if (err) return;
    addMethod({ platform: platformForKind(manualKind), kind: manualKind, packageId });
    setManualPackageId("");
  };

  const labelCls = "text-xs font-semibold uppercase text-muted-foreground";
  const inputCls =
    "h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring";

  return (
    <div className="space-y-4" data-testid="package-manager-picker">
      <p className="text-xs text-muted-foreground">
        {i18n.t("policies:software.addPackageModal.packageManagerIntro")}
      </p>

      <div
        className="inline-flex rounded-md border bg-muted/40 p-0.5"
        role="tablist"
        aria-label={i18n.t("policies:software.addPackageModal.packagePlatform")}
      >
        {(
          [
            ["windows", i18n.t("policies:software.addPackageModal.windows")],
            ["macos", i18n.t("policies:software.addPackageModal.macos")],
          ] as const
        ).map(([val, label]) => (
          <button
            key={val}
            type="button"
            role="tab"
            aria-selected={platform === val}
            onClick={() => selectPlatform(val)}
            className={cn(
              "rounded px-3 py-1.5 text-sm font-medium transition-colors",
              platform === val
                ? "bg-background text-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <div>
        <label className={labelCls} htmlFor={searchId}>
          {i18n.t("policies:software.addPackageModal.searchPackages")}
        </label>
        <div className="relative mt-2">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            id={searchId}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={i18n.t(
              "policies:software.addPackageModal.searchPlaceholder",
            )}
            className={cn(inputCls, "pl-9")}
          />
          {loading && (
            <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
          )}
        </div>

        {searchError && (
          <p className="mt-2 text-xs text-destructive">{searchError}</p>
        )}
        {degraded && (
          <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
            {i18n.t("policies:software.addPackageModal.searchDegraded")}
          </p>
        )}

        {results.length > 0 && (
          <ul className="mt-2 max-h-56 divide-y overflow-y-auto rounded-md border">
            {results.map((r) => (
              <li key={`${r.platform}:${r.kind}:${r.packageId}`}>
                <button
                  type="button"
                  onClick={() =>
                    addMethod({
                      platform: r.platform,
                      kind: r.kind,
                      packageId: r.packageId,
                      name: r.name,
                      vendor: r.vendor,
                      homepageUrl: r.homepageUrl,
                      breezeTested: r.breezeTested,
                    })
                  }
                  className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left hover:bg-muted"
                >
                  <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {r.name || r.packageId}
                    {r.breezeTested && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 dark:text-emerald-400">
                        <CheckCircle2 className="h-3 w-3" />
                        {i18n.t(
                          "policies:software.addPackageModal.breezeTested",
                          { version: r.breezeTested.version },
                        )}
                      </span>
                    )}
                  </span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {r.packageId}
                  </span>
                  {(r.vendor || r.latestVersion) && (
                    <span className="text-xs text-muted-foreground">
                      {[r.vendor, r.latestVersion].filter(Boolean).join(" · ")}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
        {!loading &&
          !searchError &&
          !degraded &&
          results.length === 0 &&
          query.trim().length >= MIN_QUERY && (
            <p className="mt-2 text-xs text-muted-foreground">
              {i18n.t("policies:software.addPackageModal.noPackagesMatched")}
            </p>
          )}
      </div>

      <div>
        <span className={labelCls}>
          {i18n.t("policies:software.addPackageModal.selectedPackages")}
        </span>
        {methods.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            {i18n.t("policies:software.addPackageModal.noPackagesSelected")}
          </p>
        ) : (
          <ul className="mt-2 flex flex-wrap gap-2">
            {methods.map((m) => (
              <li
                key={`${m.platform}:${m.kind}`}
                className="inline-flex items-center gap-2 rounded-full border bg-muted/40 px-3 py-1 text-xs"
              >
                <span className="font-semibold">
                  {i18n.t(KIND_LABEL_KEYS[m.kind])}
                </span>
                <span className="font-mono">{m.packageId}</span>
                <button
                  type="button"
                  onClick={() => removeMethod(m)}
                  aria-label={i18n.t(
                    "policies:software.addPackageModal.removePackage",
                    { packageId: m.packageId },
                  )}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="border-t pt-3">
        <button
          type="button"
          onClick={() => setManualOpen((o) => !o)}
          aria-expanded={manualOpen}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
        >
          <ChevronDown
            className={cn(
              "h-4 w-4 transition-transform",
              manualOpen && "rotate-180",
            )}
          />
          {i18n.t("policies:software.addPackageModal.manualEntry")}
        </button>

        {manualOpen && (
          <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,12rem)_1fr_auto] sm:items-end">
            <div>
              <label className={labelCls} htmlFor={kindId}>
                {i18n.t("policies:software.addPackageModal.packageType")}
              </label>
              <select
                id={kindId}
                value={manualKind}
                onChange={(e) => {
                  setManualKind(e.target.value as InstallMethodKind);
                  setManualError(null);
                }}
                className={cn(inputCls, "mt-2")}
              >
                {KINDS_BY_PLATFORM[platform].map((k) => (
                  <option key={k} value={k}>
                    {i18n.t(KIND_LABEL_KEYS[k])}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls} htmlFor={packageIdId}>
                {i18n.t("policies:software.addPackageModal.packageId")}
              </label>
              <input
                id={packageIdId}
                type="text"
                value={manualPackageId}
                onChange={(e) => {
                  setManualPackageId(e.target.value);
                  setManualError(null);
                }}
                placeholder={i18n.t(
                  "policies:software.addPackageModal.packageIdPlaceholder",
                )}
                className={cn(inputCls, "mt-2 font-mono")}
              />
            </div>
            <button
              type="button"
              onClick={submitManual}
              className="inline-flex h-10 items-center justify-center rounded-md border bg-background px-4 text-sm font-medium hover:bg-muted"
            >
              {i18n.t("policies:software.addPackageModal.addPackage")}
            </button>
            {manualError && (
              <p className="text-xs text-destructive sm:col-span-3">
                {i18n.t(PACKAGE_ID_ERROR_KEYS[manualError])}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
