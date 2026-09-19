/**
 * Tolerant JSON parsing for `device_commands.result.stdout` / the agent's
 * `AgentCommandResult.stdout` — the field every `stdout`-based consumer in
 * routes/backup/mssql.ts and routes/backup/hyperv.ts reads after
 * `executeCommand()` returns (D20).
 *
 * Before D20-B, `agent/internal/heartbeat/backup_forwarder.go`'s success path
 * ran the backup helper's already-JSON stdout back through
 * `tools.NewSuccessResult`, which `json.Marshal`s it a SECOND time. A queue
 * admission ack the helper sent as the 16-byte text `{"queued":true}` was
 * therefore stored server-side as the literal 24-byte text
 * `"{\"queued\":true}"` — valid JSON, but a JSON STRING, not an object. A
 * single `JSON.parse` of that text yields a plain string, which is exactly
 * the `expected object, received string` 500 proven live against agent
 * 0.112.5.
 *
 * D20-B stops the double encoding for agents that ship it, but the fleet is
 * mixed for a long time after any one release — old agents keep sending the
 * double-encoded shape until they self-update. This parser tolerates BOTH
 * shapes so the server does not have to wait on fleet-wide rollout: it parses
 * once, and if that yields a string which is ITSELF valid JSON, unwraps
 * exactly one more level. A string that does not further parse as JSON is a
 * legitimate plain-string result (not a double-encoded one) and is returned
 * as-is, never rejected.
 */
export function parseAgentJsonStdout(stdout: string | null | undefined): unknown {
  if (stdout == null || stdout === '') {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new Error(
      `Malformed agent stdout: not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  if (typeof parsed === 'string') {
    try {
      return JSON.parse(parsed);
    } catch {
      // Not double-encoded JSON — a genuine plain-string result. Exactly one
      // unwrap attempt only: never loop trying to peel further layers.
      return parsed;
    }
  }

  return parsed;
}
