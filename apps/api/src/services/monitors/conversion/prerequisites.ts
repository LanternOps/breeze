import { normalizeAutomationActions } from '../../automationRuntime';
import { OFFLINE_EFFECTS_RESOLVE_MONITORS } from '../../offlineAlertEffects';
import { MONITOR_RESOLVER_CAPABILITIES } from '../monitorResolver';

export interface ConversionPrerequisite {
  id: '#6342' | '#6343' | '#6344';
  label: string;
  check: () => boolean;
}

/**
 * The converter refuses to run unless the three prerequisite fixes are present
 * (spec §Prerequisite defects, §Risks). Each check is a behavioural probe or a
 * constant exported NEXT TO the fix's code and pinned by a source grep in
 * prerequisites.test.ts — never a flag someone can flip on its own.
 */
export const CONVERSION_PREREQUISITES: readonly ConversionPrerequisite[] = [
  {
    id: '#6342',
    label: '#6342 offline monitors fire through offlineAlertEffects',
    check: () => OFFLINE_EFFECTS_RESOLVE_MONITORS === true,
  },
  {
    id: '#6343',
    label: '#6343 restart_service kind/maxAttempts/cooldownSeconds survive normalizeActions',
    check: () => {
      try {
        const [a] = normalizeAutomationActions([
          { type: 'execute_command', command: 'x', kind: 'restart_service', maxAttempts: 2, cooldownSeconds: 60 },
        ]) as Array<{ kind?: string; maxAttempts?: number; cooldownSeconds?: number }>;
        return a?.kind === 'restart_service' && a.maxAttempts === 2 && a.cooldownSeconds === 60;
      } catch {
        return false;
      }
    },
  },
  {
    id: '#6344',
    label: '#6344 resolveMonitorsForDevice honours assignment role/OS filters',
    check: () => MONITOR_RESOLVER_CAPABILITIES.roleOsFilters === true && MONITOR_RESOLVER_CAPABILITIES.inheritance === true,
  },
];

export class ConversionPrerequisiteMissingError extends Error {
  constructor(readonly missing: string[]) {
    super(`conversion prerequisites missing: ${missing.join('; ')}`);
  }
}

export function missingConversionPrerequisites(list: readonly ConversionPrerequisite[] = CONVERSION_PREREQUISITES): string[] {
  return list.filter((p) => !p.check()).map((p) => p.label);
}

export function assertConversionPrerequisites(list: readonly ConversionPrerequisite[] = CONVERSION_PREREQUISITES): void {
  const missing = missingConversionPrerequisites(list);
  if (missing.length > 0) throw new ConversionPrerequisiteMissingError(missing);
}
