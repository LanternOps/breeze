/**
 * Identifier for the HP Client Management Script Library (CMSL) licence a
 * partner accepts when they switch on device-side HP warranty collection
 * (feature #5511, contract D2).
 *
 * The id is COMPARED, never parsed. When HP changes its terms this constant
 * takes a NEW value: consent recorded against the old id no longer satisfies
 * the current one, so the config-policy author has to accept again — and the
 * agent stops collecting until they do. That is deliberate. An acceptance is
 * an acceptance of specific terms or it is not an acceptance at all.
 *
 * The date is the release date of the CMSL package whose licence text was
 * read (HP.HPCMSL 1.8.6, 2026-04-01), not the date this file was written.
 */
export const HP_CMSL_EULA_ID = 'hp-cmsl-eula-2026-04-01';
