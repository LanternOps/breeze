/**
 * One-shot registration of every provider's effect probes (Recipe Library E4).
 * Called once from API startup; a second call is a no-op so a test import or a
 * re-run of bootstrap cannot trip the registry's duplicate-registration guard.
 */
import { registerGoogleEffectProbes } from './google';
import { registerM365EffectProbes } from './m365';

let registered = false;

export function registerAllEffectProbes(): void {
  if (registered) return;
  registered = true;
  registerGoogleEffectProbes();
  registerM365EffectProbes();
}
