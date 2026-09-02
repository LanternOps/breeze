/**
 * Agent file-transfer caps — the single source of truth for the WEB layer.
 *
 * The authoritative values live in the Go agent
 * (`agent/internal/remote/tools/fileops.go`). These mirrors exist because the
 * browser needs to know the caps *before* it issues a request: the file
 * listing already carries each entry's size, so the File Browser can refuse an
 * over-cap download up front instead of spending a round trip to learn the
 * answer from the device.
 *
 * Both directions are pinned from Go so a one-sided edit fails CI:
 *   - read  → `TestMaxFileReadSizeMatchesSharedConstant` (agent/internal/remote/tools/limits_test.go),
 *             which parses THIS file's `AGENT_MAX_FILE_READ_BYTES` declaration.
 *   - write → `TestMaxMessageSizeCoversLargestLegitimateFrame` (agent/internal/websocket/limits_test.go),
 *             mirrored API-side by `AGENT_MAX_FILE_WRITE_BYTES` in
 *             `apps/api/src/routes/systemTools/schemas.ts`.
 *
 * Note the asymmetry is real, not a typo: the agent reads at most 1 MB but
 * accepts writes up to 4 MB. Raising the read cap is NOT a one-line change —
 * a file_read result is base64'd inline into `stdout`, which the API bounds at
 * `MAX_COMMAND_RESULT_BYTES` (5,000,000) in
 * `apps/api/src/routes/agents/schemas.ts`. 1 MB decoded is ~1.4 MB encoded and
 * fits; anything past ~3.6 MB decoded does not, and the agent's SendResult
 * sheds only the `result` field on overflow, never `stdout`. Lifting this cap
 * requires a chunked transfer path first.
 */

/**
 * Largest file the agent will read for a `file_read` command
 * (`maxFileReadSize` in agent/internal/remote/tools/fileops.go). Over this the
 * agent fails the command with `file too large: <size> bytes (max <cap> bytes)`.
 */
export const AGENT_MAX_FILE_READ_BYTES = 1024 * 1024;
