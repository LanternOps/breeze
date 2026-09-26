import { z } from 'zod';

// ============================================
// Software Library success exit codes (issue #7038)
// ============================================
//
// A package version may declare vendor-documented success exit codes — the
// analog of winget's `InstallerSuccessCodes` — e.g. Veeam Agent's 1000
// ("installed") and 1101 ("installed, reboot required"). They ADD to the agent's
// built-in success codes (0 always; 3010/1641 for exe/msi) and never replace
// them, so an empty list keeps the historical behavior.
//
// Windows exit codes are 32-bit DWORDs that vendors document in either signed
// (HRESULT, e.g. -2147024891) or unsigned/hex (0x80070005) spelling. Both are
// accepted — the same range winget allows — and stored as the unsigned value so
// one code has one representation. The agent compares by uint32 bit pattern.
// See agent/internal/remote/tools/software_install.go
// (installerExitIndicatesSuccess / parseSuccessExitCodes).

export const MAX_SUCCESS_EXIT_CODES = 32;
const INT32_MIN = -2147483648;
const UINT32_MAX = 4294967295;
const TWO_POW_32 = 4294967296;

function toUnsigned(code: number): number {
  return code < 0 ? code + TWO_POW_32 : code;
}

/** Deduplicated, ascending, unsigned form of a declared code list. */
export function normalizeSuccessExitCodes(codes: readonly number[]): number[] {
  return [...new Set(codes.map(toUnsigned))].sort((a, b) => a - b);
}

export const successExitCodesSchema = z
  .array(z.number().int().min(INT32_MIN).max(UINT32_MAX))
  .max(MAX_SUCCESS_EXIT_CODES)
  .transform(normalizeSuccessExitCodes);

export type ParseSuccessExitCodesTextResult =
  | { ok: true; codes: number[] }
  | { ok: false; invalidToken: string }
  | { ok: false; tooMany: true };

/**
 * Parses the free-text form the web UI collects ("1000, 1101 0x80070005"):
 * comma- and/or whitespace-separated decimal (optionally negative) or 0x-hex
 * integers. Blank input means no declared codes.
 */
export function parseSuccessExitCodesText(text: string): ParseSuccessExitCodesTextResult {
  const tokens = text.split(/[\s,]+/).filter((token) => token !== '');
  if (tokens.length > MAX_SUCCESS_EXIT_CODES) {
    return { ok: false, tooMany: true };
  }
  const codes: number[] = [];
  for (const token of tokens) {
    let value: number;
    if (/^-?\d+$/.test(token)) {
      value = Number(token);
    } else if (/^0x[0-9a-f]+$/i.test(token)) {
      value = Number.parseInt(token.slice(2), 16);
    } else {
      return { ok: false, invalidToken: token };
    }
    if (!Number.isSafeInteger(value) || value < INT32_MIN || value > UINT32_MAX) {
      return { ok: false, invalidToken: token };
    }
    codes.push(value);
  }
  return { ok: true, codes: normalizeSuccessExitCodes(codes) };
}

/** Display form for an edit field: the stored codes, comma separated. */
export function formatSuccessExitCodes(codes: readonly number[] | null | undefined): string {
  return (codes ?? []).join(', ');
}
