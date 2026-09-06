import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { AiAgentMode, AiAgentOwnerScope } from '@breeze/shared';

/**
 * Task 13 (#5051): extracted from `AiAgentForm.tsx` (a pure move — every test
 * id and translation key is unchanged) so the guided create flow's
 * `SafetyStep` can render the identical interactive registry a partner draft
 * gets in the edit drawer. Org rows never render this component in either
 * caller: an org row's keys are grant-only (spec §4.4), so `AiAgentForm.tsx`
 * renders its own read-only held-keys list instead (`orgHeldKeysList`), and
 * the guided create flow shows nothing at all for an org draft (there is
 * nothing held yet to show).
 */

/** GET /ai/agents/policy-decidable-keys — the read-only POLICY_DECIDABLE_TIER3
 *  registry (wave 5 Part B, #3827). `note` is the server's one-sentence
 *  description of what the operation actually does; it is rendered as the
 *  checkbox's description below. */
export interface PolicyDecidableKeyOption {
  key: string;
  toolName: string;
  action: string | null;
  note: string;
}

/**
 * `manage_startup_items` -> "Manage startup items". Last-resort label for a
 * registry key this catalog has no translation for: the registry is
 * server-owned, so a key can ship in an API build before the web catalog
 * knows it, and the operator must still read words rather than an identifier.
 * Deliberately silent — a missing translation is a catalog gap to fix in the
 * next extraction pass, not a runtime fault worth a console line on every
 * render of this form.
 */
export function sentenceCase(token: string): string {
  const words = token.replace(/[_:-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** `manage_services:restart` -> `manage_services-restart`, so the key can be
 *  spliced into a DOM id (`aria-describedby` takes an id list, and a colon in
 *  an id is legal HTML but a syntax error in any selector that reads it). */
function idSafe(key: string): string {
  return key.replace(/[^A-Za-z0-9_-]+/g, '-');
}

/** Groups registry entries by `toolName`, preserving the server's ordering
 *  within each group (policyDecidable.ts orders entries deliberately — see
 *  its module doc). */
function groupByTool(entries: PolicyDecidableKeyOption[]): Map<string, PolicyDecidableKeyOption[]> {
  const groups = new Map<string, PolicyDecidableKeyOption[]>();
  for (const entry of entries) {
    const list = groups.get(entry.toolName);
    if (list) list.push(entry);
    else groups.set(entry.toolName, [entry]);
  }
  return groups;
}

/** Minimal shape of react-i18next's `t` this module needs — kept local so
 *  `policyToolLabel`/`policyActionLabel` stay usable from a plain function
 *  (AiAgentForm.tsx's `orgHeldKeysList`) without importing react-i18next's
 *  own generic `TFunction` type. */
type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

/** Registry tool -> translated group heading, falling back to the
 *  sentence-cased token (see `sentenceCase`). */
export function policyToolLabel(t: TranslateFn, toolName: string): string {
  return t(/* i18n-dynamic */ `aiAgentsPage.policyKeys.tools.${toolName}`, {
    defaultValue: sentenceCase(toolName),
  });
}

/** Registry entry -> translated operation label. Scoped by tool, because the
 *  bare action verb is ambiguous across the registry: "disable" appears
 *  against a startup item and a scheduled task, "enable" likewise, and a
 *  checkbox list of bare verbs cannot say which object it authorizes. A
 *  bare-tool entry (`action: null`) has no verb of its own, so it reads as
 *  the tool. */
export function policyActionLabel(t: TranslateFn, entry: PolicyDecidableKeyOption): string {
  return entry.action === null
    ? policyToolLabel(t, entry.toolName)
    : t(/* i18n-dynamic */ `aiAgentsPage.policyKeys.actions.${entry.toolName}.${entry.action}`, {
      defaultValue: sentenceCase(entry.action),
    });
}

/**
 * A partner row's registry is collapsed behind a native `<details>` while the
 * row is NOT acting — placed below Permissions rather than above it, since
 * these checkboxes refine the tool allowlist Permissions already sets, not
 * precede it. The summary counts the selection rather than repeating the
 * full ceiling explanation (still given underneath, once opened), so a
 * shadow-mode baseline reads as one scannable line instead of a checkbox
 * list that authorizes nothing on its own from this row. The moment the row
 * enters act mode the list is unwrapped entirely (not just opened) — that is
 * the one mode where THIS row's own dispatch can be gated by these keys, so
 * it earns the same plain treatment an org row always gets; the ceiling
 * caveat still prints beneath it as a fact that survives the mode, not as
 * something act mode makes disappear.
 *
 * Shared between `AiAgentForm.tsx` (the edit drawer) and `SafetyStep.tsx`
 * (the guided create flow's Safety step, partner drafts only) so the two
 * surfaces can never disagree on when a partner row's registry is worth
 * collapsing.
 */
export function collapsedForCeiling(ownerScope: AiAgentOwnerScope, mode: AiAgentMode): boolean {
  return ownerScope === 'partner' && mode !== 'act';
}

export interface PolicyKeysCheckboxesProps {
  policyKeys: PolicyDecidableKeyOption[];
  policyKeysFailed: boolean;
  selectedKeys: string[];
  onToggle: (key: string) => void;
}

/** The registry checkboxes, grouped by tool with translated labels — the
 *  interactive rendering, reached only for a PARTNER row (an org row's own
 *  read-only or "nothing to show" rendering lives with its caller). */
export default function PolicyKeysCheckboxes({ policyKeys, policyKeysFailed, selectedKeys, onToggle }: PolicyKeysCheckboxesProps) {
  const { t } = useTranslation('settings');
  const policyKeyNoteBaseId = useId();

  if (policyKeysFailed) {
    return (
      <p className="text-sm text-destructive" data-testid="ai-agent-policy-keys-failed">
        {t('aiAgentsPage.fields.supervisedActionKeysFailed')}
      </p>
    );
  }
  if (policyKeys.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="ai-agent-policy-keys-empty">
        {t('aiAgentsPage.fields.supervisedActionKeysEmpty')}
      </p>
    );
  }
  return (
    <div className="space-y-3">
      {[...groupByTool(policyKeys).entries()].map(([toolName, entries]) => (
        <div key={toolName}>
          <p className="text-xs font-semibold">{policyToolLabel(t, toolName)}</p>
          <div className="space-y-1.5">
            {entries.map((entry) => {
              // `idSafe`: a colon in `manage_services:restart` is a legal DOM
              // id character but a syntax error in a CSS/query selector, so
              // the registry key can't be spliced into the id raw.
              const noteId = `${policyKeyNoteBaseId}-${idSafe(entry.key)}`;
              return (
                <label key={entry.key} className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={selectedKeys.includes(entry.key)}
                    onChange={() => onToggle(entry.key)}
                    aria-describedby={noteId}
                    data-testid={`ai-agent-supervised-key-${entry.key}`}
                  />
                  <span>
                    <span className="block">{policyActionLabel(t, entry)}</span>
                    {/* The registry's own one-sentence description of what the
                        operation actually does — wired as the checkbox's
                        accessible description, not just adjacent text, so a
                        screen reader announces it as part of the control. */}
                    <span id={noteId} className="block text-xs text-muted-foreground">
                      {entry.note}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
