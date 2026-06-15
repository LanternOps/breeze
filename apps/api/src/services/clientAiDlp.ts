/**
 * Client AI DLP / redaction pipeline (spec §6) — the single chokepoint for
 * every payload leaving Breeze for the model provider: user prompts, workbook
 * tool_result cell matrices, and template content. The call sites live in the
 * Plan-2 session loop; this module owns only the scanning.
 *
 * Order of operations: size guard → scan all enabled rules → block (any
 * block-rule match refuses the whole payload, no partial results) → redact
 * ([REDACTED:<rule>] in place) → log (events only).
 *
 * Config handling: dlpConfig arrives as unknown (jsonb via getOrgPolicy).
 * Invalid configs degrade to DEFAULT_DLP_CONFIG — financial/credential
 * redaction stays ON, never "everything off". Note this also drops the custom
 * rules of an invalid config; acceptable because the policy PUT path
 * validates with the same schema, so invalid rows only arise from
 * out-of-band DB writes.
 *
 * Fail-closed guards: oversize payloads (cells/chars caps) and scan-budget
 * exhaustion BLOCK rather than pass unscanned content — passing unscanned
 * data would defeat the chokepoint. Plan 2's read tools chunk well below the
 * caps, so tripping one is a tool-layer bug that should surface loudly.
 *
 * Pure computation: no DB, no Redis, no db-access-context requirements.
 */

import {
  DEFAULT_DLP_CONFIG,
  dlpConfigSchema,
  type DlpConfig,
  type DlpRuleAction,
} from '@breeze/shared/validators';
import {
  detectApiKey,
  detectCreditCard,
  detectEmail,
  detectIban,
  detectPhone,
  detectSsn,
  ssnContextPresent,
  type DlpMatch,
} from './clientAiDlpDetectors';

export interface DlpRedactionEvent {
  rule: string;
  count: number;
  location: string;
}

export interface DlpResult {
  action: 'allow' | 'block';
  text?: string;
  cells?: unknown[][];
  redactions: DlpRedactionEvent[];
  blockReason?: string;
}

/** Hard cap on scanned cells per call. Exceeding it BLOCKS (fail closed). */
export const DLP_MAX_CELLS = 50_000;
/** Excel's own cell limit is 32,767 chars; anything bigger is not workbook data. */
export const DLP_MAX_CELL_CHARS = 32_768;
/** Hard cap on total scanned characters per call (text + stringified cells). */
export const DLP_MAX_TOTAL_CHARS = 2_000_000;
/** Wall-clock budget for one applyDlp call; exceeding it BLOCKS (fail closed). */
export const DLP_SCAN_BUDGET_MS = 2_000;

const BUILTIN_ORDER = ['creditCard', 'ssn', 'iban', 'apiKey', 'email', 'phone'] as const;

interface CompiledRule {
  name: string;
  action: DlpRuleAction;
  detect: (text: string) => DlpMatch[];
}

interface ScanLocation {
  label: string;
  content: string;
  /** [row, col] for cells; null for the text input. */
  coords: [number, number] | null;
}

function block(reason: string, redactions: DlpRedactionEvent[] = []): DlpResult {
  return { action: 'block', blockReason: reason, redactions };
}

function stringifyCell(cell: unknown): string | null {
  if (cell === null || cell === undefined) return null;
  if (typeof cell === 'string') return cell === '' ? null : cell;
  if (typeof cell === 'number' || typeof cell === 'boolean' || typeof cell === 'bigint') {
    return String(cell);
  }
  try {
    return JSON.stringify(cell) ?? null;
  } catch {
    // Circular / non-serializable — nothing scannable, and the SSE layer
    // cannot forward it to the provider as JSON either. Leave untouched.
    return null;
  }
}

/** Compile the enabled rule list, or return a block reason (fail closed). */
function compileRules(config: DlpConfig, ssnActive: boolean): CompiledRule[] | string {
  const builtinDetectors: Record<(typeof BUILTIN_ORDER)[number], (text: string) => DlpMatch[]> = {
    creditCard: detectCreditCard,
    ssn: (text) => detectSsn(text, ssnActive),
    iban: detectIban,
    apiKey: detectApiKey,
    email: detectEmail,
    phone: detectPhone,
  };

  const rules: CompiledRule[] = [];
  for (const name of BUILTIN_ORDER) {
    const setting = config.builtins[name];
    if (setting === 'off') continue;
    rules.push({ name, action: setting, detect: builtinDetectors[name] });
  }

  for (const custom of config.customRules) {
    let re: RegExp;
    try {
      re = new RegExp(custom.pattern, 'gu');
    } catch {
      // The shared schema compiles every pattern at save time, so this is
      // only reachable for out-of-band DB writes. Fail CLOSED: silently
      // skipping a rule the MSP believes is active would disable DLP
      // without anyone noticing.
      return `dlp_rule_compile_failed:${custom.name}`;
    }
    rules.push({
      name: custom.name,
      action: custom.action,
      detect: (text: string) => {
        const out: DlpMatch[] = [];
        for (const m of text.matchAll(re)) {
          if (m[0].length === 0) break; // zero-width match safety
          out.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
        }
        return out;
      },
    });
  }
  return rules;
}

/** Replace spans right-to-left; overlapping spans merge, earliest span's rule labels the token. */
function replaceSpans(content: string, spans: Array<{ span: DlpMatch; rule: string }>): string {
  const sorted = [...spans].sort(
    (a, b) => a.span.start - b.span.start || a.span.end - b.span.end,
  );
  const merged: Array<{ start: number; end: number; rule: string }> = [];
  for (const { span, rule } of sorted) {
    const last = merged[merged.length - 1];
    if (last && span.start < last.end) {
      last.end = Math.max(last.end, span.end);
    } else {
      merged.push({ start: span.start, end: span.end, rule });
    }
  }
  let out = content;
  for (let i = merged.length - 1; i >= 0; i--) {
    const m = merged[i];
    if (!m) continue;
    out = `${out.slice(0, m.start)}[REDACTED:${m.rule}]${out.slice(m.end)}`;
  }
  return out;
}

export async function applyDlp(input: {
  text?: string;
  cells?: unknown[][];
  dlpConfig: unknown;
  orgId: string;
}): Promise<DlpResult> {
  const started = Date.now();

  const parsedConfig = dlpConfigSchema.safeParse(input.dlpConfig ?? {});
  const config: DlpConfig = parsedConfig.success ? parsedConfig.data : DEFAULT_DLP_CONFIG;

  // ── Bound + collect scan locations (fail closed on oversize) ──────────────
  const locations: ScanLocation[] = [];
  let totalChars = 0;

  if (typeof input.text === 'string') {
    totalChars += input.text.length;
    if (totalChars > DLP_MAX_TOTAL_CHARS) return block('payload_too_large_for_dlp');
    locations.push({ label: 'text', content: input.text, coords: null });
  }

  if (input.cells !== undefined) {
    let cellCount = 0;
    for (let r = 0; r < input.cells.length; r++) {
      const row = input.cells[r] ?? [];
      for (let c = 0; c < row.length; c++) {
        cellCount += 1;
        if (cellCount > DLP_MAX_CELLS) return block('payload_too_large_for_dlp');
        const content = stringifyCell(row[c]);
        if (content === null) continue;
        if (content.length > DLP_MAX_CELL_CHARS) return block('payload_too_large_for_dlp');
        totalChars += content.length;
        if (totalChars > DLP_MAX_TOTAL_CHARS) return block('payload_too_large_for_dlp');
        locations.push({ label: `cell[${r}][${c}]`, content, coords: [r, c] });
      }
    }
  }

  // Bare-9-digit SSN matching activates when an SSN keyword appears ANYWHERE
  // in the payload (covers "SSN" header cells above bare-number columns).
  const ssnActive = locations.some((l) => ssnContextPresent(l.content));

  const compiled = compileRules(config, ssnActive);
  if (typeof compiled === 'string') return block(compiled);

  // ── Scan every location with every enabled rule ────────────────────────────
  interface LocationMatches {
    rule: CompiledRule;
    spans: DlpMatch[];
  }
  const perLocation: LocationMatches[][] = locations.map(() => []);
  const perRule = new Map<string, { count: number; locations: string[] }>();
  let blockedBy: string | null = null;

  for (const rule of compiled) {
    for (let i = 0; i < locations.length; i++) {
      if (Date.now() - started > DLP_SCAN_BUDGET_MS) return block('dlp_scan_budget_exceeded');
      const location = locations[i];
      const bucket = perLocation[i];
      if (location === undefined || bucket === undefined) continue;
      const spans = rule.detect(location.content);
      if (spans.length === 0) continue;
      bucket.push({ rule, spans });
      const agg = perRule.get(rule.name) ?? { count: 0, locations: [] };
      agg.count += spans.length;
      agg.locations.push(location.label);
      perRule.set(rule.name, agg);
      if (rule.action === 'block' && blockedBy === null) blockedBy = rule.name;
    }
  }

  // Per-rule aggregated, value-free events (≤ 6 builtins + 50 custom rules).
  const redactions: DlpRedactionEvent[] = [];
  for (const [rule, agg] of perRule) {
    const first = agg.locations[0] ?? '';
    const location =
      agg.locations.length === 1 ? first : `${first} (+${agg.locations.length - 1} more)`;
    redactions.push({ rule, count: agg.count, location });
  }

  // ── 1. Block wins outright: no partial results. Events stay so the MSP
  //       audit view can show what tripped (rule/count/location only — no
  //       sensitive values). ──────────────────────────────────────────────────
  if (blockedBy !== null) {
    return { action: 'block', blockReason: `dlp_blocked:${blockedBy}`, redactions };
  }

  // ── 2. Redact (3. log rules contribute events only, content untouched) ─────
  const result: DlpResult = { action: 'allow', redactions };
  let outCells: unknown[][] | null = null;
  if (input.cells !== undefined) {
    outCells = input.cells.map((row) => [...(row ?? [])]); // never mutate the input
    result.cells = outCells;
  }
  if (typeof input.text === 'string') result.text = input.text;

  for (let i = 0; i < locations.length; i++) {
    const location = locations[i];
    const matches = perLocation[i];
    if (location === undefined || matches === undefined) continue;
    const spans: Array<{ span: DlpMatch; rule: string }> = [];
    for (const { rule, spans: ruleSpans } of matches) {
      if (rule.action !== 'redact') continue;
      for (const span of ruleSpans) spans.push({ span, rule: rule.name });
    }
    if (spans.length === 0) continue;
    const redacted = replaceSpans(location.content, spans);
    const coords = location.coords;
    if (coords === null) {
      result.text = redacted;
    } else {
      // Numeric/object cells that matched become redacted STRINGS by design.
      const outRow = outCells?.[coords[0]];
      if (outRow !== undefined) outRow[coords[1]] = redacted;
    }
  }

  return result;
}
