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

export {
  inspectArtifact,
  runInspect,
  type InspectFinding,
  type InspectOptions,
  type InspectResult,
  type SignatureStatus,
} from './commands/inspect';
export { packExtension, runPack, type PackOptions, type PackResult } from './commands/pack';
export { runSign, signArtifact, type SignOptions, type SignResult } from './commands/sign';
export {
  runValidate,
  validateExtension,
  type ValidateFinding,
  type ValidateOptions,
  type ValidateResult,
} from './commands/validate';

// Artifact-building primitives, exposed so conformance tests and downstream
// tooling can drive the same functions the CLI commands use — notably
// `signingPayload`, which must stay byte-identical to the host verifier's
// canonical signing payload.
export { buildIntegrityDocument, signingPayload } from './artifact/integrity';
export { canonicalJson } from './artifact/canonicalJson';
