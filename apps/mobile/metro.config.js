// Metro config for the breeze monorepo + pnpm.
//
// pnpm flattens @react-native-community/* and other deps as symlinks under
// apps/mobile/node_modules pointing into ../../node_modules/.pnpm/. Metro's
// default resolver doesn't walk that content-addressed layout reliably, so
// we pin nodeModulesPaths to both the project and workspace roots and tell
// Metro to watch the workspace root.
const path = require('path');
const { getSentryExpoConfig } = require('@sentry/react-native/metro');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

// `getSentryExpoConfig` is Expo's `getDefaultConfig` plus Sentry's asset
// serialization plugin, which stamps a Debug ID into the bundle AND into the
// source map. Without matching debug IDs, an uploaded source map cannot be
// paired with the bundle a crash came from, so every JS frame stays a minified
// offset even though the upload "succeeded" — a failure that looks like
// success, which is the same class of problem as shipping without a DSN.
// Same signature as `getDefaultConfig(projectRoot, options)`; every override
// below still applies because it returns a plain Metro config object.
const config = getSentryExpoConfig(projectRoot);

config.watchFolders = [workspaceRoot];

config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

// Note: don't set `disableHierarchicalLookup: true` here. pnpm packages
// in node_modules/.pnpm/<pkg>/node_modules/ resolve their own transitive
// deps via the standard hierarchical walk — disabling it breaks that.

module.exports = config;
