// Treat an empty CLAUDE_CONFIG_DIR as unset, once, at process start.
//
// docker-compose.yml and deploy/docker-compose.prod.yml map
// `CLAUDE_CONFIG_DIR: ${CLAUDE_CONFIG_DIR:-}`, so an operator who leaves it
// unset hands the API `CLAUDE_CONFIG_DIR=""` (set, but empty). Breeze's own
// resolver (`resolveProjectsDir`) treats that as "use ~/.claude", but the
// Agent SDK (verified in 0.3.296) derives its config dir with
// `process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')`: `??`, not `||`,
// so "" survives and becomes the RELATIVE path "projects". `deleteSession` then
// fails with "not found in any project directory", the nightly transcript
// sweeper (#9133) never deletes an orphan, and the AI tool-output retention job
// (#9044) leaves the raw `.jsonl` behind. Deleting the variable makes Breeze and
// the SDK (including the CLI subprocess `query` spawns, which inherits this
// environment) agree on `~/.claude`. #9133.
//
// This module MUST be imported directly after dotenv's config() in every API
// entrypoint (index.ts, worker.ts) so a `.env` value is normalized too.

export interface ClaudeConfigDirNormalization {
  changed: boolean;
}

/** Deletes `env.CLAUDE_CONFIG_DIR` in place when it is empty or whitespace-only. */
export function normalizeClaudeConfigDir(env: NodeJS.ProcessEnv = process.env): ClaudeConfigDirNormalization {
  const raw = env.CLAUDE_CONFIG_DIR;
  if (raw === undefined || raw.trim() !== '') return { changed: false };
  delete env.CLAUDE_CONFIG_DIR;
  return { changed: true };
}

// Side effect on import: normalize the live process environment.
normalizeClaudeConfigDir();
