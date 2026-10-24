// SSL.com eSigner is the only Windows signing provider. The Azure Artifact
// Signing lane was retired (account disabled; AZURE_* secrets deleted
// 2026-10-19), so a stale `azure` value must stop the release rather than
// select a job that no longer exists.
const rawProvider = process.argv[2] ?? '';
const provider = rawProvider === '' ? 'sslcom' : rawProvider;

if (provider !== 'sslcom') {
  process.stderr.write('WINDOWS_SIGNING_PROVIDER must be empty or sslcom\n');
  process.exitCode = 1;
} else {
  process.stdout.write(`provider=${provider}\n`);
}
