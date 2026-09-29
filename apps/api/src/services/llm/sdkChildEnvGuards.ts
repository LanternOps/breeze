/**
 * Env vars every Claude Agent SDK child process must run with, whatever
 * endpoint it talks to (#7444).
 *
 * The child env forwards `HOME` (and `USERPROFILE`), which the CLI needs for
 * its own session files. `settingSources: []` stops it loading user/project/
 * local settings and CLAUDE.md, but two host-level context sources survive it:
 *
 * - **Auto-memory.** If `$HOME/.claude/projects/<key>/memory/MEMORY.md` exists
 *   (any machine where someone has used Claude Code on this checkout), the CLI
 *   prepends it to the first user message of every session. Measured on a dev
 *   box: ~25 KB of the operator's private notes in every chat turn, sent to
 *   whatever endpoint the session targets, including a partner's catalog or
 *   BYO gateway. `'1'` turns it off; the CLI reads `'0'` as "force on", so the
 *   value is pinned here rather than inherited.
 * - **Managed-policy CLAUDE.md.** The CLI loads the system-wide managed
 *   CLAUDE.md regardless of `settingSources`. `CLAUDE_CODE_DISABLE_CLAUDE_MDS`
 *   short-circuits every CLAUDE.md loader. Breeze builds its own system prompt
 *   and never wants any of them.
 *
 * Builders put these in the fixed part of the env. Never add these keys to a
 * parent-env passthrough list: a forwarded parent value could re-enable them.
 */
export const SDK_CHILD_HOST_CONTEXT_GUARDS: Readonly<Record<string, string>> = Object.freeze({
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
});
