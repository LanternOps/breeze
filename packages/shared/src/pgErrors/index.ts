// Keep a directory entrypoint for consumers whose TS/Vitest aliases map
// @breeze/shared/* directly to src/* instead of using package exports.
export { isPgUniqueViolation, pgErrorCode, pgErrorNode } from '../utils/pgErrors';
