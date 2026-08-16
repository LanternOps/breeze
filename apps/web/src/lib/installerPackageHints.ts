/**
 * Heuristics derived from an installer's file name or download URL, used by the
 * package/version forms to pre-fill fields the user would otherwise have to set
 * by hand: supported OS from the extension, and msiexec silent args for MSIs.
 *
 * `{file}` (single-brace) is the agent's downloaded-path token — distinct from
 * the double-brace `{{...}}` deploy-time variables in installerVariables.ts.
 */
export type InstallerOs = "windows" | "macos" | "linux";

const EXT_OS: Record<string, InstallerOs> = {
  msi: "windows",
  exe: "windows",
  dmg: "macos",
  pkg: "macos",
  deb: "linux",
};


/** Lower-cased installer extension from a file name or download URL, or null
 *  when the name doesn't end in a known installer extension. Query strings and
 *  fragments are ignored so `…/pkg-1.0.msi?sig=abc` still resolves. */
export function installerExt(nameOrUrl: string): string | null {
  const path = nameOrUrl.trim().split(/[?#]/, 1)[0] ?? "";
  const last = path.split("/").pop() ?? "";
  const dot = last.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = last.slice(dot + 1).toLowerCase();
  return ext in EXT_OS ? ext : null;
}

export function osForInstaller(nameOrUrl: string): InstallerOs | null {
  const ext = installerExt(nameOrUrl);
  return ext ? EXT_OS[ext] : null;
}

/**
 * Extension-derived OS hint as a partial form patch, spread alongside
 * applySilentArgsPrefill (lib/installerArgsPrefill.ts) by the package and
 * version forms.
 *
 * Scope note: msiexec silent-args prefill deliberately lives in
 * installerArgsPrefill and NOT here. That path is keyed on the explicit
 * `fileType` selector (which outranks the URL) and is retractable — it
 * withdraws a prefilled msiexec command when the type changes, so a stale
 * `msiexec /i` can't be left behind on a non-MSI. Deriving the same args a
 * second time from the extension alone would reintroduce exactly that bug.
 *
 * Returns an empty patch when the name/URL carries no known installer
 * extension, or when the user has already checked an OS.
 */
export function applyOsHint(
  prev: { supportedOs: string[] },
  nameOrUrl: string,
): { supportedOs: string[] } | Record<string, never> {
  if (prev.supportedOs.length > 0) return {};
  const os = osForInstaller(nameOrUrl);
  return os ? { supportedOs: [os] } : {};
}
