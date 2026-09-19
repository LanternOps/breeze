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
  ],
  invalid: [
    "error.code === '23505'",
    "error.code === 'F0000'",
    "error.code === '0A000'",
    "error.code === '2F000'",
    "error.code === '3D000'",
    "error?.code !== '23503'",
    "error['code'] == '42P01'",
    "'23505' != (error as { code: string }).code",
    "(error.code as string) === '40P01'",
    "error!.code === 'XX000'",
    "error.cause?.code === 'HV000'",
    "'P0001' === error?.['code']",
  ].map((code) => ({ code, errors: [{ messageId: 'wrapped' }] })),
});
