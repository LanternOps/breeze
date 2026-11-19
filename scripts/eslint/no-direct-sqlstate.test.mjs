import { RuleTester } from 'eslint';
import tsParser from '@typescript-eslint/parser';
import { noDirectSqlstate } from './no-direct-sqlstate.mjs';

const tester = new RuleTester({ languageOptions: { parser: tsParser } });
tester.run('no-direct-sqlstate', noDirectSqlstate, {
  valid: [
    "pgErrorCode(error) === '23505'",
    "isPgUniqueViolation(error)",
    "error.code === 'EPIPE'",
    "error.code === 'ENOENT'",
    "error.code === 23505",
    "error.status === '23505'",
    "isPgForeignKeyViolationCode(pgErrorCode(error))",
    "isPgForeignKeyViolation(error, 'some_fk')",
    "switch (code) { case '23505': break; }",
    // Documented limit: collection and key literals are not checked.
    "new Set(['42501', '23503']).has(code)",
    "const COPY = { '23503': 'gone' }",
  ],
  invalid: [
    "error.code === '23505'",
    "error.code === 'F0000'",
    "error.code === '0A000'",
    "error.code === '2F000'",
    "error.code === '3D000'",
    "error?.code !== '23502'",
    "error['code'] == '42P01'",
    "'23505' != (error as { code: string }).code",
    "(error.code as string) === '40P01'",
    "error!.code === 'XX000'",
    "error.cause?.code === 'HV000'",
    "'P0001' === error?.['code']",
  ].map((code) => ({ code, errors: [{ messageId: 'wrapped' }] })).concat(
    // Postgres 18 reports a RESTRICT refusal as 23001, so a bare foreign-key
    // SQLSTATE comparison silently misses it (#11624), even off pgErrorCode().
    [
      "pgErrorCode(error) === '23503'",
      "code !== '23503'",
      "'23503' == sqlstate",
      "code === '23001'",
      "error.code === '23503'",
      "switch (code) { case '23503': break; }",
      "switch (pgErrorCode(e)) { case '23001': return 1; }",
    ].map((code) => ({ code, errors: [{ messageId: 'foreignKey' }] })),
  ),
});
