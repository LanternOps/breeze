/**
 * Audit Trail row presentation helpers (#9672).
 *
 * Action codes are dotted (`user.login`, `script.execute`), so a badge style
 * keyed on a bare verb never matched. Style by the code's first segment (the
 * family) instead.
 */

const NEUTRAL = 'bg-slate-100 text-slate-700 border-slate-200';

const FAMILY_STYLES: Record<string, string> = {
  user: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  device: 'bg-blue-100 text-blue-700 border-blue-200',
  script: 'bg-indigo-100 text-indigo-700 border-indigo-200',
  automation: 'bg-indigo-100 text-indigo-700 border-indigo-200',
  agent: 'bg-slate-100 text-slate-700 border-slate-200',
  backup: 'bg-amber-100 text-amber-700 border-amber-200',
  alert: 'bg-rose-100 text-rose-700 border-rose-200',
  organization: 'bg-cyan-100 text-cyan-700 border-cyan-200',
  site: 'bg-cyan-100 text-cyan-700 border-cyan-200',
  policy: 'bg-violet-100 text-violet-700 border-violet-200',
  ai: 'bg-purple-100 text-purple-700 border-purple-200',
  mcp: 'bg-purple-100 text-purple-700 border-purple-200',
  partner: 'bg-teal-100 text-teal-700 border-teal-200',
  enrollment_key: 'bg-lime-100 text-lime-700 border-lime-200',
};

export function actionBadgeClass(action: string): string {
  const family = action.split('.')[0];
  return FAMILY_STYLES[family] ?? NEUTRAL;
}
