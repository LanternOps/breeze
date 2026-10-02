/** The LegacyProjectionEnv a fixture's env implies (#7600 W02; W03 Tasks 1/7 import it). Reads fixture.env, never process.env. */
import { resolveReviewerDefaultModel } from '../../../config/env';
import { resolveDefaultModel } from '../../aiModel';
import type { LegacyProjectionEnv } from '../legacyProjection';
import { getLegacyModelRates, legacyExtensionModel } from '../legacySurfaceModels';
import type { ParityFixture } from './harness';

export function projectionEnvFor(fixture: ParityFixture): LegacyProjectionEnv {
  const env = fixture.env as NodeJS.ProcessEnv;
  return {
    defaultModel: resolveDefaultModel(env),
    reviewerModel: resolveReviewerDefaultModel(env),
    extensionModel: legacyExtensionModel(undefined, env),
    legacyRates: (model) => getLegacyModelRates(model).rates,
  };
}
