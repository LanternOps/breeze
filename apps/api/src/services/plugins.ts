import { randomUUID } from 'crypto';
import { db } from '../db';
import { pluginCatalog, pluginInstallations, pluginLogs } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { getEventBus, EventType, BreezeEvent } from './eventBus';

// ============================================================================
// Types and Interfaces
// ============================================================================

export type PluginType = 'integration' | 'automation' | 'reporting' | 'collector' | 'notification' | 'ui';

export type PluginConfigType = 'string' | 'number' | 'boolean' | 'secret';

export interface PluginConfigField {
  type: PluginConfigType;
  required: boolean;
  default?: unknown;
  description?: string;
}

export interface PluginManifest {
  name: string;
  version: string;
  type: PluginType;
  permissions: string[];  // e.g., 'read:devices', 'write:alerts'
  hooks: string[];  // e.g., 'device.online', 'alert.triggered'
  config: Record<string, PluginConfigField>;
  entryPoint: string;
}

export type PluginInstallStatus = 'available' | 'installing' | 'installed' | 'updating' | 'uninstalling' | 'error';

export interface PluginInstallation {
  id: string;
  orgId: string;
  catalogId: string;
  version: string;
  status: PluginInstallStatus;
  enabled: boolean;
  config: Record<string, unknown>;
  permissions: string[];
  hooks: string[];
  sandboxEnabled: boolean;
  resourceLimits: PluginResourceLimits | null;
  installedAt: Date | null;
  installedBy: string | null;
  lastActiveAt: Date | null;
  errorMessage: string | null;
  entryPoint: string;
  name: string;
}

export interface PluginResourceLimits {
  maxMemoryMB?: number;
  maxExecutionTimeMs?: number;
  maxConcurrentExecutions?: number;
}

export interface PluginExecutionResult {
  success: boolean;
  result?: unknown;
  error?: string;
  executionTimeMs: number;
}

export type PluginLogLevel = 'debug' | 'info' | 'warn' | 'error';

// ============================================================================
// PluginLoader Class
// ============================================================================

/**
 * PluginLoader - Manages plugin discovery, installation, and lifecycle
 *
 * Features:
 * - Load plugin manifests from catalog
 * - Install/uninstall plugins for organizations
 * - Validate plugin configurations
 * - Track installation status
 */
class PluginLoader {
  /**
   * Load and parse a plugin manifest from the catalog
   */
  async loadManifest(catalogId: string): Promise<PluginManifest> {
    const [catalogEntry] = await db
      .select()
      .from(pluginCatalog)
      .where(eq(pluginCatalog.id, catalogId))
      .limit(1);

    if (!catalogEntry) {
      throw new Error(`Plugin not found in catalog: ${catalogId}`);
    }

    // Build manifest from catalog entry
    const manifest: PluginManifest = {
      name: catalogEntry.name,
      version: catalogEntry.version,
      type: catalogEntry.type,
      permissions: (catalogEntry.permissions as string[]) || [],
      hooks: (catalogEntry.hooks as string[]) || [],
      config: this.parseConfigSchema(catalogEntry),
      entryPoint: catalogEntry.downloadUrl || ''
    };

    return manifest;
  }

  /**
   * Fetch manifest from a remote URL (for external plugins)
   */
  async loadManifestFromUrl(manifestUrl: string): Promise<PluginManifest> {
    try {
      const response = await fetch(manifestUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch manifest: ${response.statusText}`);
      }
      const manifest = await response.json() as PluginManifest;
      this.validateManifest(manifest);
      return manifest;
    } catch (err) {
      throw new Error(`Failed to load manifest from ${manifestUrl}: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }

  /**
   * Install a plugin for an organization
   */
  async installPlugin(
    orgId: string,
    catalogId: string,
    config: Record<string, unknown>,
    installedBy?: string
  ): Promise<PluginInstallation> {
    // Load manifest
    const manifest = await this.loadManifest(catalogId);

    // Validate configuration against manifest
    this.validateConfig(manifest, config);

    // Check if already installed
    const [existing] = await db
      .select()
      .from(pluginInstallations)
      .where(and(
        eq(pluginInstallations.orgId, orgId),
        eq(pluginInstallations.catalogId, catalogId)
      ))
      .limit(1);

    if (existing) {
      throw new Error(`Plugin ${manifest.name} is already installed for this organization`);
    }

    // Create installation record
    const [installation] = await db
      .insert(pluginInstallations)
      .values({
        orgId,
        catalogId,
        version: manifest.version,
        status: 'installing',
        enabled: true,
        config,
        permissions: manifest.permissions,
        sandboxEnabled: true,
        resourceLimits: {
          maxMemoryMB: 128,
          maxExecutionTimeMs: 30000,
          maxConcurrentExecutions: 5
        },
        installedBy,
        installedAt: new Date()
      })
      .returning();

    if (!installation) {
      throw new Error('Failed to create plugin installation');
    }

    try {
      // Register hooks with event bridge
      const eventBridge = getPluginEventBridge();
      for (const hook of manifest.hooks) {
        eventBridge.registerHook(installation.id, hook);
      }

      // Update status to installed
      await db
        .update(pluginInstallations)
        .set({ status: 'installed' })
        .where(eq(pluginInstallations.id, installation.id));

      // Update install count in catalog
      await db
        .update(pluginCatalog)
        .set({ installCount: (await this.getInstallCount(catalogId)) + 1 })
        .where(eq(pluginCatalog.id, catalogId));

      // Log installation
      await this.logPluginEvent(installation.id, 'info', `Plugin ${manifest.name} v${manifest.version} installed`, {
        orgId,
        catalogId,
        installedBy
      });

      console.log(`[PluginLoader] Installed ${manifest.name} v${manifest.version} for org ${orgId}`);

      return this.toPluginInstallation(installation, manifest);
    } catch (err) {
      // Mark as error
      const errorMessage = err instanceof Error ? err.message : 'Unknown installation error';
      await db
        .update(pluginInstallations)
        .set({ status: 'error', errorMessage })
        .where(eq(pluginInstallations.id, installation.id));

      throw err;
    }
  }

  /**
   * Uninstall a plugin from an organization
   */
  async uninstallPlugin(orgId: string, installationId: string): Promise<void> {
    const [installation] = await db
      .select()
      .from(pluginInstallations)
      .where(and(
        eq(pluginInstallations.id, installationId),
        eq(pluginInstallations.orgId, orgId)
      ))
      .limit(1);

    if (!installation) {
      throw new Error(`Plugin installation not found: ${installationId}`);
    }

    // Mark as uninstalling
    await db
      .update(pluginInstallations)
      .set({ status: 'uninstalling' })
      .where(eq(pluginInstallations.id, installationId));

    try {
      // Unregister hooks
      const eventBridge = getPluginEventBridge();
      const manifest = await this.loadManifest(installation.catalogId);
      for (const hook of manifest.hooks) {
        eventBridge.unregisterHook(installationId, hook);
      }

      // Log uninstallation
      await this.logPluginEvent(installationId, 'info', `Plugin uninstalled`, {
        orgId,
        catalogId: installation.catalogId
      });

      // Delete installation record
      await db
        .delete(pluginInstallations)
        .where(eq(pluginInstallations.id, installationId));

      // Update install count in catalog
      const currentCount = await this.getInstallCount(installation.catalogId);
      await db
        .update(pluginCatalog)
        .set({ installCount: Math.max(0, currentCount - 1) })
        .where(eq(pluginCatalog.id, installation.catalogId));

      console.log(`[PluginLoader] Uninstalled plugin ${installationId} for org ${orgId}`);
    } catch (err) {
      // Mark as error
      const errorMessage = err instanceof Error ? err.message : 'Unknown uninstallation error';
      await db
        .update(pluginInstallations)
        .set({ status: 'error', errorMessage })
        .where(eq(pluginInstallations.id, installationId));

      throw err;
    }
  }

  /**
   * Get all installed plugins for an organization
   */
  async getInstalledPlugins(orgId: string): Promise<PluginInstallation[]> {
    const installations = await db
      .select({
        installation: pluginInstallations,
        catalog: pluginCatalog
      })
      .from(pluginInstallations)
      .innerJoin(pluginCatalog, eq(pluginInstallations.catalogId, pluginCatalog.id))
      .where(eq(pluginInstallations.orgId, orgId));

    return installations.map(({ installation, catalog }) => ({
      id: installation.id,
      orgId: installation.orgId,
      catalogId: installation.catalogId,
      version: installation.version,
      status: installation.status,
      enabled: installation.enabled,
      config: installation.config as Record<string, unknown>,
      permissions: (installation.permissions as string[]) || [],
      hooks: (catalog.hooks as string[]) || [],
      sandboxEnabled: installation.sandboxEnabled,
      resourceLimits: installation.resourceLimits as PluginResourceLimits | null,
      installedAt: installation.installedAt,
      installedBy: installation.installedBy,
      lastActiveAt: installation.lastActiveAt,
      errorMessage: installation.errorMessage,
      entryPoint: catalog.downloadUrl || '',
      name: catalog.name
    }));
  }

  /**
   * Get a specific plugin installation
   */
  async getInstallation(installationId: string): Promise<PluginInstallation | null> {
    const [result] = await db
      .select({
        installation: pluginInstallations,
        catalog: pluginCatalog
      })
      .from(pluginInstallations)
      .innerJoin(pluginCatalog, eq(pluginInstallations.catalogId, pluginCatalog.id))
      .where(eq(pluginInstallations.id, installationId))
      .limit(1);

    if (!result) {
      return null;
    }

    const { installation, catalog } = result;
    return {
      id: installation.id,
      orgId: installation.orgId,
      catalogId: installation.catalogId,
      version: installation.version,
      status: installation.status,
      enabled: installation.enabled,
      config: installation.config as Record<string, unknown>,
      permissions: (installation.permissions as string[]) || [],
      hooks: (catalog.hooks as string[]) || [],
      sandboxEnabled: installation.sandboxEnabled,
      resourceLimits: installation.resourceLimits as PluginResourceLimits | null,
      installedAt: installation.installedAt,
      installedBy: installation.installedBy,
      lastActiveAt: installation.lastActiveAt,
      errorMessage: installation.errorMessage,
      entryPoint: catalog.downloadUrl || '',
      name: catalog.name
    };
  }

  /**
   * Enable or disable a plugin
   */
  async setPluginEnabled(installationId: string, enabled: boolean): Promise<void> {
    await db
      .update(pluginInstallations)
      .set({ enabled, updatedAt: new Date() })
      .where(eq(pluginInstallations.id, installationId));

    await this.logPluginEvent(installationId, 'info', `Plugin ${enabled ? 'enabled' : 'disabled'}`, {});
  }

  /**
   * Update plugin configuration
   */
  async updateConfig(
    installationId: string,
    config: Record<string, unknown>
  ): Promise<void> {
    const installation = await this.getInstallation(installationId);
    if (!installation) {
      throw new Error(`Plugin installation not found: ${installationId}`);
    }

    const manifest = await this.loadManifest(installation.catalogId);
    this.validateConfig(manifest, config);

    await db
      .update(pluginInstallations)
      .set({ config, updatedAt: new Date() })
      .where(eq(pluginInstallations.id, installationId));

    await this.logPluginEvent(installationId, 'info', 'Plugin configuration updated', {});
  }

  // Private helpers

  private parseConfigSchema(catalogEntry: typeof pluginCatalog.$inferSelect): Record<string, PluginConfigField> {
    // In a real implementation, this would parse the config schema from the catalog
    // For now, return an empty config schema
    return {};
  }

  private validateManifest(manifest: PluginManifest): void {
    if (!manifest.name || typeof manifest.name !== 'string') {
      throw new Error('Invalid manifest: missing or invalid name');
    }
    if (!manifest.version || typeof manifest.version !== 'string') {
      throw new Error('Invalid manifest: missing or invalid version');
    }
    const validTypes: PluginType[] = ['integration', 'automation', 'reporting', 'collector', 'notification', 'ui'];
    if (!validTypes.includes(manifest.type)) {
      throw new Error(`Invalid manifest: invalid type ${manifest.type}`);
    }
    if (!Array.isArray(manifest.permissions)) {
      throw new Error('Invalid manifest: permissions must be an array');
    }
    if (!Array.isArray(manifest.hooks)) {
      throw new Error('Invalid manifest: hooks must be an array');
    }
  }

  private validateConfig(manifest: PluginManifest, config: Record<string, unknown>): void {
    for (const [key, field] of Object.entries(manifest.config)) {
      if (field.required && !(key in config)) {
        throw new Error(`Missing required configuration: ${key}`);
      }
      if (key in config) {
        const value = config[key];
        switch (field.type) {
          case 'string':
          case 'secret':
            if (typeof value !== 'string') {
              throw new Error(`Configuration ${key} must be a string`);
            }
            break;
          case 'number':
            if (typeof value !== 'number') {
              throw new Error(`Configuration ${key} must be a number`);
            }
            break;
          case 'boolean':
            if (typeof value !== 'boolean') {
              throw new Error(`Configuration ${key} must be a boolean`);
            }
            break;
        }
      }
    }
  }

  private async getInstallCount(catalogId: string): Promise<number> {
    const [result] = await db
      .select({ count: pluginCatalog.installCount })
      .from(pluginCatalog)
      .where(eq(pluginCatalog.id, catalogId))
      .limit(1);
    return result?.count || 0;
  }

  private toPluginInstallation(
    installation: typeof pluginInstallations.$inferSelect,
    manifest: PluginManifest
  ): PluginInstallation {
    return {
      id: installation.id,
      orgId: installation.orgId,
      catalogId: installation.catalogId,
      version: installation.version,
      status: installation.status,
      enabled: installation.enabled,
      config: installation.config as Record<string, unknown>,
      permissions: (installation.permissions as string[]) || [],
      hooks: manifest.hooks,
      sandboxEnabled: installation.sandboxEnabled,
      resourceLimits: installation.resourceLimits as PluginResourceLimits | null,
      installedAt: installation.installedAt,
      installedBy: installation.installedBy,
      lastActiveAt: installation.lastActiveAt,
      errorMessage: installation.errorMessage,
      entryPoint: manifest.entryPoint,
      name: manifest.name
    };
  }

  private async logPluginEvent(
    installationId: string,
    level: PluginLogLevel,
    message: string,
    context: Record<string, unknown>
  ): Promise<void> {
    await db.insert(pluginLogs).values({
      installationId,
      level,
      message,
      context,
      timestamp: new Date()
    });
  }
}

// ============================================================================
// PluginSandbox Class
// ============================================================================

/**
 * PluginSandbox - Secure execution environment for plugins
 *
 * Features:
 * - Permission validation
 * - Resource limits enforcement
 * - Execution logging
 * - Error isolation
 *
 * Note: For production use, this should integrate with vm2 or isolated-vm
 * for true sandboxing. The current implementation provides a basic function
 * wrapper with permission checks and logging.
 */
class PluginSandbox {
  private executionCount: Map<string, number> = new Map();

  /**
   * Execute plugin code in a sandboxed environment
   */
  async execute(
    plugin: PluginInstallation,
    hook: string,
    payload: unknown
  ): Promise<PluginExecutionResult> {
    const startTime = Date.now();
    const executionId = randomUUID();

    // Check if plugin is enabled
    if (!plugin.enabled) {
      return {
        success: false,
        error: 'Plugin is disabled',
        executionTimeMs: Date.now() - startTime
      };
    }

    // Check if plugin is properly installed
    if (plugin.status !== 'installed') {
      return {
        success: false,
        error: `Plugin status is ${plugin.status}, not installed`,
        executionTimeMs: Date.now() - startTime
      };
    }

    // Check hook permission
    if (!plugin.hooks.includes(hook)) {
      return {
        success: false,
        error: `Plugin is not registered for hook: ${hook}`,
        executionTimeMs: Date.now() - startTime
      };
    }

    // Check concurrent execution limits
    const currentExecutions = this.executionCount.get(plugin.id) || 0;
    const maxConcurrent = plugin.resourceLimits?.maxConcurrentExecutions || 5;
    if (currentExecutions >= maxConcurrent) {
      return {
        success: false,
        error: 'Maximum concurrent executions reached',
        executionTimeMs: Date.now() - startTime
      };
    }

    // Increment execution count
    this.executionCount.set(plugin.id, currentExecutions + 1);

    try {
      // Log execution start
      await this.logExecution(plugin.id, 'info', `Executing hook: ${hook}`, {
        executionId,
        hook,
        payloadSize: JSON.stringify(payload).length
      });

      // Create sandboxed context
      const context = this.createSandboxContext(plugin, hook, payload);

      // Execute with timeout
      const timeoutMs = plugin.resourceLimits?.maxExecutionTimeMs || 30000;
      const result = await this.executeWithTimeout(context, timeoutMs);

      const executionTimeMs = Date.now() - startTime;

      // Log successful execution
      await this.logExecution(plugin.id, 'info', `Hook ${hook} completed successfully`, {
        executionId,
        hook,
        executionTimeMs,
        resultSize: result ? JSON.stringify(result).length : 0
      });

      // Update last active timestamp
      await db
        .update(pluginInstallations)
        .set({ lastActiveAt: new Date() })
        .where(eq(pluginInstallations.id, plugin.id));

      return {
        success: true,
        result,
        executionTimeMs
      };
    } catch (err) {
      const executionTimeMs = Date.now() - startTime;
      const errorMessage = err instanceof Error ? err.message : 'Unknown execution error';

      // Log execution error
      await this.logExecution(plugin.id, 'error', `Hook ${hook} failed: ${errorMessage}`, {
        executionId,
        hook,
        executionTimeMs,
        error: errorMessage
      });

      return {
        success: false,
        error: errorMessage,
        executionTimeMs
      };
    } finally {
      // Decrement execution count
      const count = this.executionCount.get(plugin.id) || 1;
      this.executionCount.set(plugin.id, Math.max(0, count - 1));
    }
  }

  /**
   * Validate that a plugin has the required permissions
   */
  validatePermissions(plugin: PluginInstallation, requiredPermissions: string[]): boolean {
    if (!requiredPermissions || requiredPermissions.length === 0) {
      return true;
    }

    const pluginPermissions = new Set(plugin.permissions);

    for (const required of requiredPermissions) {
      // Check for exact match
      if (pluginPermissions.has(required)) {
        continue;
      }

      // Check for wildcard match (e.g., 'read:*' matches 'read:devices')
      const [action, resource] = required.split(':');
      const wildcardPermission = `${action}:*`;
      if (pluginPermissions.has(wildcardPermission)) {
        continue;
      }

      // Check for full wildcard
      if (pluginPermissions.has('*')) {
        continue;
      }

      // Permission not found
      return false;
    }

    return true;
  }

  /**
   * Get current execution status for a plugin
   */
  getExecutionStatus(pluginId: string): { currentExecutions: number } {
    return {
      currentExecutions: this.executionCount.get(pluginId) || 0
    };
  }

  // Private helpers

  private createSandboxContext(
    plugin: PluginInstallation,
    hook: string,
    payload: unknown
  ): SandboxContext {
    // Create a restricted context for plugin execution
    // In production, this would use vm2 or isolated-vm
    return {
      plugin: {
        id: plugin.id,
        name: plugin.name,
        version: plugin.version,
        config: plugin.config
      },
      hook,
      payload,
      // Provide limited API access
      api: {
        log: (message: string) => {
          console.log(`[Plugin:${plugin.name}] ${message}`);
        },
        // Add more sandboxed API methods as needed
      }
    };
  }

  private async executeWithTimeout(
    context: SandboxContext,
    timeoutMs: number
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Execution timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      try {
        // In production, this would execute the actual plugin code
        // For now, we simulate execution by returning the payload
        // The actual implementation would:
        // 1. Load the plugin code from entryPoint
        // 2. Create an isolated VM context
        // 3. Execute the plugin's handler for the hook
        // 4. Return the result

        // Simulated execution - in production replace with actual plugin code execution
        const result = this.simulatePluginExecution(context);
        clearTimeout(timer);
        resolve(result);
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  private simulatePluginExecution(context: SandboxContext): unknown {
    // This is a placeholder for actual plugin execution
    // In production, this would:
    // 1. Load and parse the plugin code
    // 2. Execute in an isolated environment
    // 3. Return the actual result

    // For now, we just acknowledge the hook was received
    return {
      acknowledged: true,
      hook: context.hook,
      timestamp: new Date().toISOString()
    };
  }

  private async logExecution(
    installationId: string,
    level: PluginLogLevel,
    message: string,
    context: Record<string, unknown>
  ): Promise<void> {
    await db.insert(pluginLogs).values({
      installationId,
      level,
      message,
      context,
      timestamp: new Date()
    });
  }
}

interface SandboxContext {
  plugin: {
    id: string;
    name: string;
    version: string;
    config: Record<string, unknown>;
  };
  hook: string;
  payload: unknown;
  api: {
    log: (message: string) => void;
  };
}

// ============================================================================
// PluginEventBridge Class
// ============================================================================

/**
 * PluginEventBridge - Connects plugins to the event bus
 *
 * Features:
 * - Hook registration and management
 * - Event dispatching to registered plugins
 * - Integration with existing EventBus
 */
class PluginEventBridge {
  private hookRegistry: Map<string, Set<string>> = new Map(); // hook -> Set<pluginId>
  private pluginHooks: Map<string, Set<string>> = new Map();   // pluginId -> Set<hooks>
  private unsubscribers: Map<string, () => void> = new Map();   // hook -> unsubscribe function
  private initialized = false;

  /**
   * Initialize the event bridge and subscribe to events
   */
  init(): void {
    if (this.initialized) {
      return;
    }

    const eventBus = getEventBus();

    // Subscribe to all event types and dispatch to registered plugins
    const unsubscribe = eventBus.subscribe('*', async (event: BreezeEvent) => {
      await this.handleEvent(event);
    });

    this.unsubscribers.set('*', unsubscribe);
    this.initialized = true;

    console.log('[PluginEventBridge] Initialized and listening for events');
  }

  /**
   * Register a plugin for a specific hook
   */
  registerHook(pluginId: string, hook: string): void {
    // Add to hook registry
    if (!this.hookRegistry.has(hook)) {
      this.hookRegistry.set(hook, new Set());
    }
    this.hookRegistry.get(hook)!.add(pluginId);

    // Add to plugin hooks
    if (!this.pluginHooks.has(pluginId)) {
      this.pluginHooks.set(pluginId, new Set());
    }
    this.pluginHooks.get(pluginId)!.add(hook);

    console.log(`[PluginEventBridge] Registered plugin ${pluginId} for hook ${hook}`);
  }

  /**
   * Unregister a plugin from a specific hook
   */
  unregisterHook(pluginId: string, hook: string): void {
    // Remove from hook registry
    this.hookRegistry.get(hook)?.delete(pluginId);
    if (this.hookRegistry.get(hook)?.size === 0) {
      this.hookRegistry.delete(hook);
    }

    // Remove from plugin hooks
    this.pluginHooks.get(pluginId)?.delete(hook);
    if (this.pluginHooks.get(pluginId)?.size === 0) {
      this.pluginHooks.delete(pluginId);
    }

    console.log(`[PluginEventBridge] Unregistered plugin ${pluginId} from hook ${hook}`);
  }

  /**
   * Unregister a plugin from all hooks
   */
  unregisterPlugin(pluginId: string): void {
    const hooks = this.pluginHooks.get(pluginId);
    if (hooks) {
      for (const hook of hooks) {
        this.hookRegistry.get(hook)?.delete(pluginId);
        if (this.hookRegistry.get(hook)?.size === 0) {
          this.hookRegistry.delete(hook);
        }
      }
    }
    this.pluginHooks.delete(pluginId);

    console.log(`[PluginEventBridge] Unregistered plugin ${pluginId} from all hooks`);
  }

  /**
   * Dispatch an event to all registered plugins
   */
  async dispatchEvent(hook: string, payload: unknown, orgId?: string): Promise<void> {
    const pluginIds = this.hookRegistry.get(hook);
    if (!pluginIds || pluginIds.size === 0) {
      return;
    }

    const sandbox = getPluginSandbox();
    const loader = getPluginLoader();

    console.log(`[PluginEventBridge] Dispatching ${hook} to ${pluginIds.size} plugins`);

    for (const pluginId of pluginIds) {
      try {
        const plugin = await loader.getInstallation(pluginId);
        if (!plugin) {
          console.warn(`[PluginEventBridge] Plugin ${pluginId} not found, cleaning up stale registration`);
          this.unregisterPlugin(pluginId);
          continue;
        }

        // Skip if org filter is provided and doesn't match
        if (orgId && plugin.orgId !== orgId) {
          continue;
        }

        // Execute plugin in sandbox
        const result = await sandbox.execute(plugin, hook, payload);
        if (!result.success) {
          console.warn(`[PluginEventBridge] Plugin ${plugin.name} failed on ${hook}: ${result.error}`);
        }
      } catch (err) {
        console.error(`[PluginEventBridge] Error executing plugin ${pluginId}:`, err);
      }
    }
  }

  /**
   * Get all hooks registered for a plugin
   */
  getPluginHooks(pluginId: string): string[] {
    return Array.from(this.pluginHooks.get(pluginId) || []);
  }

  /**
   * Get all plugins registered for a hook
   */
  getHookPlugins(hook: string): string[] {
    return Array.from(this.hookRegistry.get(hook) || []);
  }

  /**
   * Check if a plugin is registered for a hook
   */
  isRegistered(pluginId: string, hook: string): boolean {
    return this.hookRegistry.get(hook)?.has(pluginId) || false;
  }

  /**
   * Shutdown the event bridge
   */
  shutdown(): void {
    for (const unsubscribe of this.unsubscribers.values()) {
      unsubscribe();
    }
    this.unsubscribers.clear();
    this.hookRegistry.clear();
    this.pluginHooks.clear();
    this.initialized = false;

    console.log('[PluginEventBridge] Shutdown complete');
  }

  // Private helpers

  private async handleEvent(event: BreezeEvent): Promise<void> {
    // Map event type to hook name
    const hook = event.type;
    await this.dispatchEvent(hook, event.payload, event.orgId);
  }
}

// ============================================================================
// Singleton Instances
// ============================================================================

let pluginLoaderInstance: PluginLoader | null = null;
let pluginSandboxInstance: PluginSandbox | null = null;
let pluginEventBridgeInstance: PluginEventBridge | null = null;

/**
 * Get the singleton PluginLoader instance
 */
export function getPluginLoader(): PluginLoader {
  if (!pluginLoaderInstance) {
    pluginLoaderInstance = new PluginLoader();
  }
  return pluginLoaderInstance;
}

/**
 * Get the singleton PluginSandbox instance
 */
export function getPluginSandbox(): PluginSandbox {
  if (!pluginSandboxInstance) {
    pluginSandboxInstance = new PluginSandbox();
  }
  return pluginSandboxInstance;
}

/**
 * Get the singleton PluginEventBridge instance
 */
export function getPluginEventBridge(): PluginEventBridge {
  if (!pluginEventBridgeInstance) {
    pluginEventBridgeInstance = new PluginEventBridge();
  }
  return pluginEventBridgeInstance;
}

/**
 * Initialize the plugin event bridge
 * Call this during application startup to enable plugin event handling
 */
export function initPluginEventBridge(): void {
  const bridge = getPluginEventBridge();
  bridge.init();
}

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * Install a plugin for an organization
 */
export async function installPlugin(
  orgId: string,
  catalogId: string,
  config: Record<string, unknown>,
  installedBy?: string
): Promise<PluginInstallation> {
  return getPluginLoader().installPlugin(orgId, catalogId, config, installedBy);
}

/**
 * Uninstall a plugin from an organization
 */
export async function uninstallPlugin(
  orgId: string,
  installationId: string
): Promise<void> {
  return getPluginLoader().uninstallPlugin(orgId, installationId);
}

/**
 * Execute a plugin in the sandbox
 */
export async function executePlugin(
  plugin: PluginInstallation,
  hook: string,
  payload: unknown
): Promise<PluginExecutionResult> {
  return getPluginSandbox().execute(plugin, hook, payload);
}

/**
 * Dispatch an event to all registered plugins
 */
export async function dispatchPluginEvent(
  hook: string,
  payload: unknown,
  orgId?: string
): Promise<void> {
  return getPluginEventBridge().dispatchEvent(hook, payload, orgId);
}

// Export classes for testing
export { PluginLoader, PluginSandbox, PluginEventBridge };
