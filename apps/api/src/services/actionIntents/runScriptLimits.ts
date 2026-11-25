/**
 * The AI device ceiling (#8600, #12418 Decision OD4): at most this many
 * devices under one approval an AI caller asked for. Keep equal to the
 * `deviceIds.max(10)` in the run_script tool schemas and the handler's slice.
 *
 * A leaf on purpose: the flow built-ins and the device tools read it without
 * importing `runScriptGroupTarget.ts` (db, auth, script targets).
 */
export const RUN_SCRIPT_AI_MAX_DEVICES = 10;
