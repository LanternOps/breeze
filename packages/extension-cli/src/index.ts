/**
 * Public module surface of `@breeze/extension-cli`.
 *
 * Importing this module must never touch the filesystem or network: it only
 * exports the CLI program factory and the individual command entry points,
 * all of which are plain functions that perform I/O when *called*, not when
 * *imported*. The `breeze-ext` binary (`src/cli.ts`) is the only module that
 * executes anything at load time, and only when run as the main module.
 */

export { createProgram } from './cli';

export { runInspect, type InspectOptions } from './commands/inspect';
export { runPack, type PackOptions } from './commands/pack';
export { runSign, type SignOptions } from './commands/sign';
export { runValidate, type ValidateOptions } from './commands/validate';
