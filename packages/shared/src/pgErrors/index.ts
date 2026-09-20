// Keep a directory entrypoint for consumers whose TS/Vitest aliases map
// @breeze/shared/* directly to src/* instead of using package exports.
export { isPgForeignKeyViolation, isPgUniqueViolation, pgErrorCode, pgErrorNode, pgErrorConstraint } from '../utils/pgErrors';
