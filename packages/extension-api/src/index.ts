export * from '@breeze/extension-sdk';
export {
  parseLegacyExtensionManifest as parseExtensionManifest,
  type LegacyExtensionManifest as ExtensionManifest,
  type LegacyBreezeExtension as BreezeExtension,
  type LegacyExtensionContext as ExtensionContext,
  type AiToolLike,
  type ExtensionAgentContext,
  type ExtensionAuditEvent,
  type ExtensionSecrets,
  type ExtensionDatabase,
} from './legacy';
