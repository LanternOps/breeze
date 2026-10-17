/**
 * Best-effort scan of an AI-authored script body for user-profile paths
 * (AI data policy, spec 2026-10-15 §2 "Scripts").
 *
 * It catches the model's honest attempts — a literal `C:\Users\bob\...`,
 * `/home/bob`, a quoted `Documents and Settings` spelling, or the usual
 * profile environment variables — so a `no_user_profiles` / `off` tenant gets
 * a policy refusal instead of a script that quietly reads documents. It does
 * NOT make arbitrary scripts document-proof: a constructed or
 * environment-derived path it does not know is not caught. The refusal
 * message names the spelling it found.
 *
 * Spellings are normalised exactly like the path restriction does
 * (`candidateForms`), so `D:\Users`, drive-less `\Users`, macOS `/Users` and
 * `/var/home` all land on the same profile roots.
 */
import { candidateForms, normalizePath } from './devicePathForms';
import { isUserProfilePath } from './aiPathRestriction';

// A quoted literal that starts like an absolute path (may contain spaces).
const QUOTED_PATH = /(["'])((?:[A-Za-z]:)?[\\/][^"'\r\n]*)\1/g;
// A bare absolute path token: X:\..., \..., /... — not inside a word, URL or variable.
const BARE_PATH = /(?<![\w.:\\/$%~-])((?:[A-Za-z]:)?[\\/][^\s"'`;|&<>(),]*)/g;
// Profile directories named through the environment rather than spelled out.
const PROFILE_ENV =
  /\$env:(?:USERPROFILE|HOMEPATH|HOMEDRIVE|APPDATA|LOCALAPPDATA|ONEDRIVE)\b|%(?:USERPROFILE|HOMEPATH|APPDATA|LOCALAPPDATA|ONEDRIVE)%|\$\{?HOME\}?(?!\w)|(?<![\w/.~-])~(?=[\\/]|\s|$)/i;

function landsInProfile(token: string): boolean {
  return candidateForms(normalizePath(token)).some(isUserProfilePath);
}

/** The first spelling in `content` that reaches a user-profile root, or null. */
export function findProfilePathInScript(content: string): string | null {
  for (const match of content.matchAll(QUOTED_PATH)) {
    if (landsInProfile(match[2]!)) return match[2]!;
  }
  for (const match of content.matchAll(BARE_PATH)) {
    if (landsInProfile(match[1]!)) return match[1]!;
  }
  return PROFILE_ENV.exec(content)?.[0] ?? null;
}
