const [provider, azureResult, sslcomResult, ...extra] = process.argv.slice(2);
const converged = extra.length === 0 && (
  (provider === 'azure' && azureResult === 'success' && sslcomResult === 'skipped')
  || (provider === 'sslcom' && azureResult === 'skipped' && sslcomResult === 'success')
);

if (!converged) {
  process.stderr.write(
    `Windows signing convergence failed: provider=${provider ?? 'missing'} azure=${azureResult ?? 'missing'} sslcom=${sslcomResult ?? 'missing'}\n`,
  );
  process.exitCode = 1;
}
