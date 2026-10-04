/**
 * AI Suggested Fixes W2 — server-side validation of `submit_suggestions`.
 * DB-free (outcomeTools.ts never touches the database): every referential
 * decision is made against refs the context loader computed ONCE per run from
 * W1's OS-filtered catalog (researchContext.ts). Structural failures throw so
 * the model retries within its turn budget; referential failures DROP the item
 * and record why (spec: "Invalid items are dropped and logged to the run
 * trace, and never persisted").
 */
import {
  SYSTEM_CLEANUP_ACTION_IDS, researchSubmissionSchema,
  type ResearchOutcome, type ResearchRejection, type ResearchSuggestionItem,
} from '@breeze/shared';
import { researchItemTooLarge } from '../fixMemory/researchParameters';

export interface ResearchToolRefs {
  deviceOs: 'windows' | 'macos' | 'linux';
  /** Visible to the run org AND runnable on deviceOs (W1 catalog). */
  scriptIds: ReadonlySet<string>;
  /** Visible to the run org on ANY OS — only used to pick the rejection reason. */
  scriptIdsAnyOs: ReadonlySet<string>;
  playbookIds: ReadonlySet<string>;
}

const OS_PREFIX: Record<ResearchToolRefs['deviceOs'], string> = { windows: 'win_', macos: 'mac_', linux: 'linux_' };
const DRAFT_LANGUAGES: Record<ResearchToolRefs['deviceOs'], ReadonlySet<string>> = {
  windows: new Set(['powershell', 'cmd', 'python']),
  linux: new Set(['bash', 'python']),
  macos: new Set(['bash', 'python']),
};

export function cleanupActionsForOs(os: ResearchToolRefs['deviceOs']): ReadonlySet<string> {
  return new Set(SYSTEM_CLEANUP_ACTION_IDS.filter((id) => id.startsWith(OS_PREFIX[os])));
}

// Postgres text/jsonb cannot store U+0000, and a lone UTF-16 surrogate has no
// valid UTF-8 encoding; either would abort the whole batch insert.
const INVALID_TEXT = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
function hasInvalidText(v: unknown): boolean {
  if (typeof v === 'string') return INVALID_TEXT.test(v);
  if (Array.isArray(v)) return v.some(hasInvalidText);
  if (v && typeof v === 'object') return Object.entries(v).some(([k, x]) => INVALID_TEXT.test(k) || hasInvalidText(x));
  return false;
}

function rejectionFor(item: ResearchSuggestionItem, refs: ResearchToolRefs): ResearchRejection['reason'] | null {
  // Byte bound of the persisted parameters JSON (multi-byte text can exceed the
  // DB's 8192-octet CHECK well within the character limits the schema allows).
  if (hasInvalidText(item)) return 'item_invalid_text';
  if (researchItemTooLarge(item)) return 'item_too_large';
  switch (item.kind) {
    case 'catalog':
      if (item.ref.type === 'playbook') return refs.playbookIds.has(item.ref.id) ? null : 'playbook_not_visible';
      if (refs.scriptIds.has(item.ref.id)) return null;
      return refs.scriptIdsAnyOs.has(item.ref.id) ? 'script_os_incompatible' : 'script_not_visible';
    case 'builtin_action':
      if (item.action !== 'disk_cleanup') return null;
      return item.params.actionIds.every((id) => cleanupActionsForOs(refs.deviceOs).has(id)) ? null : 'cleanup_action_not_allowed';
    case 'draft_request':
      return DRAFT_LANGUAGES[refs.deviceOs].has(item.language) ? null : 'draft_language_os_incompatible';
    case 'manual_steps':
      return null;
  }
}

export function validateResearchSubmission(input: unknown, refs: ResearchToolRefs): ResearchOutcome {
  const parsed = researchSubmissionSchema.parse(input); // throws → model retries
  const items: ResearchSuggestionItem[] = [];
  const rejected: ResearchRejection[] = [];
  parsed.items.forEach((item, index) => {
    const reason = rejectionFor(item, refs);
    if (reason) rejected.push({ index, reason });
    else items.push(item);
  });
  return { summary: parsed.summary, items, rejected, noSafeFix: items.length === 0 };
}
