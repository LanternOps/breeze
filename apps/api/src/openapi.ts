/**
 * Breeze RMM API - OpenAPI 3.0 Specification
 *
 * This file defines the complete API documentation for the Breeze RMM platform.
 * Documentation is served via Swagger UI at /api/v1/docs
 */

import { ACTOR_TYPES, AUDIT_RESULTS } from '@breeze/shared';

export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Breeze RMM API',
    description: `
Breeze is a fast, modern Remote Monitoring and Management (RMM) platform for MSPs and internal IT teams.

## Authentication

- **Bearer Token (JWT)**: Include the token in the \`Authorization\` header as \`Bearer <token>\`.
  This is the credential for the endpoints documented here; tenancy-mutating writes additionally
  require the session to have completed MFA.
- **API Key (\`X-API-Key\`)**: organization API keys (\`brz_…\`) are **not** general-purpose API
  auth. They authenticate exactly three surfaces: \`POST /mcp/*\`, \`POST /dev/push\`, and
  \`GET\`/\`PATCH /devices/{id}/custom-fields\`. Every other endpoint rejects them with 401.
- **Partner service-principal key (\`brz_sp_…\`, also via \`X-API-Key\`)**: the machine-to-machine
  credential for the \`/partner-api/*\` export and provisioning surface (not documented in this spec).

## Multi-Tenant Architecture

Breeze uses a hierarchical multi-tenant model:

\`\`\`
Partner (MSP) → Organization (Customer) → Site (Location) → Device Group → Device
\`\`\`

API access is scoped based on your authentication context:
- **System scope**: Full access to all resources
- **Partner scope**: Access to all organizations under the partner
- **Organization scope**: Access to resources within the organization

## Rate Limiting

API requests are rate-limited to ensure fair usage. Rate limit headers are included in responses:
- \`X-RateLimit-Limit\`: Maximum requests per window
- \`X-RateLimit-Remaining\`: Remaining requests in current window
- \`X-RateLimit-Reset\`: Unix timestamp when the window resets
    `,
    version: '1.0.0',
    contact: {
      name: 'Breeze RMM Support',
      email: 'support@breezermm.com'
    },
    license: {
      name: 'Proprietary',
      url: 'https://breezermm.com/license'
    }
  },
  servers: [
    {
      url: '/api/v1',
      description: 'Current API version'
    }
  ],
  tags: [
    { name: 'Auth', description: 'Authentication and authorization' },
    { name: 'Users', description: 'User management and invitations' },
    { name: 'Organizations', description: 'Partners, organizations, and sites management' },
    { name: 'Devices', description: 'Device management and monitoring' },
    { name: 'Scripts', description: 'Script library and execution' },
    { name: 'Alerts', description: 'Alert rules, alerts, and notifications' },
    { name: 'Automations', description: 'Automation workflows and runs' },
    { name: 'Policies', description: 'Compliance policy definitions and evaluations' },
    { name: 'Reports', description: 'Reporting and data exports' },
    { name: 'Remote', description: 'Remote access sessions' },
    { name: 'Agents', description: 'Agent enrollment and communication' },
    { name: 'Audit', description: 'Audit logging and activity tracking' }
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'JWT access token obtained from /auth/login'
      },
      apiKeyAuth: {
        type: 'apiKey',
        in: 'header',
        name: 'X-API-Key',
        description:
          'Organization API key (brz_…). Only valid on POST /mcp/*, POST /dev/push, and ' +
          'GET/PATCH /devices/{id}/custom-fields — all other endpoints reject it with 401. ' +
          'For machine-to-machine access use a partner service-principal key (brz_sp_…) ' +
          'against the /partner-api/* surface.'
      }
    },
    schemas: {
      // Custom-field definition importer (#3257 W07)
      CustomFieldDefinitionImportRow: {
        type: 'object',
        required: ['fieldKey', 'name', 'type', 'ownerScope'],
        properties: {
          fieldKey: {
            type: 'string',
            pattern: '^[a-z][a-z0-9_]*$',
            maxLength: 100,
            description: 'Lowercase alphanumeric with underscores — the same rule POST /custom-fields enforces.'
          },
          name: { type: 'string', maxLength: 100 },
          type: { type: 'string', enum: ['text', 'number', 'boolean', 'dropdown', 'date'] },
          options: { type: 'object', nullable: true, description: 'Shared CustomFieldOptions contract (choices/min/max/…).' },
          required: { type: 'boolean' },
          deviceTypes: { type: 'array', nullable: true, items: { type: 'string', enum: ['windows', 'macos', 'linux'] } },
          ownerScope: {
            type: 'string',
            enum: ['partner', 'organization'],
            description: 'Ownership axis. Org XOR partner is enforced by custom_field_definitions_one_owner_chk.'
          },
          organizationId: { type: 'string', format: 'uuid', description: 'Required when ownerScope is "organization".' },
          sourceLabel: {
            type: 'string',
            maxLength: 120,
            description: 'The incumbent RMM\'s own name for the field (e.g. "udf7"). Recorded in the audit trail, never stored on the definition.'
          },
          expectedAnnotation: {
            type: 'string',
            description: 'COMMIT only. The annotation preview returned; the row is rejected if it has since moved.'
          },
          expectedDefinitionId: {
            type: 'string',
            format: 'uuid',
            description: 'COMMIT only. Required when expectedAnnotation is "already-exists" — pins the acknowledgement to one definition.'
          }
        }
      },
      CustomFieldDefinitionImportRequest: {
        type: 'object',
        required: ['rows'],
        properties: {
          partnerId: {
            type: 'string',
            format: 'uuid',
            description: 'System scope only may name a partner other than its own; anyone else supplying a different one gets 403.'
          },
          externalSystem: {
            type: 'string',
            maxLength: 64,
            default: 'csv',
            description: 'Which RMM the file came from (datto_rmm, ninjaone, cw_automate, n_central, csv). Recorded in the audit trail.'
          },
          rows: {
            type: 'array',
            minItems: 1,
            maxItems: 1000,
            items: { $ref: '#/components/schemas/CustomFieldDefinitionImportRow' }
          }
        }
      },
      DeviceCustomFieldImportValue: {
        type: 'object',
        required: ['target', 'value'],
        properties: {
          target: {
            oneOf: [
              {
                type: 'object',
                required: ['kind', 'fieldKey'],
                properties: {
                  kind: { type: 'string', enum: ['customField'] },
                  fieldKey: { type: 'string', minLength: 1, maxLength: 100 }
                }
              },
              {
                type: 'object',
                required: ['kind', 'field'],
                properties: {
                  kind: { type: 'string', enum: ['warranty'] },
                  field: {
                    type: 'string',
                    enum: ['warrantyStartDate', 'warrantyEndDate', 'manufacturer'],
                    description:
                      'device_warranty columns an import may write. "status" is COMPUTED from the end date and never accepted; '
                      + '"is_subscription" is never written at all — a true value suppresses expiry alerting and an import cannot know it.'
                  }
                }
              }
            ]
          },
          value: {
            nullable: true,
            oneOf: [{ type: 'string', maxLength: 10000 }, { type: 'number' }, { type: 'boolean' }],
            description: 'null is an explicit clear, not "absent".'
          }
        }
      },
      DeviceCustomFieldImportRow: {
        type: 'object',
        required: ['values'],
        description:
          'Every identifier is optional and EVERY supplied one is resolved — a row whose identifiers point at different '
          + 'devices is refused as identity-conflict rather than letting the first hit win. Resolution order: deviceId, '
          + '(externalSystem, externalId) via device_external_links, serialNumber, hostname.',
        properties: {
          organizationId: { type: 'string', format: 'uuid', nullable: true, description: 'Narrows resolution to one organization. Out of reach ⇒ org-not-found.' },
          deviceId: { type: 'string', format: 'uuid', nullable: true },
          externalSystem: { type: 'string', maxLength: 64, nullable: true },
          externalId: { type: 'string', maxLength: 255, nullable: true, description: 'Recorded as a durable device_external_links row on the first non-link match, so the next run resolves exactly.' },
          externalSourceInstance: { type: 'string', maxLength: 255, nullable: true, description: 'Reserved; always null today.' },
          serialNumber: { type: 'string', maxLength: 255, nullable: true },
          hostname: { type: 'string', maxLength: 255, nullable: true },
          values: { type: 'array', items: { $ref: '#/components/schemas/DeviceCustomFieldImportValue' } },
          expectedOutcome: {
            type: 'string',
            enum: ['matched', 'link-match', 'ambiguous', 'not-found', 'org-not-found', 'identity-conflict'],
            description: 'COMMIT only. The row outcome preview returned; the row is rejected "annotation-changed" if it has since moved.'
          },
          expectedDeviceId: {
            type: 'string',
            format: 'uuid',
            description: 'COMMIT only. REQUIRED when expectedOutcome is "ambiguous" — pins the acknowledgement to the device the operator picked.'
          }
        }
      },
      DeviceCustomFieldImportRequest: {
        type: 'object',
        required: ['rows'],
        properties: {
          partnerId: {
            type: 'string',
            format: 'uuid',
            description: 'System scope only may name a partner other than its own; anyone else supplying a different one gets 403.'
          },
          externalSystem: {
            type: 'string',
            maxLength: 64,
            default: 'csv',
            description: 'Which RMM the file came from. Used for the audit trail when a row does not name its own.'
          },
          mode: {
            type: 'string',
            enum: ['skip', 'update'],
            default: 'skip',
            description: 'What to do with a field that already holds a value. Per VALUE, not per row.'
          },
          overrideProviderWarranty: {
            type: 'boolean',
            default: false,
            description: 'Replace warranty rows whose data_source is "provider" (a manufacturer API lookup). Off by default: a vendor answer outranks a CSV.'
          },
          rows: {
            type: 'array',
            minItems: 1,
            maxItems: 1000,
            description: 'Capped at 1000 rows AND 5000 total values per request — the row cap alone does not bound the work.',
            items: { $ref: '#/components/schemas/DeviceCustomFieldImportRow' }
          }
        }
      },
      // Common schemas
      Pagination: {
        type: 'object',
        properties: {
          page: { type: 'integer', example: 1 },
          limit: { type: 'integer', example: 50 },
          total: { type: 'integer', example: 100 }
        }
      },
      Error: {
        type: 'object',
        properties: {
          error: { type: 'string', description: 'Error message' },
          message: { type: 'string', description: 'Detailed error message' }
        },
        required: ['error']
      },
      Success: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true }
        }
      },

      // Auth schemas
      LoginRequest: {
        type: 'object',
        properties: {
          email: { type: 'string', format: 'email', example: 'user@example.com' },
          password: { type: 'string', minLength: 1 }
        },
        required: ['email', 'password']
      },
      LoginResponse: {
        type: 'object',
        properties: {
          user: { $ref: '#/components/schemas/User' },
          tokens: { $ref: '#/components/schemas/Tokens' },
          mfaRequired: { type: 'boolean' },
          tempToken: { type: 'string', description: 'Temporary token for MFA verification' },
          authenticatorRegisterGrantId: {
            type: 'string',
            description:
              'Single-use 300s grant for registering this device as an approver. Only returned on POST /auth/login and /auth/mfa/verify to clients sending X-Breeze-Mobile-Device-Id; never on /auth/register or /auth/refresh.',
          },
        }
      },
      RegisterRequest: {
        type: 'object',
        properties: {
          email: { type: 'string', format: 'email' },
          password: { type: 'string', minLength: 8 },
          name: { type: 'string', minLength: 1, maxLength: 255 }
        },
        required: ['email', 'password', 'name']
      },
      Tokens: {
        type: 'object',
        properties: {
          accessToken: { type: 'string' },
          expiresInSeconds: { type: 'integer', example: 900 }
        }
      },
      MfaSetupResponse: {
        type: 'object',
        properties: {
          secret: { type: 'string' },
          otpAuthUrl: { type: 'string' },
          qrCodeDataUrl: { type: 'string' },
          recoveryCodes: { type: 'array', items: { type: 'string' } }
        }
      },

      // User schemas
      User: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          email: { type: 'string', format: 'email' },
          name: { type: 'string' },
          avatarUrl: { type: 'string', nullable: true },
          mfaEnabled: { type: 'boolean' },
          status: { type: 'string', enum: ['active', 'invited', 'disabled'] },
          lastLoginAt: { type: 'string', format: 'date-time', nullable: true },
          createdAt: { type: 'string', format: 'date-time' }
        }
      },
      InviteUserRequest: {
        type: 'object',
        properties: {
          email: { type: 'string', format: 'email' },
          name: { type: 'string', minLength: 1, maxLength: 255 },
          roleId: { type: 'string', format: 'uuid' },
          orgAccess: { type: 'string', enum: ['all', 'selected', 'none'] },
          orgIds: { type: 'array', items: { type: 'string', format: 'uuid' } },
          siteIds: { type: 'array', items: { type: 'string', format: 'uuid' } },
          deviceGroupIds: { type: 'array', items: { type: 'string', format: 'uuid' } }
        },
        required: ['email', 'name', 'roleId']
      },
      Role: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          description: { type: 'string', nullable: true },
          scope: { type: 'string', enum: ['partner', 'organization'] },
          isSystem: { type: 'boolean' }
        }
      },

      // Organization schemas
      Partner: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          slug: { type: 'string' },
          type: { type: 'string', enum: ['msp', 'enterprise', 'internal'] },
          plan: { type: 'string', enum: ['free', 'pro', 'enterprise', 'unlimited'] },
          maxOrganizations: { type: 'integer', nullable: true },
          maxDevices: { type: 'integer', nullable: true },
          billingEmail: { type: 'string', format: 'email', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' }
        }
      },
      Organization: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          partnerId: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          slug: { type: 'string' },
          type: { type: 'string', enum: ['customer', 'internal'] },
          status: { type: 'string', enum: ['active', 'suspended', 'trial', 'churned', 'offboarding'] },
          maxDevices: { type: 'integer', nullable: true },
          contractStart: { type: 'string', format: 'date-time', nullable: true },
          contractEnd: { type: 'string', format: 'date-time', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' }
        }
      },
      Site: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          orgId: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          timezone: { type: 'string', example: 'America/New_York' },
          address: { type: 'object', nullable: true },
          contact: { type: 'object', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' }
        }
      },

      // Device schemas
      Device: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          orgId: { type: 'string', format: 'uuid' },
          siteId: { type: 'string', format: 'uuid' },
          agentId: { type: 'string' },
          hostname: { type: 'string' },
          displayName: { type: 'string', nullable: true },
          osType: { type: 'string', enum: ['windows', 'macos', 'linux'] },
          osVersion: { type: 'string' },
          architecture: { type: 'string' },
          agentVersion: { type: 'string' },
          watchdogVersion: { type: 'string', nullable: true },
          status: { type: 'string', enum: ['online', 'offline', 'maintenance', 'decommissioned'] },
          lastSeenAt: { type: 'string', format: 'date-time', nullable: true },
          enrolledAt: { type: 'string', format: 'date-time' },
          tags: { type: 'array', items: { type: 'string' } },
          hardware: { $ref: '#/components/schemas/DeviceHardware' }
        }
      },
      DeviceHardware: {
        type: 'object',
        properties: {
          cpuModel: { type: 'string', nullable: true },
          cpuCores: { type: 'integer', nullable: true },
          ramTotalMb: { type: 'integer', nullable: true },
          diskTotalGb: { type: 'integer', nullable: true },
          serialNumber: { type: 'string', nullable: true },
          manufacturer: { type: 'string', nullable: true },
          model: { type: 'string', nullable: true },
          motherboardManufacturer: { type: 'string', nullable: true },
          motherboardProduct: { type: 'string', nullable: true },
          motherboardVersion: { type: 'string', nullable: true }
        }
      },
      DeviceMetrics: {
        type: 'object',
        properties: {
          timestamp: { type: 'string', format: 'date-time' },
          cpu: { type: 'number', description: 'CPU usage percentage' },
          ram: { type: 'number', description: 'RAM usage percentage' },
          ramUsedMb: { type: 'integer' },
          disk: { type: 'number', description: 'Disk usage percentage' },
          diskUsedGb: { type: 'number' },
          diskActivityAvailable: { type: 'boolean' },
          diskReadBytes: { type: 'integer' },
          diskWriteBytes: { type: 'integer' },
          diskReadBps: { type: 'integer' },
          diskWriteBps: { type: 'integer' },
          diskReadOps: { type: 'integer' },
          diskWriteOps: { type: 'integer' },
          networkIn: { type: 'integer' },
          networkOut: { type: 'integer' },
          bandwidthInBps: { type: 'integer' },
          bandwidthOutBps: { type: 'integer' },
          processCount: { type: 'integer' }
        }
      },
      DeviceGroup: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          orgId: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          siteId: { type: 'string', format: 'uuid', nullable: true },
          type: { type: 'string', enum: ['static', 'dynamic'] },
          rules: { type: 'object', nullable: true },
          parentId: { type: 'string', format: 'uuid', nullable: true },
          createdAt: { type: 'string', format: 'date-time' }
        }
      },
      DeviceCommand: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          deviceId: { type: 'string', format: 'uuid' },
          type: { type: 'string', enum: ['script', 'reboot', 'shutdown', 'update'] },
          status: { type: 'string', enum: ['pending', 'sent', 'completed', 'failed', 'cancelled'] },
          payload: { type: 'object' },
          result: { type: 'object', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
          completedAt: { type: 'string', format: 'date-time', nullable: true }
        }
      },

      // Script schemas
      Script: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          orgId: { type: 'string', format: 'uuid', nullable: true },
          name: { type: 'string' },
          description: { type: 'string', nullable: true },
          category: { type: 'string', nullable: true },
          osTypes: { type: 'array', items: { type: 'string', enum: ['windows', 'macos', 'linux'] } },
          language: { type: 'string', enum: ['powershell', 'bash', 'python', 'cmd'] },
          content: { type: 'string' },
          parameters: { type: 'object', nullable: true },
          timeoutSeconds: { type: 'integer', default: 300 },
          runAs: { type: 'string', enum: ['system', 'user', 'elevated'] },
          isSystem: { type: 'boolean' },
          version: { type: 'integer' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' }
        }
      },
      ScriptExecution: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          scriptId: { type: 'string', format: 'uuid' },
          deviceId: { type: 'string', format: 'uuid' },
          triggeredBy: { type: 'string', format: 'uuid' },
          // 'automation' is emitted by the automation runtime only (#3162);
          // the executeScript request body still accepts just the first four,
          // so a caller cannot forge this provenance.
          triggerType: { type: 'string', enum: ['manual', 'scheduled', 'alert', 'policy', 'automation'] },
          parameters: { type: 'object', nullable: true },
          status: { type: 'string', enum: ['pending', 'queued', 'running', 'cancelling', 'completed', 'failed', 'timeout', 'cancelled'] },
          startedAt: { type: 'string', format: 'date-time', nullable: true },
          completedAt: { type: 'string', format: 'date-time', nullable: true },
          exitCode: { type: 'integer', nullable: true },
          stdout: { type: 'string', nullable: true },
          stderr: { type: 'string', nullable: true },
          errorMessage: { type: 'string', nullable: true },
          cancelState: { type: 'string', nullable: true, enum: ['requested', 'confirmed', 'unconfirmed', 'failed'] },
          cancelRequestedAt: { type: 'string', format: 'date-time', nullable: true },
          cancelCommandId: { type: 'string', format: 'uuid', nullable: true }
        }
      },

      // Alert schemas
      AlertRule: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          orgId: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          description: { type: 'string', nullable: true },
          enabled: { type: 'boolean' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
          targets: { type: 'object', description: 'Target configuration (devices, sites, etc.)' },
          conditions: { type: 'object', description: 'Alert trigger conditions' },
          cooldownMinutes: { type: 'integer' },
          escalationPolicyId: { type: 'string', format: 'uuid', nullable: true },
          notificationChannels: { type: 'array', items: { type: 'string', format: 'uuid' } },
          autoResolve: { type: 'boolean' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' }
        }
      },
      Alert: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          ruleId: { type: 'string', format: 'uuid' },
          deviceId: { type: 'string', format: 'uuid' },
          orgId: { type: 'string', format: 'uuid' },
          status: { type: 'string', enum: ['active', 'acknowledged', 'resolved', 'suppressed', 'dismissed'] },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
          title: { type: 'string' },
          message: { type: 'string', nullable: true },
          context: { type: 'object', nullable: true },
          triggeredAt: { type: 'string', format: 'date-time' },
          acknowledgedAt: { type: 'string', format: 'date-time', nullable: true },
          acknowledgedBy: { type: 'string', format: 'uuid', nullable: true },
          acknowledgedByName: {
            type: 'string',
            nullable: true,
            description: 'Display name for acknowledgedBy. Null when the id no longer resolves to a user.'
          },
          resolvedAt: { type: 'string', format: 'date-time', nullable: true },
          resolvedBy: { type: 'string', format: 'uuid', nullable: true },
          resolvedByName: {
            type: 'string',
            nullable: true,
            description: 'Display name for resolvedBy. Null when the id no longer resolves to a user.'
          },
          resolutionNote: { type: 'string', nullable: true },
          suppressedUntil: { type: 'string', format: 'date-time', nullable: true }
        }
      },
      NotificationChannel: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          orgId: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          type: { type: 'string', enum: ['email', 'slack', 'teams', 'webhook', 'pagerduty', 'sms'] },
          config: { type: 'object', description: 'Channel-specific configuration' },
          enabled: { type: 'boolean' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' }
        }
      },
      EscalationPolicy: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          orgId: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          steps: { type: 'array', items: { type: 'object' } },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' }
        }
      },
      AlertSummary: {
        type: 'object',
        properties: {
          bySeverity: {
            type: 'object',
            properties: {
              critical: { type: 'integer' },
              high: { type: 'integer' },
              medium: { type: 'integer' },
              low: { type: 'integer' },
              info: { type: 'integer' }
            }
          },
          byStatus: {
            type: 'object',
            properties: {
              active: { type: 'integer' },
              acknowledged: { type: 'integer' },
              resolved: { type: 'integer' },
              suppressed: { type: 'integer' }
            }
          },
          total: { type: 'integer' }
        }
      },
      ScriptAdmissionTarget: {
        type: 'object',
        additionalProperties: false,
        required: ['requestedDeviceId', 'admission'],
        properties: {
          requestedDeviceId: { type: 'string', format: 'uuid' },
          admission: { type: 'string', enum: ['admitted', 'excluded', 'suppressed', 'denied'] },
          reasonCode: { type: 'string' },
          executionId: { type: 'string', format: 'uuid' },
          commandId: { type: 'string', format: 'uuid' },
          batchId: { type: 'string', format: 'uuid' }
        }
      },
      ScriptAdmissionResult: {
        type: 'object',
        additionalProperties: false,
        required: ['requestId', 'status', 'targets'],
        properties: {
          requestId: { type: 'string', format: 'uuid' },
          status: { type: 'string', enum: ['queued', 'partially_queued', 'rejected'] },
          targets: {
            type: 'array',
            items: { $ref: '#/components/schemas/ScriptAdmissionTarget' }
          }
        }
      },

      // Automation schemas
      Automation: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          orgId: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          description: { type: 'string', nullable: true },
          enabled: { type: 'boolean' },
          trigger: { type: 'object', description: 'Trigger configuration' },
          conditions: { type: 'object', nullable: true },
          actions: { type: 'object', description: 'Actions to execute' },
          onFailure: { type: 'string', enum: ['stop', 'continue', 'notify'] },
          notificationTargets: { type: 'object', nullable: true },
          runCount: { type: 'integer' },
          lastRunAt: { type: 'string', format: 'date-time', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' }
        }
      },
      AutomationRun: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          automationId: { type: 'string', format: 'uuid' },
          triggeredBy: { type: 'string' },
          status: { type: 'string', enum: ['running', 'completed', 'failed', 'partial', 'cancelled'] },
          devicesTargeted: { type: 'integer' },
          devicesSucceeded: { type: 'integer' },
          devicesFailed: { type: 'integer' },
          devicesCancelled: { type: 'integer' },
          logs: { type: 'array', items: { type: 'object' } },
          startedAt: { type: 'string', format: 'date-time' },
          completedAt: { type: 'string', format: 'date-time', nullable: true }
        }
      },
      Policy: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          orgId: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          description: { type: 'string', nullable: true },
          enabled: { type: 'boolean' },
          targets: { type: 'object', description: 'Target configuration' },
          rules: { type: 'array', items: { type: 'object' }, description: 'Policy rules' },
          enforcement: { type: 'string', enum: ['monitor', 'warn', 'enforce'] },
          checkIntervalMinutes: { type: 'integer' },
          remediationScriptId: { type: 'string', format: 'uuid', nullable: true },
          lastEvaluatedAt: { type: 'string', format: 'date-time', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' }
        }
      },
      PolicyCompliance: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          policyId: { type: 'string', format: 'uuid' },
          deviceId: { type: 'string', format: 'uuid' },
          status: { type: 'string', enum: ['compliant', 'non_compliant', 'pending', 'error'] },
          details: { type: 'object', nullable: true },
          lastCheckedAt: { type: 'string', format: 'date-time' },
          remediationAttempts: { type: 'integer' }
        }
      },

      // Report schemas
      Report: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          orgId: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          type: { type: 'string', enum: ['device_inventory', 'software_inventory', 'alert_summary', 'compliance', 'performance', 'executive_summary'] },
          config: { type: 'object' },
          schedule: { type: 'string', enum: ['one_time', 'daily', 'weekly', 'monthly'] },
          format: { type: 'string', enum: ['csv', 'pdf', 'excel'] },
          lastGeneratedAt: { type: 'string', format: 'date-time', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' }
        }
      },
      ReportRun: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          reportId: { type: 'string', format: 'uuid' },
          status: { type: 'string', enum: ['pending', 'running', 'completed', 'failed'] },
          startedAt: { type: 'string', format: 'date-time' },
          completedAt: { type: 'string', format: 'date-time', nullable: true },
          outputUrl: { type: 'string', nullable: true },
          errorMessage: { type: 'string', nullable: true },
          rowCount: { type: 'integer', nullable: true }
        }
      },

      // Remote Access schemas
      RemoteSession: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          deviceId: { type: 'string', format: 'uuid' },
          userId: { type: 'string', format: 'uuid' },
          type: { type: 'string', enum: ['terminal', 'desktop', 'file_transfer'] },
          status: { type: 'string', enum: ['pending', 'connecting', 'active', 'disconnected', 'failed'] },
          startedAt: { type: 'string', format: 'date-time', nullable: true },
          endedAt: { type: 'string', format: 'date-time', nullable: true },
          durationSeconds: { type: 'integer', nullable: true },
          bytesTransferred: { type: 'integer', nullable: true },
          recordingUrl: { type: 'string', nullable: true },
          createdAt: { type: 'string', format: 'date-time' }
        }
      },
      // Agent schemas
      EnrollmentRequest: {
        type: 'object',
        properties: {
          enrollmentKey: { type: 'string' },
          enrollmentSecret: { type: 'string' },
          hostname: { type: 'string' },
          osType: { type: 'string', enum: ['windows', 'macos', 'linux'] },
          osVersion: { type: 'string' },
          architecture: { type: 'string' },
          agentVersion: { type: 'string' },
          hardwareInfo: { $ref: '#/components/schemas/DeviceHardware' },
          networkInfo: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                mac: { type: 'string' },
                ip: { type: 'string' },
                isPrimary: { type: 'boolean' }
              }
            }
          }
        },
        required: ['enrollmentKey', 'hostname', 'osType', 'osVersion', 'architecture', 'agentVersion']
      },
      EnrollmentResponse: {
        type: 'object',
        properties: {
          agentId: { type: 'string' },
          deviceId: { type: 'string', format: 'uuid' },
          authToken: { type: 'string' },
          orgId: { type: 'string', format: 'uuid' },
          siteId: { type: 'string', format: 'uuid' },
          config: {
            type: 'object',
            properties: {
              heartbeatIntervalSeconds: { type: 'integer' },
              metricsCollectionIntervalSeconds: { type: 'integer' }
            }
          }
        }
      },
      HeartbeatRequest: {
        type: 'object',
        properties: {
          metrics: {
            type: 'object',
            properties: {
              cpuPercent: { type: 'number' },
              ramPercent: { type: 'number' },
              ramUsedMb: { type: 'integer' },
              diskPercent: { type: 'number' },
              diskUsedGb: { type: 'number' },
              diskActivityAvailable: { type: 'boolean' },
              diskReadBytes: { type: 'integer' },
              diskWriteBytes: { type: 'integer' },
              diskReadBps: { type: 'integer' },
              diskWriteBps: { type: 'integer' },
              diskReadOps: { type: 'integer' },
              diskWriteOps: { type: 'integer' },
              networkInBytes: { type: 'integer' },
              networkOutBytes: { type: 'integer' },
              processCount: { type: 'integer' }
            },
            required: ['cpuPercent', 'ramPercent', 'ramUsedMb', 'diskPercent', 'diskUsedGb']
          },
          status: { type: 'string', enum: ['ok', 'warning', 'error'] },
          agentVersion: { type: 'string' },
          pendingReboot: { type: 'boolean' },
          lastUser: { type: 'string' },
          uptime: { type: 'integer' }
        },
        required: ['metrics', 'status', 'agentVersion']
      },
      HeartbeatResponse: {
        type: 'object',
        properties: {
          commands: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', format: 'uuid' },
                type: { type: 'string' },
                payload: { type: 'object' }
              }
            }
          },
          configUpdate: { type: 'object', nullable: true },
          upgradeTo: { type: 'string', nullable: true }
        }
      },

      // mTLS schemas
      MtlsCertificate: {
        type: 'object',
        properties: {
          certificate: { type: 'string', description: 'PEM-encoded client certificate' },
          privateKey: { type: 'string', description: 'PEM-encoded private key' },
          expiresAt: { type: 'string', format: 'date-time', description: 'Certificate expiration timestamp' },
          serialNumber: { type: 'string', description: 'Certificate serial number' }
        },
        required: ['certificate', 'privateKey', 'expiresAt', 'serialNumber']
      },
      QuarantinedDevice: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          agentId: { type: 'string' },
          hostname: { type: 'string' },
          osType: { type: 'string', enum: ['windows', 'macos', 'linux'] },
          quarantinedAt: { type: 'string', format: 'date-time' },
          quarantinedReason: { type: 'string' }
        }
      },
      MtlsSettings: {
        type: 'object',
        properties: {
          certLifetimeDays: { type: 'integer', minimum: 1, maximum: 365, description: 'Certificate lifetime in days' },
          expiredCertPolicy: { type: 'string', enum: ['auto_reissue', 'quarantine'], description: 'Policy when a certificate expires' }
        },
        required: ['certLifetimeDays', 'expiredCertPolicy']
      },

      // API Key schemas
      ApiKey: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          prefix: { type: 'string', description: 'First 8 characters of the key for identification' },
          scopes: { type: 'array', items: { type: 'string' } },
          lastUsedAt: { type: 'string', format: 'date-time', nullable: true },
          expiresAt: { type: 'string', format: 'date-time', nullable: true },
          createdAt: { type: 'string', format: 'date-time' }
        }
      },

      // Audit schemas
      AuditLog: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          timestamp: { type: 'string', format: 'date-time' },
          actorType: { type: 'string', enum: [...ACTOR_TYPES] },
          actorId: { type: 'string', format: 'uuid' },
          actorEmail: { type: 'string' },
          action: { type: 'string' },
          resourceType: { type: 'string' },
          resourceId: { type: 'string', format: 'uuid' },
          resourceName: { type: 'string' },
          details: { type: 'object' },
          ipAddress: { type: 'string' },
          userAgent: { type: 'string' },
          result: { type: 'string', enum: [...AUDIT_RESULTS] }
        }
      }
    },
    parameters: {
      pageParam: {
        name: 'page',
        in: 'query',
        schema: { type: 'integer', default: 1 },
        description: 'Page number for pagination'
      },
      limitParam: {
        name: 'limit',
        in: 'query',
        schema: { type: 'integer', default: 50, maximum: 100 },
        description: 'Number of items per page'
      },
      orgIdParam: {
        name: 'orgId',
        in: 'query',
        schema: { type: 'string', format: 'uuid' },
        description: 'Filter by organization ID'
      },
      partnerIdParam: {
        name: 'partnerId',
        in: 'query',
        schema: { type: 'string', format: 'uuid' },
        description: 'Filter by partner ID (system scope only)'
      },
      idParam: {
        name: 'id',
        in: 'path',
        required: true,
        schema: { type: 'string', format: 'uuid' },
        description: 'Resource ID'
      }
    },
    responses: {
      NotFound: {
        description: 'Resource not found',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/Error' }
          }
        }
      },
      Unauthorized: {
        description: 'Authentication required',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/Error' }
          }
        }
      },
      Forbidden: {
        description: 'Access denied',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/Error' }
          }
        }
      },
      BadRequest: {
        description: 'Invalid request',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/Error' }
          }
        }
      },
      TooManyRequests: {
        description: 'Rate limit exceeded',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                error: { type: 'string' },
                retryAfter: { type: 'integer' }
              }
            }
          }
        }
      },
      ServerError: {
        description: 'Internal server error',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/Error' }
          }
        }
      },
      ServiceUnavailable: {
        description: 'Service temporarily unavailable (e.g., Redis down)',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/Error' }
          }
        }
      }
    }
  },
  // Global security is JWT-only: organization API keys (apiKeyAuth) authenticate only the
  // three surfaces named in the scheme description, so advertising apiKeyAuth globally
  // would be wrong for every documented path. Paths that accept a brz_ key declare it
  // in their own per-operation `security` array.
  security: [
    { bearerAuth: [] }
  ],
  paths: {
    // ============================================
    // AUTH ENDPOINTS
    // ============================================
    '/auth/register': {
      post: {
        operationId: 'registerUser',
        tags: ['Auth'],
        summary: 'Register a new user',
        description: 'Create a new user account. Rate limited to 5 requests per hour per IP.',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/RegisterRequest' }
            }
          }
        },
        responses: {
          '200': {
            description: 'Registration successful',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/LoginResponse' }
              }
            }
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '429': { $ref: '#/components/responses/TooManyRequests' }
        }
      }
    },
    '/auth/login': {
      post: {
        operationId: 'login',
        tags: ['Auth'],
        summary: 'Login',
        description: 'Authenticate with email and password. Returns JWT tokens or MFA challenge. If MFA is enabled, returns a tempToken that must be used with /auth/mfa/verify.',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/LoginRequest' }
            }
          }
        },
        responses: {
          '200': {
            description: 'Login successful',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/LoginResponse' }
              }
            }
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '429': { $ref: '#/components/responses/TooManyRequests' }
        }
      }
    },
    '/auth/logout': {
      post: {
        operationId: 'logout',
        tags: ['Auth'],
        summary: 'Logout',
        description: 'Invalidate the current session and revoke all tokens. Clears the refresh token cookie.',
        responses: {
          '200': {
            description: 'Logout successful',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Success' }
              }
            }
          }
        }
      }
    },
    '/auth/refresh': {
      post: {
        operationId: 'refreshTokens',
        tags: ['Auth'],
        summary: 'Refresh tokens',
        description: 'Issue a new access token using the refresh cookie. Requires the x-breeze-csrf header for CSRF protection. The old refresh token is rotated.',
        security: [],
        responses: {
          '200': {
            description: 'Tokens refreshed',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    tokens: { $ref: '#/components/schemas/Tokens' }
                  }
                }
              }
            }
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { description: 'CSRF validation failed' }
        }
      }
    },
    '/auth/mfa/setup': {
      post: {
        operationId: 'setupMfa',
        tags: ['Auth'],
        summary: 'Setup MFA',
        description: 'Initialize TOTP MFA setup. Returns a secret, QR code, and recovery codes. Must be confirmed with /auth/mfa/verify or /auth/mfa/enable.',
        responses: {
          '200': {
            description: 'MFA setup initiated',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/MfaSetupResponse' }
              }
            }
          },
          '400': { $ref: '#/components/responses/BadRequest' }
        }
      }
    },
    '/auth/mfa/verify': {
      post: {
        operationId: 'verifyMfa',
        tags: ['Auth'],
        summary: 'Verify MFA code',
        description: 'Verify MFA code during login (with tempToken) or to complete MFA setup (with Bearer token). Supports both TOTP and SMS methods.',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  code: { type: 'string', minLength: 6, maxLength: 6 },
                  tempToken: { type: 'string', description: 'Required for login MFA verification' }
                },
                required: ['code']
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'MFA verified',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/LoginResponse' }
              }
            }
          },
          // #4470: a rejected proof (wrong code) is 400 with a stable `code`
          // (`mfa_code_invalid`); 401 is reserved for a dead credential —
          // an invalid/expired tempToken or bearer.
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '429': { $ref: '#/components/responses/TooManyRequests' }
        }
      }
    },
    '/auth/mfa/disable': {
      post: {
        operationId: 'disableMfa',
        tags: ['Auth'],
        summary: 'Disable MFA',
        description: 'Disable MFA for the current user. Requires a valid MFA code (TOTP or SMS) plus the current password. May be blocked by organization policy requiring MFA. Disabling advances the user\'s MFA epoch and revokes every refresh token family, so all OTHER sessions are signed out; the calling session is replaced in the same response (new refresh/CSRF cookies plus `tokens.accessToken`) and must adopt it.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  code: { type: 'string', minLength: 6, maxLength: 6 },
                  currentPassword: { type: 'string', description: 'The account password, re-verified so a stolen access token alone cannot strip the second factor.' }
                },
                required: ['code', 'currentPassword']
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'MFA disabled and the calling session replaced',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    message: { type: 'string' },
                    tokens: {
                      type: 'object',
                      description: 'Replacement session for the caller. Install it before the next request — the previous access token is invalid from this point. Withheld on the rare post-commit install failure, in which case the client must re-authenticate.',
                      properties: {
                        accessToken: { type: 'string' },
                        expiresInSeconds: { type: 'integer' }
                      }
                    }
                  }
                }
              }
            }
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { description: 'Organization or partner policy still requires MFA for this user.' },
          '409': { description: 'Another authentication issuance is in flight, or MFA was disabled concurrently. No factor was removed.' },
          '428': { description: 'The client auth binding must be rotated before a session can be issued. Retry after re-bootstrapping the binding.' }
        }
      }
    },
    '/auth/forgot-password': {
      post: {
        operationId: 'forgotPassword',
        tags: ['Auth'],
        summary: 'Request password reset',
        description: 'Send password reset email. Always returns success to prevent email enumeration. Rate limited per IP.',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  email: { type: 'string', format: 'email' }
                },
                required: ['email']
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'Password reset request processed',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Success' }
              }
            }
          }
        }
      }
    },
    '/auth/reset-password': {
      post: {
        operationId: 'resetPassword',
        tags: ['Auth'],
        summary: 'Reset password',
        description: 'Reset password using the token from email. Invalidates all existing sessions and tokens.',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  token: { type: 'string' },
                  password: { type: 'string', minLength: 8 }
                },
                required: ['token', 'password']
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'Password reset successful',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Success' }
              }
            }
          },
          '400': { $ref: '#/components/responses/BadRequest' }
        }
      }
    },
    '/auth/me': {
      get: {
        operationId: 'getCurrentUser',
        tags: ['Auth'],
        summary: 'Get current user',
        description: 'Get the currently authenticated user profile including MFA status and phone verification.',
        responses: {
          '200': {
            description: 'Current user profile',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    user: { $ref: '#/components/schemas/User' }
                  }
                }
              }
            }
          },
          '401': { $ref: '#/components/responses/Unauthorized' }
        }
      }
    },
    '/auth/register-partner': {
      post: {
        operationId: 'registerPartner',
        tags: ['Auth'],
        summary: 'Register a new partner (MSP)',
        description:
          'Self-service MSP/company signup (email-first, SR2-21). This endpoint creates NOTHING: it parks a pending registration and sends a confirmation email. The partner, admin role, user, and auto-login session are created only when the confirmation link is opened (POST /auth/verify-email). The response is a uniform { success, message } — identical whether or not the address already has an account (anti-enumeration). Rate limited to 3 per hour per IP.',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  companyName: { type: 'string', minLength: 2, maxLength: 255 },
                  email: { type: 'string', format: 'email' },
                  password: { type: 'string', minLength: 8 },
                  name: { type: 'string', minLength: 1, maxLength: 255 },
                  acceptTerms: { type: 'boolean', description: 'Must be true' }
                },
                required: ['companyName', 'email', 'password', 'name', 'acceptTerms']
              }
            }
          }
        },
        responses: {
          '200': {
            description:
              'Confirmation email dispatched (or would have been). Uniform body — no account is created here and no session is returned; the same response is sent whether or not the address already exists.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', enum: [true] },
                    message: { type: 'string' }
                  },
                  required: ['success', 'message']
                }
              }
            }
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '429': { $ref: '#/components/responses/TooManyRequests' }
        }
      }
    },
    '/auth/change-password': {
      post: {
        operationId: 'changePassword',
        tags: ['Auth'],
        summary: 'Change password',
        description: 'Change the current user password. Requires current password verification. Invalidates all existing sessions.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  currentPassword: { type: 'string', minLength: 1 },
                  newPassword: { type: 'string', minLength: 8 }
                },
                required: ['currentPassword', 'newPassword']
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'Password changed successfully',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Success' }
              }
            }
          },
          // #4660 (extends #4470): a rejected `currentPassword` is 400 with a
          // stable `code` (`invalid_credentials`), alongside the pre-existing
          // 400s for a passwordless account and a too-weak new password. 401
          // is reserved for a dead bearer.
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          // #4746: current-password guesses are metered per user (5 / 5 min),
          // the same shared step-up limiter the MFA factor routes use.
          '429': { $ref: '#/components/responses/TooManyRequests' }
        }
      }
    },
    '/auth/mfa/enable': {
      post: {
        operationId: 'enableMfa',
        tags: ['Auth'],
        summary: 'Enable MFA (confirm setup)',
        description: 'Confirm TOTP MFA setup by providing the 6-digit code from the authenticator app. Requires a prior call to /auth/mfa/setup.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  code: { type: 'string', minLength: 6, maxLength: 6 }
                },
                required: ['code']
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'MFA enabled',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    recoveryCodes: { type: 'array', items: { type: 'string' } },
                    message: { type: 'string' }
                  }
                }
              }
            }
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' }
        }
      }
    },
    '/auth/mfa/sms/enable': {
      post: {
        operationId: 'enableSmsMfa',
        tags: ['Auth'],
        summary: 'Enable SMS MFA',
        description: 'Enable SMS-based MFA. Requires a verified phone number. May be blocked by organization policy.',
        responses: {
          '200': {
            description: 'SMS MFA enabled',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    recoveryCodes: { type: 'array', items: { type: 'string' } },
                    message: { type: 'string' }
                  }
                }
              }
            }
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '403': { $ref: '#/components/responses/Forbidden' }
        }
      }
    },
    '/auth/mfa/sms/send': {
      post: {
        operationId: 'sendSmsMfaCode',
        tags: ['Auth'],
        summary: 'Send SMS MFA code during login',
        description: 'Send an SMS verification code during the MFA login flow. Requires a valid tempToken from the login response.',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  tempToken: { type: 'string' }
                },
                required: ['tempToken']
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'SMS code sent',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Success' }
              }
            }
          },
          // #4470: a rejected proof (wrong code) is 400 with a stable `code`
          // (`mfa_code_invalid`); 401 is reserved for a dead credential —
          // an invalid/expired tempToken or bearer.
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '429': { $ref: '#/components/responses/TooManyRequests' }
        }
      }
    },
    '/auth/mfa/recovery-codes': {
      post: {
        operationId: 'regenerateRecoveryCodes',
        tags: ['Auth'],
        summary: 'Regenerate MFA recovery codes',
        description: 'Generate new recovery codes for the authenticated user. MFA must be enabled. Previous codes are invalidated. Rotation advances the user\'s MFA epoch and revokes every refresh token family, so all OTHER sessions are signed out; the calling session is replaced in the same response (new refresh/CSRF cookies plus `tokens.accessToken`) and must adopt it.',
        responses: {
          '200': {
            description: 'Recovery codes generated and the calling session replaced',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    recoveryCodes: { type: 'array', items: { type: 'string' } },
                    message: { type: 'string' },
                    tokens: {
                      type: 'object',
                      description: 'Replacement session for the caller. Install it before the next request — the previous access token is invalid from this point.',
                      properties: {
                        accessToken: { type: 'string' },
                        expiresInSeconds: { type: 'integer' }
                      }
                    }
                  }
                }
              }
            }
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '409': { description: 'Another authentication issuance is in flight, or MFA was disabled concurrently. No codes were rotated.' },
          '428': { description: 'The client auth binding must be rotated before a session can be issued. Retry after re-bootstrapping the binding.' }
        }
      }
    },
    '/auth/phone/verify': {
      post: {
        operationId: 'sendPhoneVerification',
        tags: ['Auth'],
        summary: 'Send phone verification code',
        description: 'Send a verification code to a phone number for SMS MFA setup. Requires authentication.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  phoneNumber: { type: 'string', description: 'E.164 format (e.g. +14155551234)' }
                },
                required: ['phoneNumber']
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'Verification code sent',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Success' }
              }
            }
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '429': { $ref: '#/components/responses/TooManyRequests' }
        }
      }
    },
    '/auth/phone/confirm': {
      post: {
        operationId: 'confirmPhoneVerification',
        tags: ['Auth'],
        summary: 'Confirm phone verification',
        description: 'Confirm a phone number by providing the verification code sent via SMS.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  phoneNumber: { type: 'string', description: 'E.164 format' },
                  code: { type: 'string', minLength: 6, maxLength: 6 }
                },
                required: ['phoneNumber', 'code']
              }
            }
          }
        },
        responses: {
          '200': {
            description:
              'Phone number verified. When the number REPLACED the one behind an already-active SMS factor, '
              + 'every session (including the caller\'s) is revoked and `sessionReplaced` is true; `tokens` then '
              + 'carries the replacement session the client must adopt, and is withheld only if the server could '
              + 'not install it — in which case the client must re-authenticate.',
            content: {
              'application/json': {
                schema: {
                  allOf: [
                    { $ref: '#/components/schemas/Success' },
                    {
                      type: 'object',
                      properties: {
                        sessionReplaced: { type: 'boolean' },
                        tokens: { $ref: '#/components/schemas/Tokens' }
                      }
                    }
                  ]
                }
              }
            }
          },
          // #4470: a rejected proof (wrong code) is 400 with a stable `code`
          // (`mfa_code_invalid`); 401 is reserved for a dead credential —
          // an invalid/expired tempToken or bearer.
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          // #5198: from the shared auth-issuance admission path on the
          // factor-replacement branch — another issuance is in flight or the
          // factor set changed concurrently (409), or the client auth binding
          // must be rotated first (428). Nothing was written in either case.
          '409': { description: 'Authentication issuance unavailable — nothing was written' },
          '428': { description: 'Client auth binding must be rotated before this write' },
          '429': { $ref: '#/components/responses/TooManyRequests' }
        }
      }
    },

    // ============================================
    // USER ENDPOINTS
    // ============================================
    '/users': {
      get: {
        operationId: 'listUsers',
        tags: ['Users'],
        summary: 'List users',
        description: 'Get all users in the current scope (partner or organization). Partner scope requires full organization access.',
        responses: {
          '200': {
            description: 'List of users',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/User' } }
                  }
                }
              }
            }
          },
          '403': { $ref: '#/components/responses/Forbidden' }
        }
      }
    },
    '/users/me': {
      get: {
        operationId: 'getUserProfile',
        tags: ['Users'],
        summary: 'Get current user',
        description: 'Get the currently authenticated user profile',
        responses: {
          '200': {
            description: 'Current user profile',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/User' }
              }
            }
          },
          '401': { $ref: '#/components/responses/Unauthorized' }
        }
      },
      patch: {
        operationId: 'updateUserProfile',
        tags: ['Users'],
        summary: 'Update current user',
        description: 'Update the current user profile (name, avatar)',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string', minLength: 1, maxLength: 255 },
                  avatarUrl: { type: 'string', nullable: true }
                }
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'Updated user profile',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/User' }
              }
            }
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' }
        }
      }
    },
    '/users/{id}': {
      get: {
        operationId: 'getUser',
        tags: ['Users'],
        summary: 'Get user',
        description: 'Get a specific user by ID',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'User details',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/User' }
              }
            }
          },
          '404': { $ref: '#/components/responses/NotFound' }
        }
      },
      patch: {
        operationId: 'updateUser',
        tags: ['Users'],
        summary: 'Update user',
        description: 'Update user name or status',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string', minLength: 1, maxLength: 255 },
                  status: { type: 'string', enum: ['active', 'invited', 'disabled'] }
                }
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'User updated',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/User' }
              }
            }
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '404': { $ref: '#/components/responses/NotFound' }
        }
      },
      delete: {
        operationId: 'removeUser',
        tags: ['Users'],
        summary: 'Remove user',
        description: 'Remove user from the current scope',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'User removed',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Success' }
              }
            }
          },
          '404': { $ref: '#/components/responses/NotFound' }
        }
      }
    },
    '/users/invite': {
      post: {
        operationId: 'inviteUser',
        tags: ['Users'],
        summary: 'Invite user',
        description: 'Invite a new user to the partner or organization. Sends an invitation email.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/InviteUserRequest' }
            }
          }
        },
        responses: {
          '201': {
            description: 'User invited',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/User' }
              }
            }
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '409': {
            description: 'User already exists',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' }
              }
            }
          }
        }
      }
    },
    '/users/resend-invite': {
      post: {
        operationId: 'resendInvite',
        tags: ['Users'],
        summary: 'Resend invitation',
        description: 'Resend the invitation email to a pending user',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  userId: { type: 'string', format: 'uuid' }
                },
                required: ['userId']
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'Invitation resent',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Success' }
              }
            }
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '404': { $ref: '#/components/responses/NotFound' }
        }
      }
    },
    '/users/roles': {
      get: {
        operationId: 'listRoles',
        tags: ['Users'],
        summary: 'List roles',
        description: 'Get available roles for the current scope (partner or organization)',
        responses: {
          '200': {
            description: 'List of roles',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/Role' } }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/users/{id}/role': {
      post: {
        operationId: 'assignRole',
        tags: ['Users'],
        summary: 'Assign role',
        description: 'Assign a role to a user within the current scope',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  roleId: { type: 'string', format: 'uuid' }
                },
                required: ['roleId']
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'Role assigned',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Success' }
              }
            }
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '404': { $ref: '#/components/responses/NotFound' }
        }
      }
    },

    // ============================================
    // ORGANIZATION ENDPOINTS
    // ============================================
    '/orgs/partners': {
      get: {
        operationId: 'listPartners',
        tags: ['Organizations'],
        summary: 'List partners',
        description: 'List all partners (system scope only)',
        parameters: [
          { $ref: '#/components/parameters/pageParam' },
          { $ref: '#/components/parameters/limitParam' }
        ],
        responses: {
          '200': {
            description: 'List of partners',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/Partner' } },
                    pagination: { $ref: '#/components/schemas/Pagination' }
                  }
                }
              }
            }
          }
        }
      },
      post: {
        operationId: 'createPartner',
        tags: ['Organizations'],
        summary: 'Create partner',
        description: 'Create a new partner (system scope only)',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string', minLength: 1 },
                  slug: { type: 'string', minLength: 1, maxLength: 100 },
                  type: { type: 'string', enum: ['msp', 'enterprise', 'internal'] },
                  plan: { type: 'string', enum: ['free', 'pro', 'enterprise', 'unlimited'] },
                  maxOrganizations: { type: 'integer', nullable: true },
                  maxDevices: { type: 'integer', nullable: true },
                  billingEmail: { type: 'string', format: 'email' }
                },
                required: ['name', 'slug']
              }
            }
          }
        },
        responses: {
          '201': {
            description: 'Partner created',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Partner' }
              }
            }
          },
          '400': { $ref: '#/components/responses/BadRequest' }
        }
      }
    },
    '/orgs/partners/{id}': {
      get: {
        operationId: 'getPartner',
        tags: ['Organizations'],
        summary: 'Get partner',
        description: 'Get partner details (system scope only)',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'Partner details',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Partner' }
              }
            }
          },
          '404': { $ref: '#/components/responses/NotFound' }
        }
      },
      patch: {
        operationId: 'updatePartner',
        tags: ['Organizations'],
        summary: 'Update partner',
        description: 'Update partner details (system scope only)',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'Partner updated',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Partner' }
              }
            }
          },
          '404': { $ref: '#/components/responses/NotFound' }
        }
      },
      delete: {
        operationId: 'deletePartner',
        tags: ['Organizations'],
        summary: 'Delete partner',
        description: 'Soft delete a partner (system scope only)',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'Partner deleted',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Success' }
              }
            }
          },
          '404': { $ref: '#/components/responses/NotFound' }
        }
      }
    },
    '/orgs/organizations': {
      get: {
        operationId: 'listOrganizations',
        tags: ['Organizations'],
        summary: 'List organizations',
        description: 'List organizations under the current partner (system scope can optionally filter by partnerId)',
        parameters: [
          { $ref: '#/components/parameters/partnerIdParam' },
          { $ref: '#/components/parameters/pageParam' },
          { $ref: '#/components/parameters/limitParam' }
        ],
        responses: {
          '200': {
            description: 'List of organizations',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/Organization' } },
                    pagination: { $ref: '#/components/schemas/Pagination' }
                  }
                }
              }
            }
          }
        }
      },
      post: {
        operationId: 'createOrganization',
        tags: ['Organizations'],
        summary: 'Create organization',
        description: 'Create a new organization under the current partner (system scope requires partnerId)',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  partnerId: { type: 'string', format: 'uuid' },
                  name: { type: 'string', minLength: 1 },
                  slug: { type: 'string', minLength: 1, maxLength: 100 },
                  type: { type: 'string', enum: ['customer', 'internal'] },
                  status: { type: 'string', enum: ['active', 'suspended', 'trial', 'churned', 'offboarding'] },
                  maxDevices: { type: 'integer', nullable: true },
                  contractStart: { type: 'string', format: 'date-time', nullable: true },
                  contractEnd: { type: 'string', format: 'date-time', nullable: true }
                },
                required: ['name', 'slug']
              }
            }
          }
        },
        responses: {
          '201': {
            description: 'Organization created',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Organization' }
              }
            }
          },
          '400': { $ref: '#/components/responses/BadRequest' }
        }
      }
    },
    '/orgs/organizations/{id}': {
      get: {
        operationId: 'getOrganization',
        tags: ['Organizations'],
        summary: 'Get organization',
        description: 'Get organization details',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'Organization details',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Organization' }
              }
            }
          },
          '404': { $ref: '#/components/responses/NotFound' }
        }
      },
      patch: {
        operationId: 'updateOrganization',
        tags: ['Organizations'],
        summary: 'Update organization',
        description: 'Update organization details',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'Organization updated',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Organization' }
              }
            }
          },
          '404': { $ref: '#/components/responses/NotFound' }
        }
      },
      delete: {
        operationId: 'deleteOrganization',
        tags: ['Organizations'],
        summary: 'Delete organization',
        description: 'Soft delete an organization',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'Organization deleted',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Success' }
              }
            }
          },
          '404': { $ref: '#/components/responses/NotFound' }
        }
      }
    },
    '/orgs/sites': {
      get: {
        operationId: 'listSites',
        tags: ['Organizations'],
        summary: 'List sites',
        description: 'List sites for an organization',
        parameters: [
          { $ref: '#/components/parameters/pageParam' },
          { $ref: '#/components/parameters/limitParam' },
          { name: 'orgId', in: 'query', required: true, schema: { type: 'string', format: 'uuid' } },
          {
            name: 'includeEnrollmentDefaults',
            in: 'query',
            required: false,
            description:
              "Set to '1' to also resolve the org's enrollment link defaults into the response. Off by default: it costs an extra settings read that holds a second pooled connection.",
            schema: { type: 'string', enum: ['1', 'true'] }
          }
        ],
        responses: {
          '200': {
            description: 'List of sites',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/Site' } },
                    pagination: { $ref: '#/components/schemas/Pagination' },
                    enrollmentDefaults: {
                      type: 'object',
                      description:
                        "The org's resolved enrollment link defaults. Present only when includeEnrollmentDefaults is set AND a single org is in scope. Rides along on this response so the Add Device modal can seed its pickers without a second round trip; omitted if the settings read fails.",
                      properties: {
                        ttlMinutes: { type: 'integer' },
                        deviceCount: { type: 'integer' },
                        maxTtlMinutes: { type: 'integer' }
                      },
                      required: ['ttlMinutes', 'deviceCount', 'maxTtlMinutes']
                    }
                  }
                }
              }
            }
          }
        }
      },
      post: {
        operationId: 'createSite',
        tags: ['Organizations'],
        summary: 'Create site',
        description: 'Create a new site within an organization',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  orgId: { type: 'string', format: 'uuid' },
                  name: { type: 'string', minLength: 1 },
                  timezone: { type: 'string', default: 'UTC' },
                  address: { type: 'object' },
                  contact: { type: 'object' }
                },
                required: ['orgId', 'name']
              }
            }
          }
        },
        responses: {
          '201': {
            description: 'Site created',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Site' }
              }
            }
          }
        }
      }
    },
    '/orgs/sites/{id}': {
      get: {
        operationId: 'getSite',
        tags: ['Organizations'],
        summary: 'Get site',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'Site details',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Site' }
              }
            }
          },
          '404': { $ref: '#/components/responses/NotFound' }
        }
      },
      patch: {
        operationId: 'updateSite',
        tags: ['Organizations'],
        summary: 'Update site',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'Site updated',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Site' }
              }
            }
          }
        }
      },
      delete: {
        operationId: 'deleteSite',
        tags: ['Organizations'],
        summary: 'Delete site',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'Site deleted',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Success' }
              }
            }
          }
        }
      }
    },

    // ============================================
    // DEVICE ENDPOINTS
    // ============================================
    '/devices': {
      get: {
        operationId: 'listDevices',
        tags: ['Devices'],
        summary: 'List devices',
        description: 'Get paginated list of devices with optional filters',
        parameters: [
          { $ref: '#/components/parameters/pageParam' },
          { $ref: '#/components/parameters/limitParam' },
          { $ref: '#/components/parameters/orgIdParam' },
          { name: 'siteId', in: 'query', schema: { type: 'string', format: 'uuid' } },
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['online', 'offline', 'maintenance', 'decommissioned'] } },
          { name: 'osType', in: 'query', schema: { type: 'string', enum: ['windows', 'macos', 'linux'] } },
          { name: 'search', in: 'query', schema: { type: 'string' }, description: 'Search by hostname' }
        ],
        responses: {
          '200': {
            description: 'List of devices',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/Device' } },
                    pagination: { $ref: '#/components/schemas/Pagination' }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/devices/{id}': {
      get: {
        operationId: 'getDevice',
        tags: ['Devices'],
        summary: 'Get device details',
        description: 'Get comprehensive device information including hardware, network, and recent metrics',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'Device details',
            content: {
              'application/json': {
                schema: {
                  allOf: [
                    { $ref: '#/components/schemas/Device' },
                    {
                      type: 'object',
                      properties: {
                        networkInterfaces: { type: 'array', items: { type: 'object' } },
                        recentMetrics: { type: 'array', items: { $ref: '#/components/schemas/DeviceMetrics' } },
                        groups: { type: 'array', items: { $ref: '#/components/schemas/DeviceGroup' } }
                      }
                    }
                  ]
                }
              }
            }
          },
          '404': { $ref: '#/components/responses/NotFound' }
        }
      },
      patch: {
        operationId: 'updateDevice',
        tags: ['Devices'],
        summary: 'Update device',
        description: 'Update device display name, site, or tags',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  displayName: { type: 'string', minLength: 1, maxLength: 255 },
                  siteId: { type: 'string', format: 'uuid' },
                  tags: { type: 'array', items: { type: 'string' } }
                }
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'Device updated',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Device' }
              }
            }
          }
        }
      },
      delete: {
        operationId: 'decommissionDevice',
        tags: ['Devices'],
        summary: 'Decommission device',
        description: 'Mark device as decommissioned (soft delete)',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'Device decommissioned',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Success' }
              }
            }
          }
        }
      }
    },
    '/devices/{id}/move-org': {
      post: {
        operationId: 'moveDeviceOrg',
        tags: ['Devices'],
        summary: 'Move device to a different organization',
        description: 'Relocate a device between organizations (and to a site within the new org) without uninstalling the agent. Requires partner or system scope, devices:write + organizations:write, and MFA. Cross-partner moves require system scope.',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['orgId', 'siteId'],
                properties: {
                  orgId: { type: 'string', format: 'uuid', description: 'Target organization id' },
                  siteId: { type: 'string', format: 'uuid', description: 'Target site id (must belong to target org)' },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Device moved',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    device: { $ref: '#/components/schemas/Device' },
                  },
                },
              },
            },
          },
          '400': { description: 'Invalid input (e.g. target site not in target org, target org equals source)' },
          '403': { description: 'Access denied (target org or cross-partner move without system scope)' },
          '404': { description: 'Device or target organization not found' },
        },
      },
    },
    '/devices/{id}/metrics': {
      get: {
        operationId: 'getDeviceMetrics',
        tags: ['Devices'],
        summary: 'Get device metrics',
        description: 'Get historical metrics data for a device',
        parameters: [
          { $ref: '#/components/parameters/idParam' },
          { name: 'startDate', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'endDate', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'interval', in: 'query', schema: { type: 'string', enum: ['1m', '5m', '1h', '1d'] } }
        ],
        responses: {
          '200': {
            description: 'Metrics data',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/DeviceMetrics' } },
                    interval: { type: 'string' },
                    startDate: { type: 'string', format: 'date-time' },
                    endDate: { type: 'string', format: 'date-time' }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/devices/{id}/software': {
      get: {
        operationId: 'getDeviceSoftware',
        tags: ['Devices'],
        summary: 'Get installed software',
        description: 'Get list of software installed on the device',
        parameters: [
          { $ref: '#/components/parameters/idParam' },
          { $ref: '#/components/parameters/pageParam' },
          { $ref: '#/components/parameters/limitParam' },
          { name: 'search', in: 'query', schema: { type: 'string' } }
        ],
        responses: {
          '200': {
            description: 'Software list',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { type: 'object' } },
                    pagination: { $ref: '#/components/schemas/Pagination' }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/devices/{id}/commands': {
      get: {
        operationId: 'getDeviceCommands',
        tags: ['Devices'],
        summary: 'Get command history',
        description: 'Get history of commands sent to the device',
        parameters: [
          { $ref: '#/components/parameters/idParam' },
          { $ref: '#/components/parameters/pageParam' },
          { $ref: '#/components/parameters/limitParam' }
        ],
        responses: {
          '200': {
            description: 'Command history',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/DeviceCommand' } },
                    pagination: { $ref: '#/components/schemas/Pagination' }
                  }
                }
              }
            }
          }
        }
      },
      post: {
        operationId: 'queueDeviceCommand',
        tags: ['Devices'],
        summary: 'Queue command',
        description: 'Queue a command for the device to execute. The command is delivered via WebSocket if the agent is connected.',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  type: { type: 'string', enum: ['script', 'reboot', 'shutdown', 'update'] },
                  payload: { type: 'object' }
                },
                required: ['type']
              }
            }
          }
        },
        responses: {
          '201': {
            description: 'Command queued',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/DeviceCommand' }
              }
            }
          }
        }
      }
    },
    '/devices/groups': {
      get: {
        operationId: 'listDeviceGroups',
        tags: ['Devices'],
        summary: 'List device groups',
        parameters: [
          { $ref: '#/components/parameters/pageParam' },
          { $ref: '#/components/parameters/limitParam' },
          { name: 'orgId', in: 'query', required: true, schema: { type: 'string', format: 'uuid' } }
        ],
        responses: {
          '200': {
            description: 'List of device groups',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/DeviceGroup' } },
                    pagination: { $ref: '#/components/schemas/Pagination' }
                  }
                }
              }
            }
          }
        }
      },
      post: {
        operationId: 'createDeviceGroup',
        tags: ['Devices'],
        summary: 'Create device group',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  orgId: { type: 'string', format: 'uuid' },
                  name: { type: 'string', minLength: 1, maxLength: 255 },
                  siteId: { type: 'string', format: 'uuid' },
                  type: { type: 'string', enum: ['static', 'dynamic'] },
                  rules: { type: 'object' },
                  parentId: { type: 'string', format: 'uuid' }
                },
                required: ['orgId', 'name', 'type']
              }
            }
          }
        },
        responses: {
          '201': {
            description: 'Group created',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/DeviceGroup' }
              }
            }
          }
        }
      }
    },

    // ============================================
    // CUSTOM FIELD DEFINITION IMPORT (#3257 W07)
    // ============================================
    '/custom-fields/import/preview': {
      post: {
        operationId: 'previewCustomFieldDefinitionImport',
        tags: ['Devices'],
        summary: 'Preview a custom-field definition import',
        description:
          'Annotate every submitted definition row against current state without writing anything. '
          + 'Requires organization, partner or system scope, devices:write and MFA; JWT only (an X-API-Key caller gets 401). '
          + 'Rows with ownerScope "partner" additionally require full partner org access — a batch containing one from a '
          + 'caller without it is refused 403 in full, matching POST /custom-fields.',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/CustomFieldDefinitionImportRequest' } } },
        },
        responses: {
          '200': {
            description: 'Annotated rows',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    rows: {
                      type: 'array',
                      items: {
                        allOf: [
                          { $ref: '#/components/schemas/CustomFieldDefinitionImportRow' },
                          {
                            type: 'object',
                            properties: {
                              index: { type: 'integer' },
                              annotation: {
                                type: 'string',
                                enum: ['create', 'already-exists', 'type-conflict', 'key-shadowed', 'org-not-found', 'partner-wide-denied'],
                                description:
                                  'create = no field owns this key on the row\'s axis; already-exists = same axis, same type (skipped at commit); '
                                  + 'type-conflict = same axis different type, or the key appears twice in the file; '
                                  + 'key-shadowed = the key is taken on the OTHER ownership axis (W03 anti-shadowing trigger); '
                                  + 'org-not-found = the organization is absent or out of reach; '
                                  + 'partner-wide-denied = the caller may not create all-organizations fields.',
                              },
                              existingId: { type: 'string', format: 'uuid', nullable: true },
                              existingType: { type: 'string', nullable: true },
                              conflictReason: { type: 'string' },
                            },
                          },
                        ],
                      },
                    },
                  },
                },
              },
            },
          },
          '400': { description: 'Invalid input (row cap exceeded, bad field key, organization row with no organizationId)' },
          '403': { description: 'Access denied to this partner, or partner-wide rows without full partner org access' },
        },
      },
    },
    '/custom-fields/import': {
      post: {
        operationId: 'commitCustomFieldDefinitionImport',
        tags: ['Devices'],
        summary: 'Commit a custom-field definition import',
        description:
          'Create the acknowledged definitions. Every annotation is RE-DERIVED against fresh state inside the request and a row '
          + 'whose annotation moved since preview is rejected with code "annotation-changed"; an "already-exists" acknowledgement '
          + 'must pin expectedDefinitionId or it is rejected with "match-changed". '
          + 'Always responds 200, even when errors[] is non-empty: a partial import must not read as a total failure.',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/CustomFieldDefinitionImportRequest' } } },
        },
        responses: {
          '200': {
            description: 'Import summary (may report per-row errors)',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    created: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          index: { type: 'integer' },
                          definitionId: { type: 'string', format: 'uuid' },
                          fieldKey: { type: 'string' },
                          ownerScope: { type: 'string', enum: ['partner', 'organization'] },
                          organizationId: { type: 'string', format: 'uuid', nullable: true },
                        },
                      },
                    },
                    skipped: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          index: { type: 'integer' },
                          definitionId: { type: 'string', format: 'uuid' },
                          fieldKey: { type: 'string' },
                          reason: { type: 'string', enum: ['already-exists'] },
                        },
                      },
                    },
                    errors: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          index: { type: 'integer' },
                          fieldKey: { type: 'string' },
                          error: { type: 'string' },
                          code: {
                            type: 'string',
                            enum: [
                              'org-not-found', 'type-conflict', 'key-shadowed', 'annotation-changed',
                              'match-changed', 'partner-wide-denied', 'write-failed',
                            ],
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          '400': { description: 'Invalid input (row cap exceeded, unpinned "already-exists" acknowledgement)' },
          '403': { description: 'Access denied to this partner, or partner-wide rows without full partner org access' },
        },
      },
    },

    // ============================================
    // DEVICE CUSTOM FIELD VALUE IMPORT (#3257 W08)
    // ============================================
    '/devices/custom-fields/import/preview': {
      post: {
        operationId: 'previewDeviceCustomFieldImport',
        tags: ['Devices'],
        summary: 'Preview a device custom-field value import',
        description:
          'Resolve each row to a device and annotate EVERY VALUE on it, without writing anything. '
          + 'Annotation is per value, not per row: the normal case is a row where most values land, one names a field '
          + 'this organization has never defined, and one fails type validation. '
          + 'Requires organization, partner or system scope, devices:write and MFA; JWT only (an X-API-Key caller gets 401).',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/DeviceCustomFieldImportRequest' } } },
        },
        responses: {
          '200': {
            description: 'Annotated rows',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    rows: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          index: { type: 'integer' },
                          outcome: {
                            type: 'string',
                            enum: ['matched', 'link-match', 'ambiguous', 'not-found', 'org-not-found', 'identity-conflict'],
                            description:
                              'How the DEVICE resolved. link-match = an existing device_external_links row (needs no acknowledgement); '
                              + 'ambiguous = several devices match and the operator must pick one explicitly — the importer never auto-selects; '
                              + 'identity-conflict = two identifiers each pinned a different device; '
                              + 'org-not-found = the organization is absent or out of reach (deliberately the same answer for both).',
                          },
                          deviceId: { type: 'string', format: 'uuid', nullable: true },
                          method: { type: 'string', enum: ['id', 'link', 'serial', 'hostname'], nullable: true },
                          organizationId: { type: 'string', format: 'uuid', nullable: true },
                          candidates: { type: 'array', items: { type: 'object' }, description: 'Ranked, for ambiguous / identity-conflict. Ranking is presentational and never selects.' },
                          conflictingMethods: { type: 'array', items: { type: 'string' } },
                          discardedIdentifiers: { type: 'array', items: { type: 'string' }, description: 'Identifiers the row supplied that carried no information (today: a serial on the agent junk denylist).' },
                          values: {
                            type: 'array',
                            items: {
                              type: 'object',
                              properties: {
                                target: { type: 'object' },
                                outcome: {
                                  type: 'string',
                                  enum: ['applied', 'skipped-already-set', 'no-definition', 'type-error', 'not-applicable-to-device', 'device-unresolved'],
                                  description:
                                    'skipped-already-set covers both an identical re-import and a differing value the default "skip" mode declines to overwrite; '
                                    + 'no-definition = run the DEFINITIONS import first; '
                                    + 'not-applicable-to-device = the definition is scoped to other deviceTypes; '
                                    + 'device-unresolved = the row itself did not resolve, so no value on it can be judged.',
                                },
                                reason: { type: 'string', enum: ['invalid_type', 'out_of_range', 'not_a_choice', 'too_long', 'invalid_date'] },
                                warning: { type: 'string', description: 'Advisory and orthogonal to outcome — e.g. a key that feeds the device\'s partner-integration stableIdentifiers.' },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          '400': { description: 'Invalid input (row cap or value cap exceeded, unknown mapping target)' },
          '403': { description: 'Access denied to this partner, MFA required, or missing devices:write' },
        },
      },
    },
    '/devices/custom-fields/import': {
      post: {
        operationId: 'commitDeviceCustomFieldImport',
        tags: ['Devices'],
        summary: 'Commit a device custom-field value import',
        description:
          'Write the acknowledged values. Device resolution and every value annotation are RE-DERIVED against fresh state '
          + 'inside the request and never taken from preview: a row whose outcome moved is rejected "annotation-changed", '
          + 'and an "ambiguous" acknowledgement must pin expectedDeviceId or it is rejected "match-unconfirmed" / "match-changed". '
          + 'Each row is written in its own transaction — its values, its durable external link and its warranty together — '
          + 'so a failure rolls back that device alone and later rows still commit. '
          + 'Always responds 200, even when errors[] is non-empty: a partial import must not read as a total failure.',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/DeviceCustomFieldImportRequest' } } },
        },
        responses: {
          '200': {
            description: 'Import summary (may report per-row errors)',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    appliedValues: { type: 'integer', description: 'Counts VALUES, not rows, so the total reconciles against the file.' },
                    skippedValues: { type: 'integer' },
                    failedValues: { type: 'integer' },
                    linksCreated: { type: 'integer' },
                    rows: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          index: { type: 'integer' },
                          deviceId: { type: 'string', format: 'uuid' },
                          organizationId: { type: 'string', format: 'uuid' },
                          method: { type: 'string', enum: ['id', 'link', 'serial', 'hostname'] },
                          externalSystem: { type: 'string', nullable: true },
                          applied: { type: 'integer' },
                          skipped: { type: 'integer' },
                          failed: { type: 'integer' },
                          appliedFieldKeys: { type: 'array', items: { type: 'string' }, description: 'Field KEYS only — a value never enters the audit payload.' },
                          warranty: { type: 'string', enum: ['applied', 'skipped-provider-owned', 'skipped-already-set', 'none'] },
                          linkCreated: { type: 'boolean' },
                        },
                      },
                    },
                    errors: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          index: { type: 'integer' },
                          error: { type: 'string' },
                          code: {
                            type: 'string',
                            enum: ['org-not-found', 'not-found', 'identity-conflict', 'annotation-changed', 'match-changed', 'match-unconfirmed', 'write-failed'],
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          '400': { description: 'Invalid input (row cap or value cap exceeded, unpinned "ambiguous" acknowledgement)' },
          '403': { description: 'Access denied to this partner, MFA required, or missing devices:write' },
        },
      },
    },

    // ============================================
    // SCRIPT ENDPOINTS
    // ============================================
    '/scripts': {
      get: {
        operationId: 'listScripts',
        tags: ['Scripts'],
        summary: 'List scripts',
        parameters: [
          { $ref: '#/components/parameters/pageParam' },
          { $ref: '#/components/parameters/limitParam' },
          { $ref: '#/components/parameters/orgIdParam' },
          { name: 'category', in: 'query', schema: { type: 'string' } },
          { name: 'osType', in: 'query', schema: { type: 'string', enum: ['windows', 'macos', 'linux'] } },
          { name: 'language', in: 'query', schema: { type: 'string', enum: ['powershell', 'bash', 'python', 'cmd'] } },
          { name: 'search', in: 'query', schema: { type: 'string' } },
          { name: 'includeSystem', in: 'query', schema: { type: 'string', enum: ['true', 'false'] } }
        ],
        responses: {
          '200': {
            description: 'List of scripts',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/Script' } },
                    pagination: { $ref: '#/components/schemas/Pagination' }
                  }
                }
              }
            }
          }
        }
      },
      post: {
        operationId: 'createScript',
        tags: ['Scripts'],
        summary: 'Create script',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  orgId: { type: 'string', format: 'uuid' },
                  name: { type: 'string', minLength: 1, maxLength: 255 },
                  description: { type: 'string' },
                  category: { type: 'string', maxLength: 100 },
                  osTypes: { type: 'array', items: { type: 'string', enum: ['windows', 'macos', 'linux'] }, minItems: 1 },
                  language: { type: 'string', enum: ['powershell', 'bash', 'python', 'cmd'] },
                  content: { type: 'string', minLength: 1 },
                  parameters: { type: 'object' },
                  timeoutSeconds: { type: 'integer', minimum: 1, maximum: 3600, default: 300 },
                  runAs: { type: 'string', enum: ['system', 'user', 'elevated'], default: 'system' }
                },
                required: ['name', 'osTypes', 'language', 'content']
              }
            }
          }
        },
        responses: {
          '201': {
            description: 'Script created',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Script' }
              }
            }
          }
        }
      }
    },
    '/scripts/{id}': {
      get: {
        operationId: 'getScript',
        tags: ['Scripts'],
        summary: 'Get script',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'Script details',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Script' }
              }
            }
          },
          '404': { $ref: '#/components/responses/NotFound' }
        }
      },
      put: {
        operationId: 'updateScript',
        tags: ['Scripts'],
        summary: 'Update script',
        description: 'Update script. Version is automatically incremented when content changes. Requires MFA.',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'Script updated',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Script' }
              }
            }
          }
        }
      },
      delete: {
        operationId: 'deleteScript',
        tags: ['Scripts'],
        summary: 'Delete script',
        description: 'Delete script (fails if active executions exist). Cannot delete system scripts unless system scope. Requires MFA.',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'Script deleted',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Success' }
              }
            }
          },
          '409': {
            description: 'Script has active executions',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' }
              }
            }
          }
        }
      }
    },
    '/scripts/{id}/execute': {
      post: {
        operationId: 'executeScript',
        tags: ['Scripts'],
        summary: 'Queue script execution',
        description: 'Authorize and admit a script for one or more devices. A 201 response reports queue admission per distinct requested target and is not evidence of terminal execution success. Requires MFA.',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  deviceIds: { type: 'array', items: { type: 'string', format: 'uuid' }, minItems: 1 },
                  parameters: { type: 'object' },
                  triggerType: { type: 'string', enum: ['manual', 'scheduled', 'alert', 'policy'] },
                  runAs: {
                    type: 'string',
                    enum: ['system', 'user'],
                    description: 'Optional execution context override'
                  }
                },
                required: ['deviceIds']
              }
            }
          }
        },
        responses: {
          '201': {
            description: 'Per-target queue admission result',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ScriptAdmissionResult' }
              }
            }
          }
        }
      }
    },
    '/scripts/{id}/executions': {
      get: {
        operationId: 'listScriptExecutions',
        tags: ['Scripts'],
        summary: 'List executions',
        description: 'List executions for a specific script',
        parameters: [
          { $ref: '#/components/parameters/idParam' },
          { $ref: '#/components/parameters/pageParam' },
          { $ref: '#/components/parameters/limitParam' },
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['pending', 'queued', 'running', 'completed', 'failed', 'timeout', 'cancelled'] } },
          { name: 'deviceId', in: 'query', schema: { type: 'string', format: 'uuid' } }
        ],
        responses: {
          '200': {
            description: 'List of executions',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/ScriptExecution' } },
                    pagination: { $ref: '#/components/schemas/Pagination' }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/scripts/executions/{id}': {
      get: {
        operationId: 'getScriptExecution',
        tags: ['Scripts'],
        summary: 'Get execution details',
        description: 'Get detailed execution information including stdout/stderr',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'Execution details',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ScriptExecution' }
              }
            }
          }
        }
      }
    },
    '/scripts/executions/{id}/cancel': {
      post: {
        operationId: 'cancelScriptExecution',
        tags: ['Scripts'],
        summary: 'Request a stop for an execution',
        description: 'Asks the device to stop a running script (#3525). The execution moves to the transient `cancelling` state and only becomes `cancelled` once the stop is proven — either the server retracted a command the device never received, or the agent reported the process terminated. Poll the execution for the final `status` and `cancelState`.',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  graceSeconds: {
                    type: 'integer',
                    minimum: 0,
                    maximum: 30,
                    default: 5,
                    description: 'Seconds to wait after SIGTERM before SIGKILL. No graceful phase on Windows.'
                  }
                }
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'Cancellation requested; the returned execution carries the current status and cancelState',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    execution: {
                      type: 'object',
                      properties: {
                        id: { type: 'string', format: 'uuid' },
                        status: { type: 'string', enum: ['pending', 'queued', 'running', 'cancelling', 'completed', 'failed', 'timeout', 'cancelled'] },
                        cancelState: { type: 'string', nullable: true, enum: ['requested', 'confirmed', 'unconfirmed', 'failed'] },
                        completedAt: { type: 'string', format: 'date-time', nullable: true }
                      }
                    }
                  }
                }
              }
            }
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
          // Changed from 400 in #3525 W02b: a terminal execution is a conflict,
          // not a malformed request.
          '409': { description: 'Execution is no longer cancellable (already terminal)' },
          '500': { description: 'Execution state is inconsistent (no paired script command); cancellation refused rather than stamped unproven' }
        }
      }
    },

    // ============================================
    // ALERT ENDPOINTS
    // ============================================
    '/alerts': {
      get: {
        operationId: 'listAlerts',
        tags: ['Alerts'],
        summary: 'List alerts',
        parameters: [
          { $ref: '#/components/parameters/pageParam' },
          { $ref: '#/components/parameters/limitParam' },
          { $ref: '#/components/parameters/orgIdParam' },
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['active', 'acknowledged', 'resolved', 'suppressed', 'dismissed'] } },
          { name: 'severity', in: 'query', schema: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] } },
          { name: 'deviceId', in: 'query', schema: { type: 'string', format: 'uuid' } },
          { name: 'startDate', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'endDate', in: 'query', schema: { type: 'string', format: 'date-time' } }
        ],
        responses: {
          '200': {
            description: 'List of alerts',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/Alert' } },
                    pagination: { $ref: '#/components/schemas/Pagination' }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/alerts/summary': {
      get: {
        operationId: 'getAlertSummary',
        tags: ['Alerts'],
        summary: 'Get alert summary',
        description: 'Get counts by severity and status',
        parameters: [{ $ref: '#/components/parameters/orgIdParam' }],
        responses: {
          '200': {
            description: 'Alert summary',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/AlertSummary' }
              }
            }
          }
        }
      }
    },
    '/alerts/{id}': {
      get: {
        operationId: 'getAlert',
        tags: ['Alerts'],
        summary: 'Get alert details',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'Alert details',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Alert' }
              }
            }
          }
        }
      }
    },
    '/alerts/{id}/acknowledge': {
      post: {
        operationId: 'acknowledgeAlert',
        tags: ['Alerts'],
        summary: 'Acknowledge alert',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'Alert acknowledged',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Alert' }
              }
            }
          }
        }
      }
    },
    '/alerts/{id}/resolve': {
      post: {
        operationId: 'resolveAlert',
        tags: ['Alerts'],
        summary: 'Resolve alert',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  note: { type: 'string' }
                }
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'Alert resolved',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Alert' }
              }
            }
          },
          '400': {
            description: 'Alert is dismissed and cannot be resolved',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' }
              }
            }
          },
          '409': {
            description:
              'The alert already reached a terminal status (resolved or dismissed) — ' +
              'either before this request, or because a concurrent caller won the ' +
              'compare-and-swap in between. This request did not perform the transition, ' +
              'so no alert.resolved event was published on its behalf. Re-read the alert ' +
              'to see which terminal status it landed in.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' }
              }
            }
          }
        }
      }
    },
    '/alerts/{id}/suppress': {
      post: {
        operationId: 'suppressAlert',
        tags: ['Alerts'],
        summary: 'Suppress alert',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  until: {
                    type: 'string',
                    format: 'date-time',
                    description: 'Absolute deadline the alert stays muted until. Omit for indefinite ("Forever") suppression.'
                  }
                }
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'Alert suppressed',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Alert' }
              }
            }
          }
        }
      }
    },
    '/alerts/rules': {
      get: {
        operationId: 'listAlertRules',
        tags: ['Alerts'],
        summary: 'List alert rules',
        parameters: [
          { $ref: '#/components/parameters/pageParam' },
          { $ref: '#/components/parameters/limitParam' },
          { $ref: '#/components/parameters/orgIdParam' },
          { name: 'enabled', in: 'query', schema: { type: 'string', enum: ['true', 'false'] } },
          { name: 'severity', in: 'query', schema: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] } }
        ],
        responses: {
          '200': {
            description: 'List of alert rules',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/AlertRule' } },
                    pagination: { $ref: '#/components/schemas/Pagination' }
                  }
                }
              }
            }
          }
        }
      },
      post: {
        operationId: 'createAlertRule',
        tags: ['Alerts'],
        summary: 'Create alert rule',
        description: 'Create a new alert rule with trigger conditions and notification settings.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  orgId: { type: 'string', format: 'uuid' },
                  name: { type: 'string', minLength: 1 },
                  description: { type: 'string' },
                  enabled: { type: 'boolean', default: true },
                  severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
                  targets: { type: 'object', description: 'Target devices, sites, or groups' },
                  conditions: { type: 'object', description: 'Alert trigger conditions (metric thresholds, etc.)' },
                  cooldownMinutes: { type: 'integer', default: 15 },
                  escalationPolicyId: { type: 'string', format: 'uuid' },
                  notificationChannels: { type: 'array', items: { type: 'string', format: 'uuid' } },
                  autoResolve: { type: 'boolean', default: false }
                },
                required: ['orgId', 'name', 'severity', 'conditions']
              }
            }
          }
        },
        responses: {
          '201': {
            description: 'Rule created',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/AlertRule' }
              }
            }
          }
        }
      }
    },
    '/alerts/channels': {
      get: {
        operationId: 'listNotificationChannels',
        tags: ['Alerts'],
        summary: 'List notification channels',
        parameters: [
          { $ref: '#/components/parameters/pageParam' },
          { $ref: '#/components/parameters/limitParam' },
          { $ref: '#/components/parameters/orgIdParam' },
          { name: 'type', in: 'query', schema: { type: 'string', enum: ['email', 'slack', 'teams', 'webhook', 'pagerduty', 'sms'] } }
        ],
        responses: {
          '200': {
            description: 'List of channels',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/NotificationChannel' } },
                    pagination: { $ref: '#/components/schemas/Pagination' }
                  }
                }
              }
            }
          }
        }
      },
      post: {
        operationId: 'createNotificationChannel',
        tags: ['Alerts'],
        summary: 'Create notification channel',
        description: 'Create a new notification channel (email, Slack, Teams, webhook, PagerDuty, or SMS).',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  orgId: { type: 'string', format: 'uuid' },
                  name: { type: 'string', minLength: 1 },
                  type: { type: 'string', enum: ['email', 'slack', 'teams', 'webhook', 'pagerduty', 'sms'] },
                  config: { type: 'object', description: 'Channel-specific configuration (e.g., webhookUrl, apiKey)' },
                  enabled: { type: 'boolean', default: true }
                },
                required: ['orgId', 'name', 'type', 'config']
              }
            }
          }
        },
        responses: {
          '201': {
            description: 'Channel created',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/NotificationChannel' }
              }
            }
          }
        }
      }
    },
    '/alerts/channels/{id}/test': {
      post: {
        operationId: 'testNotificationChannel',
        tags: ['Alerts'],
        summary: 'Test notification channel',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'Test result',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    channelId: { type: 'string', format: 'uuid' },
                    testResult: { type: 'object' },
                    testedAt: { type: 'string', format: 'date-time' }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/alerts/policies': {
      get: {
        operationId: 'listEscalationPolicies',
        tags: ['Alerts'],
        summary: 'List escalation policies',
        responses: {
          '200': {
            description: 'List of policies',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/EscalationPolicy' } },
                    pagination: { $ref: '#/components/schemas/Pagination' }
                  }
                }
              }
            }
          }
        }
      },
      post: {
        operationId: 'createEscalationPolicy',
        tags: ['Alerts'],
        summary: 'Create escalation policy',
        responses: {
          '201': {
            description: 'Policy created',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/EscalationPolicy' }
              }
            }
          }
        }
      }
    },

    // ============================================
    // AUTOMATION ENDPOINTS
    // ============================================
    '/automations': {
      get: {
        operationId: 'listAutomations',
        tags: ['Automations'],
        summary: 'List automations',
        parameters: [
          { $ref: '#/components/parameters/pageParam' },
          { $ref: '#/components/parameters/limitParam' },
          { $ref: '#/components/parameters/orgIdParam' },
          { name: 'enabled', in: 'query', schema: { type: 'string', enum: ['true', 'false'] } }
        ],
        responses: {
          '200': {
            description: 'List of automations',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/Automation' } },
                    pagination: { $ref: '#/components/schemas/Pagination' }
                  }
                }
              }
            }
          }
        }
      },
      post: {
        operationId: 'createAutomation',
        tags: ['Automations'],
        summary: 'Create automation',
        responses: {
          '201': {
            description: 'Automation created',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Automation' }
              }
            }
          }
        }
      }
    },
    '/automations/{id}': {
      get: {
        operationId: 'getAutomation',
        tags: ['Automations'],
        summary: 'Get automation',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'Automation details with run history',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Automation' }
              }
            }
          }
        }
      },
      put: {
        operationId: 'updateAutomation',
        tags: ['Automations'],
        summary: 'Update automation',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'Automation updated',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Automation' }
              }
            }
          }
        }
      },
      delete: {
        operationId: 'deleteAutomation',
        tags: ['Automations'],
        summary: 'Delete automation',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'Automation deleted',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Success' }
              }
            }
          }
        }
      }
    },
    '/automations/{id}/trigger': {
      post: {
        operationId: 'triggerAutomation',
        tags: ['Automations'],
        summary: 'Trigger automation',
        description: 'Manually trigger an automation run',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'Automation triggered',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    message: { type: 'string' },
                    run: { $ref: '#/components/schemas/AutomationRun' }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/automations/{id}/runs': {
      get: {
        operationId: 'listAutomationRuns',
        tags: ['Automations'],
        summary: 'List automation runs',
        parameters: [
          { $ref: '#/components/parameters/idParam' },
          { $ref: '#/components/parameters/pageParam' },
          { $ref: '#/components/parameters/limitParam' },
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['running', 'completed', 'failed', 'partial', 'cancelled'] } }
        ],
        responses: {
          '200': {
            description: 'List of runs',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/AutomationRun' } },
                    pagination: { $ref: '#/components/schemas/Pagination' }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/automations/runs/{runId}/cancel': {
      post: {
        operationId: 'cancelAutomationRun',
        tags: ['Automations'],
        summary: 'Stop a running automation run',
        description: 'Stops an automation run (#3525). The run moves to `cancelled` immediately — that write is the dispatch fence, so no device that has not been dispatched yet ever will be. Devices already dispatched are asked to stop and close on their own evidence, so `devicesCancelled` only counts PROVEN stops and rises after this call returns. `execute_command` and `deploy_software` actions cannot be recalled at all and are reported in `uncancellableActions` rather than claimed stopped. Config-policy runs are out of scope and return 404.',
        parameters: [
          { name: 'runId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }
        ],
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  graceSeconds: {
                    type: 'integer',
                    minimum: 0,
                    maximum: 30,
                    default: 5,
                    description: 'Seconds each device waits after SIGTERM before SIGKILL. No graceful phase on Windows.'
                  }
                }
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'Cancellation requested. The counts describe what THIS call achieved, not that every device stopped.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    run: {
                      type: 'object',
                      properties: {
                        id: { type: 'string', format: 'uuid' },
                        status: { type: 'string', enum: ['cancelled'] }
                      }
                    },
                    alreadyCancelling: { type: 'boolean', description: 'The run had already been cancelled; the devices were asked again.' },
                    actionsCancelled: { type: 'integer', description: 'Action rows that had never been dispatched and are now terminal.' },
                    executionsStopped: { type: 'integer', description: 'Executions PROVEN stopped: the server retracted the command before the device saw it.' },
                    executionsRequested: { type: 'integer', description: 'Executions a stop was sent to. NOT yet stopped — the device has not confirmed and may never.' },
                    executions: {
                      type: 'object',
                      description: 'Per-kind breakdown of the script-execution sweep. Exactly one bucket per execution.',
                      properties: {
                        requested: { type: 'integer' },
                        retracted: { type: 'integer' },
                        alreadyCancelling: { type: 'integer' },
                        noActionNeeded: { type: 'integer' },
                        failed: { type: 'integer' }
                      }
                    },
                    uncancellableActions: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          actionIndex: { type: 'integer' },
                          actionType: { type: 'string' },
                          reason: { type: 'string' }
                        }
                      }
                    }
                  }
                }
              }
            }
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '403': { description: 'Partner-wide run and the caller cannot manage partner-wide state, or the run escapes the caller\'s site allowlist' },
          '404': { $ref: '#/components/responses/NotFound' },
          '409': { description: 'The run already finished on its own and cannot be relabelled cancelled' }
        }
      }
    },
    '/policies': {
      get: {
        operationId: 'listPolicies',
        tags: ['Policies'],
        summary: 'List policies',
        parameters: [
          { $ref: '#/components/parameters/pageParam' },
          { $ref: '#/components/parameters/limitParam' },
          { $ref: '#/components/parameters/orgIdParam' },
          { name: 'enforcement', in: 'query', schema: { type: 'string', enum: ['monitor', 'warn', 'enforce'] } },
          { name: 'enabled', in: 'query', schema: { type: 'string', enum: ['true', 'false'] } }
        ],
        responses: {
          '200': {
            description: 'List of policies',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/Policy' } },
                    pagination: { $ref: '#/components/schemas/Pagination' }
                  }
                }
              }
            }
          }
        }
      },
      post: {
        operationId: 'createPolicy',
        tags: ['Policies'],
        summary: 'Create policy',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  orgId: { type: 'string', format: 'uuid' },
                  name: { type: 'string' },
                  description: { type: 'string' },
                  enabled: { type: 'boolean' },
                  targets: { type: 'object' },
                  targetType: { type: 'string', enum: ['all', 'sites', 'groups', 'tags', 'devices'] },
                  targetIds: { type: 'array', items: { type: 'string' } },
                  rules: { type: 'array', items: { type: 'object' } },
                  enforcement: { type: 'string', enum: ['monitor', 'warn', 'enforce'] },
                  enforcementLevel: { type: 'string', enum: ['monitor', 'warn', 'enforce'] },
                  checkIntervalMinutes: { type: 'integer' },
                  remediationScriptId: { type: 'string', format: 'uuid' }
                },
                required: ['name', 'rules']
              }
            }
          }
        },
        responses: {
          '201': {
            description: 'Policy created',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Policy' }
              }
            }
          }
        }
      }
    },
    '/policies/compliance/stats': {
      get: {
        operationId: 'getPolicyComplianceStats',
        tags: ['Policies'],
        summary: 'Get policy compliance stats',
        parameters: [{ $ref: '#/components/parameters/orgIdParam' }],
        responses: {
          '200': {
            description: 'Policy compliance stats',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: {
                      type: 'object',
                      properties: {
                        complianceRate: { type: 'integer' },
                        complianceScore: { type: 'integer' },
                        totalPolicies: { type: 'integer' },
                        enabledPolicies: { type: 'integer' },
                        complianceOverview: { type: 'object' }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/policies/compliance/summary': {
      get: {
        operationId: 'getPolicyComplianceSummary',
        tags: ['Policies'],
        summary: 'Get policy compliance summary',
        parameters: [{ $ref: '#/components/parameters/orgIdParam' }],
        responses: {
          '200': {
            description: 'Policy compliance summary',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    totalPolicies: { type: 'integer' },
                    enabledPolicies: { type: 'integer' },
                    byEnforcement: { type: 'object' },
                    complianceOverview: { type: 'object' },
                    complianceRate: { type: 'integer' },
                    overall: { type: 'object' },
                    trend: { type: 'array', items: { type: 'object' } },
                    policies: { type: 'array', items: { type: 'object' } },
                    nonCompliantDevices: { type: 'array', items: { type: 'object' } }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/policies/{id}': {
      get: {
        operationId: 'getPolicy',
        tags: ['Policies'],
        summary: 'Get policy',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'Policy',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Policy' }
              }
            }
          }
        }
      },
      put: {
        operationId: 'updatePolicy',
        tags: ['Policies'],
        summary: 'Update policy',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'Updated policy',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Policy' }
              }
            }
          }
        }
      },
      patch: {
        operationId: 'patchPolicy',
        tags: ['Policies'],
        summary: 'Patch policy',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'Patched policy',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Policy' }
              }
            }
          }
        }
      },
      delete: {
        operationId: 'deletePolicy',
        tags: ['Policies'],
        summary: 'Delete policy',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'Policy deleted',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Success' }
              }
            }
          }
        }
      }
    },
    '/policies/{id}/activate': {
      post: {
        operationId: 'activatePolicy',
        tags: ['Policies'],
        summary: 'Activate policy',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'Policy activated',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Policy' }
              }
            }
          }
        }
      }
    },
    '/policies/{id}/deactivate': {
      post: {
        operationId: 'deactivatePolicy',
        tags: ['Policies'],
        summary: 'Deactivate policy',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'Policy deactivated',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Policy' }
              }
            }
          }
        }
      }
    },
    '/policies/{id}/evaluate': {
      post: {
        operationId: 'evaluatePolicy',
        tags: ['Policies'],
        summary: 'Evaluate policy',
        description: 'Force immediate policy evaluation',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'Evaluation completed',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    message: { type: 'string' },
                    policyId: { type: 'string', format: 'uuid' },
                    devicesEvaluated: { type: 'integer' },
                    results: { type: 'array', items: { type: 'object' } },
                    summary: { type: 'object' },
                    evaluatedAt: { type: 'string', format: 'date-time' }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/policies/{id}/compliance': {
      get: {
        operationId: 'getPolicyCompliance',
        tags: ['Policies'],
        summary: 'Get policy compliance',
        parameters: [
          { $ref: '#/components/parameters/idParam' },
          { $ref: '#/components/parameters/pageParam' },
          { $ref: '#/components/parameters/limitParam' },
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['compliant', 'non_compliant', 'pending', 'error'] } }
        ],
        responses: {
          '200': {
            description: 'Compliance status for policy',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/PolicyCompliance' } },
                    pagination: { $ref: '#/components/schemas/Pagination' },
                    overall: { type: 'object' },
                    trend: { type: 'array', items: { type: 'object' } },
                    policies: { type: 'array', items: { type: 'object' } },
                    nonCompliantDevices: { type: 'array', items: { type: 'object' } }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/policies/{id}/remediate': {
      post: {
        operationId: 'triggerPolicyRemediation',
        tags: ['Policies'],
        summary: 'Trigger policy remediation',
        description: 'Trigger remediation automation for a policy without running a full evaluation',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'Remediation automation triggered',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    message: { type: 'string' },
                    policyId: { type: 'string', format: 'uuid' },
                    automationId: { type: 'string', format: 'uuid' },
                    run: { type: 'object' }
                  }
                }
              }
            }
          }
        }
      }
    },

    // ============================================
    // REPORT ENDPOINTS
    // ============================================
    '/reports': {
      get: {
        operationId: 'listReports',
        tags: ['Reports'],
        summary: 'List reports',
        parameters: [
          { $ref: '#/components/parameters/pageParam' },
          { $ref: '#/components/parameters/limitParam' },
          { $ref: '#/components/parameters/orgIdParam' },
          { name: 'type', in: 'query', schema: { type: 'string', enum: ['device_inventory', 'software_inventory', 'alert_summary', 'compliance', 'performance', 'executive_summary'] } },
          { name: 'schedule', in: 'query', schema: { type: 'string', enum: ['one_time', 'daily', 'weekly', 'monthly'] } }
        ],
        responses: {
          '200': {
            description: 'List of reports',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/Report' } },
                    pagination: { $ref: '#/components/schemas/Pagination' }
                  }
                }
              }
            }
          }
        }
      },
      post: {
        operationId: 'createReport',
        tags: ['Reports'],
        summary: 'Create report',
        responses: {
          '201': {
            description: 'Report created',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Report' }
              }
            }
          }
        }
      }
    },
    '/reports/generate': {
      post: {
        operationId: 'generateAdHocReport',
        tags: ['Reports'],
        summary: 'Generate ad-hoc report',
        description: 'Generate a report immediately without saving the configuration',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  type: { type: 'string', enum: ['device_inventory', 'software_inventory', 'alert_summary', 'compliance', 'performance', 'executive_summary'] },
                  config: { type: 'object' },
                  format: { type: 'string', enum: ['csv', 'pdf', 'excel'], default: 'csv' },
                  orgId: { type: 'string', format: 'uuid' }
                },
                required: ['type']
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'Report data',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    type: { type: 'string' },
                    format: { type: 'string' },
                    generatedAt: { type: 'string', format: 'date-time' },
                    data: { type: 'object' }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/reports/{id}/generate': {
      post: {
        operationId: 'generateSavedReport',
        tags: ['Reports'],
        summary: 'Generate saved report',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'Report generation started',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    message: { type: 'string' },
                    runId: { type: 'string', format: 'uuid' },
                    status: { type: 'string' }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/reports/runs': {
      get: {
        operationId: 'listReportRuns',
        tags: ['Reports'],
        summary: 'List report runs',
        parameters: [
          { $ref: '#/components/parameters/pageParam' },
          { $ref: '#/components/parameters/limitParam' },
          { name: 'reportId', in: 'query', schema: { type: 'string', format: 'uuid' } },
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['pending', 'running', 'completed', 'failed'] } }
        ],
        responses: {
          '200': {
            description: 'List of report runs',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/ReportRun' } },
                    pagination: { $ref: '#/components/schemas/Pagination' }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/reports/data/device-inventory': {
      get: {
        operationId: 'getDeviceInventoryData',
        tags: ['Reports'],
        summary: 'Get device inventory data',
        parameters: [
          { $ref: '#/components/parameters/orgIdParam' },
          { name: 'siteId', in: 'query', schema: { type: 'string', format: 'uuid' } }
        ],
        responses: {
          '200': {
            description: 'Device inventory data',
            content: {
              'application/json': {
                schema: { type: 'object' }
              }
            }
          }
        }
      }
    },

    // ============================================
    // REMOTE ACCESS ENDPOINTS
    // ============================================
    '/remote/sessions': {
      get: {
        operationId: 'listRemoteSessions',
        tags: ['Remote'],
        summary: 'List remote sessions',
        parameters: [
          { $ref: '#/components/parameters/pageParam' },
          { $ref: '#/components/parameters/limitParam' },
          { name: 'deviceId', in: 'query', schema: { type: 'string', format: 'uuid' } },
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['pending', 'connecting', 'active', 'disconnected', 'failed'] } },
          { name: 'type', in: 'query', schema: { type: 'string', enum: ['terminal', 'desktop', 'file_transfer'] } },
          { name: 'includeEnded', in: 'query', schema: { type: 'string', enum: ['true', 'false'] } }
        ],
        responses: {
          '200': {
            description: 'List of sessions',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/RemoteSession' } },
                    pagination: { $ref: '#/components/schemas/Pagination' }
                  }
                }
              }
            }
          }
        }
      },
      post: {
        operationId: 'initiateRemoteSession',
        tags: ['Remote'],
        summary: 'Initiate remote session',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  deviceId: { type: 'string', format: 'uuid' },
                  type: { type: 'string', enum: ['terminal', 'desktop', 'file_transfer'] }
                },
                required: ['deviceId', 'type']
              }
            }
          }
        },
        responses: {
          '201': {
            description: 'Session created',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/RemoteSession' }
              }
            }
          },
          '429': { $ref: '#/components/responses/TooManyRequests' }
        }
      }
    },
    '/remote/sessions/{id}': {
      get: {
        operationId: 'getRemoteSession',
        tags: ['Remote'],
        summary: 'Get session details',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'Session details',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/RemoteSession' }
              }
            }
          }
        }
      }
    },
    '/remote/sessions/{id}/offer': {
      post: {
        operationId: 'submitWebRtcOffer',
        tags: ['Remote'],
        summary: 'Submit WebRTC offer',
        description: 'Submit WebRTC SDP offer from client',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  offer: { type: 'string' }
                },
                required: ['offer']
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'Offer submitted',
            content: {
              'application/json': {
                schema: { type: 'object' }
              }
            }
          }
        }
      }
    },
    '/remote/sessions/{id}/answer': {
      post: {
        operationId: 'submitWebRtcAnswer',
        tags: ['Remote'],
        summary: 'Submit WebRTC answer',
        description: 'Submit WebRTC SDP answer from agent',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'Answer submitted',
            content: {
              'application/json': {
                schema: { type: 'object' }
              }
            }
          }
        }
      }
    },
    '/remote/sessions/{id}/ice': {
      post: {
        operationId: 'addIceCandidate',
        tags: ['Remote'],
        summary: 'Add ICE candidate',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'ICE candidate added',
            content: {
              'application/json': {
                schema: { type: 'object' }
              }
            }
          }
        }
      }
    },
    '/remote/sessions/{id}/end': {
      post: {
        operationId: 'endRemoteSession',
        tags: ['Remote'],
        summary: 'End session',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'Session ended',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/RemoteSession' }
              }
            }
          }
        }
      }
    },
    // ============================================
    // AGENT ENDPOINTS
    // ============================================
    '/agents/enroll': {
      post: {
        operationId: 'enrollAgent',
        tags: ['Agents'],
        summary: 'Enroll agent',
        description: 'Register a new agent with an enrollment key',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/EnrollmentRequest' }
            }
          }
        },
        responses: {
          '201': {
            description: 'Agent enrolled',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/EnrollmentResponse' }
              }
            }
          },
          '401': {
            description: 'Invalid enrollment key',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' }
              }
            }
          }
        }
      }
    },
    '/agents/{id}/heartbeat': {
      post: {
        operationId: 'agentHeartbeat',
        tags: ['Agents'],
        summary: 'Agent heartbeat',
        description: 'Send heartbeat with metrics and receive pending commands',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Agent ID' }
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/HeartbeatRequest' }
            }
          }
        },
        responses: {
          '200': {
            description: 'Heartbeat processed',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/HeartbeatResponse' }
              }
            }
          },
          '404': { $ref: '#/components/responses/NotFound' }
        }
      }
    },
    '/agents/{id}/commands/{commandId}/result': {
      post: {
        operationId: 'submitCommandResult',
        tags: ['Agents'],
        summary: 'Submit command result',
        description: 'Report the result of a command execution',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'commandId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', enum: ['completed', 'failed', 'timeout'] },
                  exitCode: { type: 'integer' },
                  stdout: { type: 'string' },
                  stderr: { type: 'string' },
                  durationMs: { type: 'integer' },
                  error: { type: 'string' }
                },
                required: ['status', 'durationMs']
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'Result recorded',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Success' }
              }
            }
          }
        }
      }
    },
    '/agents/{id}/config': {
      get: {
        operationId: 'getAgentConfig',
        tags: ['Agents'],
        summary: 'Get agent config',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } }
        ],
        responses: {
          '200': {
            description: 'Agent configuration',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    heartbeatIntervalSeconds: { type: 'integer' },
                    metricsCollectionIntervalSeconds: { type: 'integer' },
                    enabledCollectors: { type: 'array', items: { type: 'string' } }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/agents/{id}/hardware': {
      put: {
        operationId: 'updateAgentHardware',
        tags: ['Agents'],
        summary: 'Update hardware info',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } }
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/DeviceHardware' }
            }
          }
        },
        responses: {
          '200': {
            description: 'Hardware info updated',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Success' }
              }
            }
          }
        }
      }
    },

    // ============================================
    // MTLS ENDPOINTS
    // ============================================
    '/agents/renew-cert': {
      post: {
        operationId: 'renewMtlsCert',
        tags: ['Agents'],
        summary: 'Renew mTLS client certificate',
        description: 'Request a new mTLS client certificate. This endpoint is excluded from mTLS WAF rules.',
        responses: {
          '200': {
            description: 'New certificate issued',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    mtls: { $ref: '#/components/schemas/MtlsCertificate' }
                  }
                }
              }
            }
          },
          '401': {
            description: 'Invalid credentials',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' }
              }
            }
          },
          '403': {
            description: 'Device is quarantined or decommissioned',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    error: { type: 'string' },
                    quarantined: { type: 'boolean' }
                  },
                  required: ['error', 'quarantined']
                }
              }
            }
          }
        }
      }
    },
    '/agents/quarantined': {
      get: {
        operationId: 'listQuarantinedDevices',
        tags: ['Agents'],
        summary: 'List quarantined devices',
        description: 'List quarantined devices in the authenticated user\'s org scope.',
        responses: {
          '200': {
            description: 'Quarantined devices',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    devices: { type: 'array', items: { $ref: '#/components/schemas/QuarantinedDevice' } }
                  }
                }
              }
            }
          },
          '401': { $ref: '#/components/responses/Unauthorized' }
        }
      }
    },
    '/agents/{id}/approve': {
      post: {
        operationId: 'approveQuarantinedDevice',
        tags: ['Agents'],
        summary: 'Approve quarantined device',
        description: 'Approve a quarantined device. Issues a new mTLS certificate and sets status to online.',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' }, description: 'Device UUID' }
        ],
        responses: {
          '200': {
            description: 'Device approved',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', example: true },
                    mtls: {
                      nullable: true,
                      allOf: [{ $ref: '#/components/schemas/MtlsCertificate' }],
                      description: 'New mTLS certificate if mTLS is enabled, null otherwise'
                    }
                  }
                }
              }
            }
          },
          '400': {
            description: 'Device is not quarantined',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' }
              }
            }
          },
          '404': { $ref: '#/components/responses/NotFound' }
        }
      }
    },
    '/agents/{id}/deny': {
      post: {
        operationId: 'denyQuarantinedDevice',
        tags: ['Agents'],
        summary: 'Deny quarantined device',
        description: 'Deny a quarantined device. Sets status to decommissioned.',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' }, description: 'Device UUID' }
        ],
        responses: {
          '200': {
            description: 'Device denied',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Success' }
              }
            }
          },
          '400': {
            description: 'Device is not quarantined',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' }
              }
            }
          },
          '404': { $ref: '#/components/responses/NotFound' }
        }
      }
    },
    '/agents/org/{orgId}/settings/mtls': {
      patch: {
        operationId: 'updateMtlsSettings',
        tags: ['Organizations'],
        summary: 'Update mTLS settings',
        description: 'Update mTLS certificate settings for an organization.',
        parameters: [
          { name: 'orgId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' }, description: 'Organization UUID' }
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/MtlsSettings' }
            }
          }
        },
        responses: {
          '200': {
            description: 'Settings updated',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', example: true },
                    settings: { $ref: '#/components/schemas/MtlsSettings' }
                  }
                }
              }
            }
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '404': { $ref: '#/components/responses/NotFound' }
        }
      }
    },

    // ============================================
    // AUDIT ENDPOINTS
    // ============================================
    '/audit/logs': {
      get: {
        operationId: 'queryAuditLogs',
        tags: ['Audit'],
        summary: 'Query audit logs',
        parameters: [
          { $ref: '#/components/parameters/pageParam' },
          { $ref: '#/components/parameters/limitParam' },
          { name: 'actorId', in: 'query', schema: { type: 'string', format: 'uuid' } },
          { name: 'actorType', in: 'query', schema: { type: 'string', enum: [...ACTOR_TYPES] } },
          { name: 'action', in: 'query', schema: { type: 'string' } },
          { name: 'resourceType', in: 'query', schema: { type: 'string' } },
          { name: 'resourceId', in: 'query', schema: { type: 'string', format: 'uuid' } },
          { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'result', in: 'query', schema: { type: 'string', enum: [...AUDIT_RESULTS] } }
        ],
        responses: {
          '200': {
            description: 'Audit logs',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/AuditLog' } },
                    pagination: { $ref: '#/components/schemas/Pagination' }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/audit/logs/export': {
      get: {
        operationId: 'exportAuditLogs',
        tags: ['Audit'],
        summary: 'Export audit logs',
        parameters: [
          { name: 'format', in: 'query', schema: { type: 'string', enum: ['json', 'csv'], default: 'json' } },
          { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } }
        ],
        responses: {
          '200': {
            description: 'Exported audit logs',
            content: {
              'application/json': {
                schema: { type: 'object' }
              },
              'text/csv': {
                schema: { type: 'string' }
              }
            }
          }
        }
      }
    },
    '/audit/summary': {
      get: {
        operationId: 'getAuditSummary',
        tags: ['Audit'],
        summary: 'Get activity summary',
        parameters: [
          { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } }
        ],
        responses: {
          '200': {
            description: 'Activity summary',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    totalActions: { type: 'integer' },
                    byAction: { type: 'object' },
                    byActor: { type: 'array', items: { type: 'object' } },
                    byResource: { type: 'object' },
                    recentActivity: { type: 'array', items: { type: 'object' } }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/audit/logs/{id}': {
      get: {
        operationId: 'getAuditLogEntry',
        tags: ['Audit'],
        summary: 'Get audit log entry',
        parameters: [{ $ref: '#/components/parameters/idParam' }],
        responses: {
          '200': {
            description: 'Audit log entry',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/AuditLog' }
              }
            }
          }
        }
      }
    }
  }
} as const;

export type OpenApiSpec = typeof openApiSpec;
