// Keep a directory entrypoint for consumers whose TS/Vitest aliases map
// @breeze/shared/* directly to src/* instead of using package exports.
export { FOREIGN_KEY_VIOLATION_SQLSTATES, isPgForeignKeyViolation, isPgForeignKeyViolationCode, isPgUniqueViolation, pgErrorCode, pgErrorNode, pgErrorConstraint } from '../utils/pgErrors';
