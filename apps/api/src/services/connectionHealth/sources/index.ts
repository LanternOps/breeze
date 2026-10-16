import type { HealthSource } from '../types';
import { oauthGrantSource } from './oauthGrant';

/** Every connection kind the reconciler observes. A new integration registers here (spec §1.1). */
export const HEALTH_SOURCES: readonly HealthSource[] = [oauthGrantSource];
