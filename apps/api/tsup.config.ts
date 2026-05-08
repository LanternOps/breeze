import { defineConfig } from 'tsup';

export default defineConfig({
  // src/index.ts is the API server. scripts/* are operational one-shots that
  // must be available inside the production image (the runtime container
  // doesn't carry source or tsx). Use named entries so index.cjs stays at
  // dist/index.cjs (preserving the existing Dockerfile CMD path) and scripts
  // land at dist/scripts/<name>.cjs.
  entry: {
    index: 'src/index.ts',
    'scripts/recover-stuck-agents': 'scripts/recover-stuck-agents.ts',
  },
  format: ['cjs'],
  dts: true,
  noExternal: ['@breeze/shared', 'dotenv'],
});
