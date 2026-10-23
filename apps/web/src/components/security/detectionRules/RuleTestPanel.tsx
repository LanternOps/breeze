import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, Play, ServerOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { YARA_TEST_SAMPLE_MAX_BYTES, type YaraTestResult } from "@breeze/shared";
import { ActionError } from "@/lib/runAction";
import { showToast } from "../../shared/Toast";
import { testSample } from "./ruleSetsApi";

type TestError =
  | { kind: "tooLarge" }
  | { kind: "busy" }
  | { kind: "rateLimited" }
  | { kind: "unavailable" }
  | { kind: "noRules" }
  | { kind: "compileFailed"; errors: Array<{ name?: string; code?: string; message: string; line?: number }> }
  | { kind: "bodyTimeout" }
  | { kind: "unexpected" };

/**
 * Maps a failed test request to the state the panel renders inline. Each
 * status has two possible sources, so this keys on the status first and the
 * code second: a 413 is the route's YARA_TEST_TOO_LARGE or the body-limit
 * middleware (no code); a 429 is YARA_TEST_BUSY (another test is running) or
 * the per-user rate limiter (no code); any 503 other than the fail-closed
 * sandbox one is "checker unavailable"; a 408 is the body-read deadline. A 422
 * is split by code (compile failure / no enabled rules); an unknown 422 code
 * is a generic failure, never mislabelled. Returns `sandbox` for the
 * fail-closed sandbox 503, which disables the panel, and null for failures
 * runAction already toasted.
 */
export function classifyTestError(err: ActionError): TestError | "sandbox" | null {
  const body = (err.body ?? {}) as { errors?: unknown };
  switch (err.status) {
    case 413:
      return { kind: "tooLarge" };
    case 429:
      return err.code === "YARA_TEST_BUSY" ? { kind: "busy" } : { kind: "rateLimited" };
    case 503:
      return err.code === "YARA_TEST_SANDBOX_UNAVAILABLE" ? "sandbox" : { kind: "unavailable" };
    case 422:
      if (err.code === "YARA_TEST_COMPILE_FAILED") {
        const errors = Array.isArray(body.errors)
          ? (body.errors as Array<Record<string, unknown>>)
              .filter((e) => e && typeof e.message === "string")
              .map((e) => ({
                name: typeof e.name === "string" ? e.name : undefined,
                code: typeof e.code === "string" ? e.code : undefined,
                message: e.message as string,
                line: typeof e.line === "number" ? e.line : undefined,
              }))
          : [];
        return { kind: "compileFailed", errors };
      }
      return err.code === "YARA_TEST_NO_RULES" ? { kind: "noRules" } : { kind: "unexpected" };
    case 408:
      return { kind: "bodyTimeout" };
    default:
      return null;
  }
}

const ERROR_KEY: Record<TestError["kind"], string> = {
  tooLarge: "detectionRules.test.errors.tooLarge",
  busy: "detectionRules.test.errors.busy",
  rateLimited: "detectionRules.test.errors.rateLimited",
  unavailable: "detectionRules.test.errors.unavailable",
  noRules: "detectionRules.test.errors.noRules",
  compileFailed: "detectionRules.test.errors.compileFailed",
  bodyTimeout: "detectionRules.test.errors.bodyTimeout",
  unexpected: "detectionRules.test.errors.unexpected",
};

/**
 * Test one file against the set's current rules — the draft, published or not
 * (W04-2). The scan runs on the Breeze server in a sandbox; the file is not
 * stored. The request is a POST, so it goes through runAction (no success
 * toast); the statuses this panel explains inline are not toasted. Leaving the
 * panel aborts the request, and the server kills the scan on disconnect.
 */
export default function RuleTestPanel({ setId }: { setId: string }) {
  const { t } = useTranslation("security");
  const [file, setFile] = useState<File | null>(null);
  const [filepath, setFilepath] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<YaraTestResult | null>(null);
  const [error, setError] = useState<TestError | null>(null);
  const [sandboxUnavailable, setSandboxUnavailable] = useState(false);
  const inFlight = useRef<AbortController | null>(null);

  useEffect(() => () => inFlight.current?.abort(), []);

  const tooLarge = !!file && file.size > YARA_TEST_SAMPLE_MAX_BYTES;
  const canRun = !!file && !tooLarge && !running && !sandboxUnavailable;

  const run = async () => {
    if (!canRun || !file) return;
    setRunning(true);
    setError(null);
    setResult(null);
    const controller = new AbortController();
    inFlight.current = controller;
    try {
      const body = await testSample(setId, file, {
        signal: controller.signal,
        ...(filepath.trim() ? { filepath: filepath.trim() } : {}),
      });
      if (controller.signal.aborted) return;
      // A 2xx that carries no result must not leave a blank panel.
      if (!body?.data || !Array.isArray(body.data.matches)) setError({ kind: "unexpected" });
      else setResult(body.data);
    } catch (err) {
      if (controller.signal.aborted) return; // unmounted: nothing left to render into
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) {
        showToast({ type: "error", message: t("detectionRules.test.requestFailed") });
        return;
      }
      const state = classifyTestError(err);
      if (state === "sandbox") setSandboxUnavailable(true);
      else if (state) setError(state);
    } finally {
      if (!controller.signal.aborted) setRunning(false);
      if (inFlight.current === controller) inFlight.current = null;
    }
  };

  const shownError: TestError | null = tooLarge ? { kind: "tooLarge" } : error;

  return (
    <div data-testid="rule-test-panel" className="space-y-4">
      <p data-testid="rule-test-privacy" className="rounded-lg border bg-muted/30 p-4 text-sm text-muted-foreground">
        {t("detectionRules.test.privacy")}
      </p>

      {sandboxUnavailable && (
        <div
          data-testid="rule-test-disabled"
          role="alert"
          className="flex items-start gap-3 rounded-lg border bg-muted/40 px-4 py-3 text-sm"
        >
          <ServerOff className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div>
            <p className="font-medium">{t("detectionRules.test.sandboxUnavailable")}</p>
            <p className="text-xs text-muted-foreground">{t("detectionRules.test.sandboxUnavailableHelp")}</p>
          </div>
        </div>
      )}

      <fieldset disabled={sandboxUnavailable} className="grid gap-4 md:grid-cols-2">
        <label className="block text-sm">
          <span className="text-xs uppercase text-muted-foreground">{t("detectionRules.test.file")}</span>
          <input
            type="file"
            data-testid="rule-test-file"
            disabled={sandboxUnavailable}
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setError(null);
              setResult(null);
            }}
            className="mt-1 block w-full text-sm"
          />
        </label>
        <label className="block text-sm">
          <span className="text-xs uppercase text-muted-foreground">{t("detectionRules.test.filepath")}</span>
          <input
            data-testid="rule-test-filepath"
            value={filepath}
            maxLength={1024}
            disabled={sandboxUnavailable}
            onChange={(e) => setFilepath(e.target.value)}
            placeholder={String.raw`C:\Users\Public\Downloads\sample.exe`}
            className="mt-1 h-10 w-full rounded-md border bg-background px-3 font-mono text-xs"
          />
          <span className="mt-1 block text-xs text-muted-foreground">{t("detectionRules.test.filepathHelp")}</span>
        </label>
      </fieldset>

      <div className="flex justify-end">
        <button
          type="button"
          data-testid="rule-test-run"
          disabled={!canRun}
          onClick={() => void run()}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          {running ? t("detectionRules.test.running") : t("detectionRules.test.run")}
        </button>
      </div>

      {shownError && (
        <div
          data-testid="rule-test-error"
          role="alert"
          className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-800"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="space-y-1">
            <p>{t(/* i18n-dynamic */ ERROR_KEY[shownError.kind], { max: YARA_TEST_SAMPLE_MAX_BYTES / (1024 * 1024) })}</p>
            {shownError.kind === "compileFailed" && shownError.errors.length > 0 && (
              <ul className="space-y-0.5 text-xs">
                {shownError.errors.map((e, i) => (
                  <li key={i} data-testid={`rule-test-compile-error-${i}`} className="font-mono">
                    {e.name ? `${e.name}: ` : ""}
                    {e.line !== undefined ? `${t("detectionRules.editor.errorLine", { line: e.line })} ` : ""}
                    {e.code ? `${e.code}: ` : ""}
                    {e.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {result && (
        <div className="space-y-3" data-testid="rule-test-result">
          <div data-testid="rule-test-header" className="rounded-lg border bg-card px-4 py-3 text-sm">
            <p className="font-medium">
              {t("detectionRules.test.testedVersion", { version: result.testedVersion })}
            </p>
            {result.testedVersion !== result.publishedVersion && (
              <p data-testid="rule-test-unpublished" className="text-xs text-amber-700">
                {t("detectionRules.test.unpublishedChanges")}
              </p>
            )}
            <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
              {result.filename} · {result.size} B · sha256 {result.sha256} · {result.durationMs} ms
            </p>
          </div>
          {result.matches.length === 0 ? (
            <p
              data-testid="rule-test-no-matches"
              className="flex items-center gap-2 rounded-lg border bg-card px-4 py-3 text-sm text-muted-foreground"
            >
              <CheckCircle2 className="h-4 w-4" />
              {t("detectionRules.test.noMatches")}
            </p>
          ) : (
            <ul className="space-y-2">
              {result.matches.map((m) => (
                <li
                  key={`${m.ruleId}-${m.ruleName}`}
                  data-testid={`rule-test-match-${m.ruleName}`}
                  className="rounded-lg border bg-card px-4 py-3 text-sm"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono font-medium">{m.ruleName}</span>
                    <span className="rounded-full border px-2 py-0.5 text-xs">{m.severity}</span>
                    {m.tags.map((tag) => (
                      <span key={tag} className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                        {tag}
                      </span>
                    ))}
                  </div>
                  {m.matchedStrings.length > 0 && (
                    <ul className="mt-2 space-y-0.5 font-mono text-xs">
                      {m.matchedStrings.map((s, i) => (
                        <li key={i}>
                          <span className="text-muted-foreground">
                            {s.id} @ {s.offset}:{" "}
                          </span>
                          {s.data}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
