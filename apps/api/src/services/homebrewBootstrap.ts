/**
 * Pinned Homebrew installer.
 *
 * The agent's `homebrew_bootstrap` command downloads THIS exact file and
 * refuses to execute anything whose sha256 does not match
 * HOMEBREW_INSTALLER_SHA256. The two constants below are a single unit:
 * update BOTH together, deliberately, in a reviewed PR — never point at a
 * moving ref.
 *
 * Why a commit sha and not a tag: the Homebrew/install repository publishes
 * neither GitHub releases nor git tags (verified 2026-08-15 — `/tags` and
 * `/releases/latest` are empty/404), so the only immutable ref it offers is a
 * commit sha. The agent enforces this independently: it rejects any
 * installerUrl whose ref segment is HEAD/master/main, whose host is not
 * raw.githubusercontent.com, or whose path is not under Homebrew/install.
 *
 * To refresh:
 *   1. pick the desired Homebrew/install commit and read it in that repo,
 *   2. curl -sL https://raw.githubusercontent.com/Homebrew/install/<sha>/install.sh | shasum -a 256
 *   3. update both constants below in the same commit.
 */
export const HOMEBREW_INSTALLER_REF = 'cced90146ea6d3057c03a636b668fef177415eb3';

export const HOMEBREW_INSTALLER_URL =
  `https://raw.githubusercontent.com/Homebrew/install/${HOMEBREW_INSTALLER_REF}/install.sh` as const;

export const HOMEBREW_INSTALLER_SHA256 =
  '12479a24be3f5307eecac7cde670fad7118640f031229e964f544b1367b52a41';

/** Exact payload the agent's `homebrew_bootstrap` command expects. */
export function homebrewBootstrapPayload(): {
  installerUrl: string;
  installerSha256: string;
} {
  return {
    installerUrl: HOMEBREW_INSTALLER_URL,
    installerSha256: HOMEBREW_INSTALLER_SHA256,
  };
}
