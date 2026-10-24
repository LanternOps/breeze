// The selected provider's signing job must have run and succeeded. A skipped
// job means the convergence gate is being asked to bless an installer nobody
// signed, so anything but 'success' fails closed.
const [provider, sslcomResult, ...extra] = process.argv.slice(2);
const converged = extra.length === 0 && provider === 'sslcom' && sslcomResult === 'success';

if (!converged) {
  process.stderr.write(
    `Windows signing convergence failed: provider=${provider ?? 'missing'} sslcom=${sslcomResult ?? 'missing'}\n`,
  );
  process.exitCode = 1;
}
