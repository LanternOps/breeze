import { statSync } from 'node:fs';
import {
  loadM365CustomerGraphReadRuntimeConfig,
  validateM365CustomerGraphReadRuntimeConfigAtBoot,
} from '../../apps/api/src/services/m365ControlPlane/runtimeConfig';

const enabled = ['1', 'true', 'yes', 'on'].includes(
  (process.env.M365_CUSTOMER_GRAPH_READ_ONBOARDING_ENABLED ?? '').toLowerCase(),
);

validateM365CustomerGraphReadRuntimeConfigAtBoot(process.env);

if (!enabled) {
  process.stdout.write('m365 signing secret dark-config smoke passed\n');
  process.exit(0);
}

const secretPath = process.env.M365_GRAPH_READ_EXECUTOR_SIGNING_PRIVATE_JWK_FILE;
if (!secretPath) throw new Error('signing private-JWK file path is missing');

const metadata = statSync(secretPath);
if (!metadata.isFile() || metadata.uid !== 1001 || metadata.gid !== 1001) {
  throw new Error('signing private-JWK secret must be a regular file owned by numeric 1001:1001');
}
if ((metadata.mode & 0o777) !== 0o400) {
  throw new Error('signing private-JWK secret must have mode 0400');
}

const config = loadM365CustomerGraphReadRuntimeConfig(process.env);
if (
  config.executorSigningKid !== 'm365-runtime-smoke'
  || typeof config.executorSigningPrivateJwk.d !== 'string'
) {
  throw new Error('API runtime did not load the expected signing-key descriptor');
}

process.stdout.write('m365 signing secret enabled-config smoke passed\n');
