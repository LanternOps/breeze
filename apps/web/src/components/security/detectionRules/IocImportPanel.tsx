import { useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import {
  generateIocRules,
  parseIocText,
  validateIoc,
  validateIocBatch,
  YARA_IOC_KINDS,
  YARA_IOC_LABEL_MAX,
  YARA_IOC_MAX_PER_BATCH,
  YARA_IOC_MAX_TEXT_BYTES,
  YARA_RULE_SEVERITIES,
  type YaraGeneratedRule,
  type YaraIoc,
  type YaraIocErrorCode,
  type YaraIocKind,
  type YaraRuleSeverity,
} from "@breeze/shared";
import { ActionError } from "@/lib/runAction";
import { showToast } from "../../shared/Toast";
import { publishSuccessMessage } from "./publishOutcome";
import { importIocs, type ImportIocsBody } from "./ruleSetsApi";

const HASH_KINDS: ReadonlySet<YaraIocKind> = new Set(["md5", "sha1", "sha256"]);

/**
 * IOC paste importer (W04-1, set-scoped per D3). Parsing, validation and rule
 * generation are the shared `@breeze/shared` functions the import route runs,
 * and the preview renders `generateIocRules` output verbatim, so what is
 * previewed is byte-for-byte what the server saves. Only structured IOCs are
 * sent; the server re-validates and re-generates.
 */
export default function IocImportPanel({
  set,
  onImported,
}: {
  set: { id: string; enabled: boolean };
  onImported: (body: ImportIocsBody) => void;
}) {
  const { t } = useTranslation("security");
  const [text, setText] = useState("");
  const [label, setLabel] = useState("");
  const [severity, setSeverity] = useState<YaraRuleSeverity>("high");
  const [overrides, setOverrides] = useState<Record<number, YaraIocKind>>({});
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string>();
  const [serverErrors, setServerErrors] = useState<Map<number, YaraIocErrorCode>>(new Map());

  const parsed = useMemo(() => parseIocText(text), [text]);

  const rows: YaraIoc[] = useMemo(
    () => parsed.iocs.map((ioc, i) => ({ value: ioc.value, kind: overrides[i] ?? ioc.kind })),
    [parsed, overrides],
  );

  // Per-row validity (including duplicates after a kind change), by row index.
  const { rowErrors, valid, validRowIndex } = useMemo(() => {
    const checked = validateIocBatch(rows);
    const errs = new Map<number, YaraIocErrorCode>();
    if (!checked.ok) for (const e of checked.errors) errs.set(e.index, e.code);
    const ok: YaraIoc[] = [];
    const idx: number[] = [];
    rows.forEach((row, i) => {
      if (errs.has(i)) return;
      const res = validateIoc(row);
      if (res.ok) {
        ok.push(res.ioc);
        idx.push(i);
      }
    });
    return { rowErrors: errs, valid: ok, validRowIndex: idx };
  }, [rows]);

  const textTooLong = parsed.errors.some((e) => e.line === 0 && e.code === "too_long");
  const lineErrors = parsed.errors.filter((e) => e.line > 0);
  const overCap = valid.length > YARA_IOC_MAX_PER_BATCH;
  const hasHash = valid.some((ioc) => HASH_KINDS.has(ioc.kind));
  const trimmedLabel = label.trim();

  const generated = useMemo((): { rules: YaraGeneratedRule[] } | { error: true } | null => {
    if (!trimmedLabel || valid.length === 0 || overCap) return null;
    try {
      return { rules: generateIocRules({ label: trimmedLabel, iocs: valid, severity }) };
    } catch {
      return { error: true };
    }
  }, [trimmedLabel, valid, overCap, severity]);

  const canImport =
    !!trimmedLabel && valid.length > 0 && !overCap && !importing && !!generated && "rules" in generated;

  const resetDerived = () => {
    setOverrides({});
    setServerErrors(new Map());
    setImportError(undefined);
  };

  const errorText = (code: YaraIocErrorCode) => t(/* i18n-dynamic */ `detectionRules.ioc.errors.${code}`);

  const submit = async () => {
    if (!canImport) return;
    setImporting(true);
    setImportError(undefined);
    setServerErrors(new Map());
    try {
      const body = await importIocs(set.id, { label: trimmedLabel, severity, iocs: valid }, (b) =>
        publishSuccessMessage(b, set),
      );
      setText("");
      setLabel("");
      resetDerived();
      onImported(body);
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) {
        showToast({ type: "error", message: t("common:states.error") });
        return;
      }
      setImportError(err.message);
      const body = err.body as { code?: unknown; errors?: unknown } | undefined;
      if (body?.code === "IOC_INVALID" && Array.isArray(body.errors)) {
        const mapped = new Map<number, YaraIocErrorCode>();
        for (const e of body.errors as Array<{ index?: unknown; code?: unknown }>) {
          if (typeof e?.index === "number" && typeof e.code === "string" && validRowIndex[e.index] !== undefined) {
            mapped.set(validRowIndex[e.index], e.code as YaraIocErrorCode);
          }
        }
        setServerErrors(mapped);
      }
    } finally {
      setImporting(false);
    }
  };

  return (
    <div data-testid="ioc-import-panel" className="space-y-4">
      <div data-testid="ioc-help" className="rounded-lg border bg-muted/30 p-4 text-sm text-muted-foreground">
        <p className="font-medium text-foreground">{t("detectionRules.ioc.help.title")}</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">
          <li>{t("detectionRules.ioc.help.format")}</li>
          <li>{t("detectionRules.ioc.help.exactMatch")}</li>
          <li>{t("detectionRules.ioc.help.contentNotTraffic")}</li>
          <li>{t("detectionRules.ioc.help.partialOverlap")}</li>
        </ul>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <label className="block text-sm md:col-span-2">
          <span className="text-xs uppercase text-muted-foreground">{t("detectionRules.ioc.label")}</span>
          <input
            data-testid="ioc-label"
            value={label}
            maxLength={YARA_IOC_LABEL_MAX}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t("detectionRules.ioc.labelPlaceholder")}
            className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
          />
        </label>
        <label className="block text-sm">
          <span className="text-xs uppercase text-muted-foreground">{t("detectionRules.dialog.severity")}</span>
          <select
            data-testid="ioc-severity"
            value={severity}
            onChange={(e) => setSeverity(e.target.value as YaraRuleSeverity)}
            className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
          >
            {YARA_RULE_SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {t(/* i18n-dynamic */ `detectionRules.severity.${s}`)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="block text-sm">
        <span className="text-xs uppercase text-muted-foreground">{t("detectionRules.ioc.paste")}</span>
        <textarea
          data-testid="ioc-text"
          value={text}
          spellCheck={false}
          rows={8}
          onChange={(e) => {
            setText(e.target.value);
            resetDerived();
          }}
          className="mt-1 w-full rounded-md border bg-background p-3 font-mono text-xs"
        />
      </label>
      {textTooLong && (
        <p data-testid="ioc-text-too-long" role="alert" className="text-sm text-destructive">
          {t("detectionRules.ioc.textTooLong", { max: YARA_IOC_MAX_TEXT_BYTES / 1024 })}
        </p>
      )}

      {lineErrors.length > 0 && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3">
          <p className="text-xs font-medium text-destructive">{t("detectionRules.ioc.skippedLines")}</p>
          <ul className="mt-1 space-y-0.5 text-xs">
            {lineErrors.map((e, i) => (
              <li key={i} data-testid={`ioc-parse-error-${i}`}>
                {t("detectionRules.ioc.lineError", { line: e.line, error: errorText(e.code) })}{" "}
                <span className="font-mono text-muted-foreground">{e.value}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {rows.length > 0 && (
        <div className="space-y-2">
          <p data-testid="ioc-valid-count" className="text-sm font-medium">
            {t("detectionRules.ioc.validCount", { valid: valid.length, total: rows.length })}
          </p>
          <div className="max-h-80 overflow-auto rounded-lg border">
            <table className="w-full text-sm" data-testid="ioc-preview-list">
              <thead className="sticky top-0 bg-muted text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">{t("detectionRules.ioc.kind")}</th>
                  <th className="px-3 py-2 font-medium">{t("detectionRules.ioc.value")}</th>
                  <th className="px-3 py-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row, n) => {
                  const code = serverErrors.get(n) ?? rowErrors.get(n);
                  return (
                    <tr key={n} data-testid={`ioc-preview-row-${n}`} className="border-t">
                      <td className="px-3 py-1.5">
                        <select
                          data-testid={`ioc-kind-${n}`}
                          aria-label={t("detectionRules.ioc.kind")}
                          value={row.kind}
                          onChange={(e) => {
                            const kind = e.target.value as YaraIocKind;
                            setOverrides((prev) => ({ ...prev, [n]: kind }));
                            setServerErrors(new Map());
                          }}
                          className="h-8 rounded-md border bg-background px-2 text-xs"
                        >
                          {YARA_IOC_KINDS.map((k) => (
                            <option key={k} value={k}>
                              {t(/* i18n-dynamic */ `detectionRules.ioc.kinds.${k}`)}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="break-all px-3 py-1.5 font-mono text-xs">{row.value}</td>
                      <td className="px-3 py-1.5 text-xs">
                        {code && (
                          <span data-testid={`ioc-error-${n}`} className="text-destructive">
                            {errorText(code)}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {overCap && (
        <p data-testid="ioc-cap-error" role="alert" className="text-sm text-destructive">
          {t("detectionRules.ioc.overCap", { max: YARA_IOC_MAX_PER_BATCH })}
        </p>
      )}
      {hasHash && (
        <p data-testid="ioc-hash-note" className="text-xs text-muted-foreground">
          {t("detectionRules.ioc.hashNote")}
        </p>
      )}

      {valid.length > 0 && !overCap && !trimmedLabel && (
        <p className="text-xs text-muted-foreground">{t("detectionRules.ioc.labelRequired")}</p>
      )}
      {generated && "error" in generated && (
        <p data-testid="ioc-generate-error" role="alert" className="text-sm text-destructive">
          {t("detectionRules.ioc.generateFailed")}
        </p>
      )}
      {generated && "rules" in generated && (
        <div className="space-y-2">
          <p className="text-sm font-medium">{t("detectionRules.ioc.generatedTitle", { total: generated.rules.length })}</p>
          {generated.rules.map((rule, n) => (
            <details key={rule.name} className="rounded-lg border bg-card" open={n === 0}>
              <summary className="cursor-pointer px-3 py-2 font-mono text-xs">
                {rule.name} · {t(/* i18n-dynamic */ `detectionRules.ioc.kinds.${rule.kind}`)} · {rule.iocCount}
              </summary>
              <pre
                data-testid={`ioc-generated-rule-${n}`}
                className="max-h-72 overflow-auto whitespace-pre border-t bg-background p-3 font-mono text-xs"
              >{rule.source}</pre>
            </details>
          ))}
        </div>
      )}

      {importError && (
        <p data-testid="ioc-import-error" role="alert" className="text-sm text-destructive">
          {importError}
        </p>
      )}

      <div className="flex justify-end">
        <button
          type="button"
          data-testid="ioc-import-submit"
          disabled={!canImport}
          onClick={() => void submit()}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {importing && <Loader2 className="h-4 w-4 animate-spin" />}
          {t("detectionRules.ioc.import", { total: valid.length })}
        </button>
      </div>
    </div>
  );
}
