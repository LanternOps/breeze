// Metro config for the breeze monorepo + pnpm.
//
// pnpm flattens @react-native-community/* and other deps as symlinks under
// apps/mobile/node_modules pointing into ../../node_modules/.pnpm/. Metro's
// default resolver doesn't walk that content-addressed layout reliably, so
// we pin nodeModulesPaths to both the project and workspace roots and tell
// Metro to watch the workspace root.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];

config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

// Note: don't set `disableHierarchicalLookup: true` here. pnpm packages
// in node_modules/.pnpm/<pkg>/node_modules/ resolve their own transitive
// deps via the standard hierarchical walk — disabling it breaks that.

module.exports = config;
