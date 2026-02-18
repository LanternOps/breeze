const command = process.argv[2] || 'all';

async function main() {
  switch (command) {
    case 'extract':
      console.log('Extracting assertions from docs...');
      break;
    case 'run':
      console.log('Running assertions...');
      break;
    case 'all':
      console.log('Extracting and running...');
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.error('Usage: doc-verify [extract|run|all]');
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
