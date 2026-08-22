const rawProvider = process.argv[2] ?? '';
const provider = rawProvider === '' ? 'azure' : rawProvider;

if (provider !== 'azure' && provider !== 'sslcom') {
  process.stderr.write('WINDOWS_SIGNING_PROVIDER must be empty, azure, or sslcom\n');
  process.exitCode = 1;
} else {
  process.stdout.write(`provider=${provider}\n`);
}
