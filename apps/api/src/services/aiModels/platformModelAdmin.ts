// apps/api/src/services/aiModels/platformModelAdmin.ts
/**
 * Pure validation of a /admin/ai-models patch (spec §5.1, §8, §11). The DB
 * CHECKs (offered ⇒ priced, default ⇒ offered, one default) are the backstop.
 * These rules exist to give the operator a clear message first.
 */
import type { ModelRates, OptionRates, OptionSupport, PromptProfile } from '@breeze/shared';
import { deriveCapabilities, optionSupportErrors } from './capabilities';
import type { PlatformModel } from './platformModels';

export class PlatformModelError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409) {
    super(message);
    this.name = 'PlatformModelError';
  }
}

export interface PlatformModelAdminPatch {
  rates?: ModelRates | null;
  optionRates?: OptionRates | null;
  optionSupport?: OptionSupport;
  minPlan?: string | null;
  promptProfile?: PromptProfile;
  platformOffered?: boolean;
  isPlatformDefault?: boolean;
}

export interface PlatformModelAdminState {
  rates: ModelRates | null;
  optionRates: OptionRates | null;
  optionSupport: OptionSupport;
  minPlan: string | null;
  promptProfile: PromptProfile;
  platformOffered: boolean;
  isPlatformDefault: boolean;
}

export function validatePlatformModelAdminPatch(current: PlatformModel, patch: PlatformModelAdminPatch): PlatformModelAdminState {
  const next: PlatformModelAdminState = {
    rates: patch.rates !== undefined ? patch.rates : current.rates,
    optionRates: patch.optionRates !== undefined ? patch.optionRates : current.optionRates,
    optionSupport: patch.optionSupport ?? current.optionSupport,
    minPlan: patch.minPlan !== undefined ? patch.minPlan : current.minPlan,
    promptProfile: patch.promptProfile ?? current.promptProfile,
    platformOffered: patch.platformOffered ?? current.platformOffered,
    isPlatformDefault: patch.isPlatformDefault ?? current.isPlatformDefault,
  };

  if (current.isPlatformDefault && patch.isPlatformDefault === false) {
    throw new PlatformModelError('This model is the platform default. Make another model the default first.', 409);
  }
  if (current.isPlatformDefault && !next.platformOffered) {
    throw new PlatformModelError('The platform default must stay offered. Make another model the default first.', 409);
  }
  if (next.platformOffered && next.rates === null) {
    throw new PlatformModelError('Set all four prices before offering this model.', 400);
  }
  if (next.platformOffered && !current.platformOffered && current.lifecycle === 'retired') {
    throw new PlatformModelError('A retired model cannot be offered.', 400);
  }
  if (next.isPlatformDefault && !current.isPlatformDefault
    && (!next.platformOffered || current.lifecycle !== 'available')) {
    throw new PlatformModelError('Only an offered, available model can be the platform default.', 400);
  }

  const supportErrors = optionSupportErrors(deriveCapabilities(current.capabilities), next.optionSupport);
  if (supportErrors.length > 0) throw new PlatformModelError(supportErrors.join(' '), 400);

  return next;
}
