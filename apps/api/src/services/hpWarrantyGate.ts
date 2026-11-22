/**
 * HP warranty (CMSL) gating for the heartbeat (#5511, observe-first amendment §1).
 *
 * The stage comes only from the shared vendor canary (`vendorStage` for
 * `hp_warranty:hp`); this file adds no second gate. It only:
 *
 *  - requires the device's existing per-device opt-in (hpCmsl enabled with
 *    consent to the current EULA) before any stage applies; and
 *  - says which act tiers are open, a code constant that only a reviewed PR
 *    carrying observe evidence changes, one tier per PR (amendment §3).
 *
 * Pure: env and constants only, so the heartbeat pays no query for it.
 */
import type { HpCmslActTier, HpCmslMode, WarrantySettingsWire } from '@breeze/shared/validators';
import { vendorStage } from './vendorCanary';

/** Open act tiers, in opening order. Empty: nothing acts yet. */
export const HP_WARRANTY_ACT_TIERS: readonly HpCmslActTier[] = Object.freeze([]);

/**
 * The device's HP CMSL mode. `consentEffective` is
 * `warrantyHpCmslCollectionEffective` on the device's resolved warranty link:
 * without it the device is `off` whatever its partner's stage.
 */
export function hpCmslMode(consentEffective: boolean, partnerId: string | null | undefined): HpCmslMode {
  if (!consentEffective) return 'off';
  return vendorStage('hp_warranty', 'hp', partnerId);
}

/**
 * The heartbeat's `warranty_settings` block. Every key is always sent:
 * `hp_cmsl_enabled` is what agents built before the observe step persist, and
 * they keep it when the key is absent, so it is true only at `act` and an
 * explicit false otherwise.
 */
export function toWarrantySettingsWire(
  mode: HpCmslMode,
  openTiers: readonly HpCmslActTier[] = HP_WARRANTY_ACT_TIERS,
): WarrantySettingsWire {
  const act = mode === 'act';
  return {
    hp_cmsl_enabled: act,
    hp_cmsl_mode: mode,
    hp_cmsl_tiers: act ? [...openTiers] : [],
  };
}
