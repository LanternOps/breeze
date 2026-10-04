/**
 * AI Suggested Fixes W2 — one-shot hand-off from a research "draft request"
 * to the script builder. Per-viewer convenience (sessionStorage, try/catch);
 * the builder pre-fills the AI input but never sends it.
 */
export interface ScriptDraftHandoff { brief: string; language: 'powershell' | 'bash' | 'python' | 'cmd'; title: string; suggestionId: string }

const KEY = 'breeze.scriptDraftHandoff';
const LANGUAGES = new Set(['powershell', 'bash', 'python', 'cmd']);
const LANGUAGE_LABEL: Record<ScriptDraftHandoff['language'], string> = { powershell: 'PowerShell', bash: 'Bash', python: 'Python', cmd: 'CMD' };

export function stashScriptDraft(d: ScriptDraftHandoff): boolean {
  try { sessionStorage.setItem(KEY, JSON.stringify(d)); return true; } catch { return false; }
}

export function takeScriptDraft(): ScriptDraftHandoff | null {
  let raw: string | null = null;
  try { raw = sessionStorage.getItem(KEY); sessionStorage.removeItem(KEY); } catch { return null; }
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<ScriptDraftHandoff>;
    if (typeof v.brief !== 'string' || typeof v.title !== 'string' || typeof v.suggestionId !== 'string' || !LANGUAGES.has(String(v.language))) return null;
    return { brief: v.brief.slice(0, 2000), title: v.title.slice(0, 255), language: v.language as ScriptDraftHandoff['language'], suggestionId: v.suggestionId };
  } catch { return null; }
}

export function draftPrompt(d: ScriptDraftHandoff): string {
  return `Write a ${LANGUAGE_LABEL[d.language]} script for this fix: ${d.brief}`;
}
