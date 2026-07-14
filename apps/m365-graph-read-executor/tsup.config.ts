import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    config: 'src/config.ts',
    'credentials/azureKeyVaultProvider': 'src/credentials/azureKeyVaultProvider.ts',
  },
  format: ['cjs'],
  dts: false,
  noExternal: [/^@breeze\//],
});
