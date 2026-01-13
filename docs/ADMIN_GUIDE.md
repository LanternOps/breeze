# Breeze RMM Administrator Guide

This comprehensive guide covers all administrative functions in the Breeze RMM platform, including organization management, user administration, roles and permissions, SSO configuration, API keys, and audit compliance.

---

## Table of Contents

1. [Organization Setup](#1-organization-setup)
2. [User Management](#2-user-management)
3. [Roles & Permissions](#3-roles--permissions)
4. [SSO Configuration](#4-sso-configuration)
5. [API Keys](#5-api-keys)
6. [Audit & Compliance](#6-audit--compliance)
7. [System Settings](#7-system-settings)
8. [Troubleshooting](#8-troubleshooting)

---

## 1. Organization Setup

Breeze RMM uses a multi-tenant hierarchy designed for MSPs (Managed Service Providers) and enterprise IT teams. Understanding this structure is essential for proper platform administration.

### 1.1 Multi-Tenant Hierarchy

```
Partner (MSP)
  └── Organization (Customer)
        └── Site (Location)
              └── Device Group
                    └── Device
```

| Level | Description | Example |
|-------|-------------|---------|
| **Partner** | Top-level entity, typically an MSP or enterprise IT department | "Acme IT Services" |
| **Organization** | Customer account managed by the partner | "Contoso Corp" |
| **Site** | Physical location within an organization | "Headquarters", "Branch Office" |
| **Device Group** | Logical grouping of devices | "Windows Servers", "Finance Dept" |
| **Device** | Individual managed endpoint | "DESKTOP-ABC123" |

### 1.2 Partner Types

Partners can be configured with different types based on their business model:

| Type | Description | Use Case |
|------|-------------|----------|
| `msp` | Managed Service Provider | External IT companies managing multiple customers |
| `enterprise` | Enterprise IT | Large organizations with internal IT departments |
| `internal` | Internal | Breeze platform administrators |

### 1.3 Plan Types

Partners are assigned a plan that determines their feature access and limits:

| Plan | Max Organizations | Max Devices | Features |
|------|-------------------|-------------|----------|
| `free` | 1 | 25 | Basic monitoring |
| `pro` | 10 | 500 | Full monitoring + scripting |
| `enterprise` | Unlimited | 5,000 | All features + SSO + audit |
| `unlimited` | Unlimited | Unlimited | No restrictions |

### 1.4 Creating a Partner

**Required permissions:** System Administrator

Partners are created via the API:

```bash
POST /api/v1/orgs/partners
Content-Type: application/json
Authorization: Bearer <token>

{
  "name": "Acme IT Services",
  "slug": "acme-it",
  "type": "msp",
  "plan": "enterprise",
  "maxOrganizations": 100,
  "maxDevices": 10000,
  "billingEmail": "billing@acme-it.com",
  "settings": {
    "defaultTimezone": "America/New_York",
    "brandingEnabled": true
  }
}
```

### 1.5 Creating Organizations

**Required permissions:** Partner Administrator

Organizations represent your customers or business units:

```bash
POST /api/v1/orgs/organizations
Content-Type: application/json
Authorization: Bearer <token>

{
  "name": "Contoso Corporation",
  "slug": "contoso",
  "type": "customer",
  "status": "active",
  "maxDevices": 500,
  "contractStart": "2024-01-01T00:00:00Z",
  "contractEnd": "2024-12-31T23:59:59Z",
  "billingContact": {
    "name": "Jane Doe",
    "email": "jane@contoso.com",
    "phone": "+1-555-0100"
  }
}
```

#### Organization Statuses

| Status | Description |
|--------|-------------|
| `active` | Fully operational |
| `trial` | Trial period, may have limited features |
| `suspended` | Temporarily disabled (e.g., non-payment) |
| `churned` | Customer has left, read-only access |

### 1.6 Creating Sites

**Required permissions:** Organization Administrator or Partner Administrator

Sites represent physical locations:

```bash
POST /api/v1/orgs/sites
Content-Type: application/json
Authorization: Bearer <token>

{
  "orgId": "uuid-of-organization",
  "name": "Headquarters",
  "timezone": "America/New_York",
  "address": {
    "street": "123 Main Street",
    "city": "New York",
    "state": "NY",
    "zip": "10001",
    "country": "USA"
  },
  "contact": {
    "name": "Site Manager",
    "email": "site-manager@contoso.com",
    "phone": "+1-555-0101"
  }
}
```

### 1.7 Managing the Org Structure

#### Viewing Organizations

```bash
GET /api/v1/orgs/organizations
GET /api/v1/orgs/organizations/{id}
```

#### Updating Organizations

```bash
PATCH /api/v1/orgs/organizations/{id}
Content-Type: application/json

{
  "status": "suspended",
  "maxDevices": 1000
}
```

#### Deleting Organizations

Deletion is a soft-delete operation. The organization is marked as deleted but data is retained for audit purposes.

```bash
DELETE /api/v1/orgs/organizations/{id}
```

---

## 2. User Management

### 2.1 User Statuses

| Status | Description |
|--------|-------------|
| `invited` | User has been invited but has not yet set up their account |
| `active` | User account is fully active |
| `disabled` | User account has been deactivated |

### 2.2 Inviting Users

**Required permissions:** `users:invite`

To invite a new user to your organization:

```bash
POST /api/v1/users/invite
Content-Type: application/json
Authorization: Bearer <token>

{
  "email": "john.doe@example.com",
  "name": "John Doe",
  "roleId": "uuid-of-role",
  "orgAccess": "selected",
  "orgIds": ["uuid-of-org-1", "uuid-of-org-2"]
}
```

#### Partner-Level Users

Partner users can have different organization access levels:

| Access Level | Description |
|--------------|-------------|
| `all` | Access to all organizations under the partner |
| `selected` | Access only to specific organizations (requires `orgIds`) |
| `none` | No organization access (partner-level operations only) |

#### Organization-Level Users

Organization users can be restricted to specific sites:

```bash
{
  "email": "tech@contoso.com",
  "name": "Tech User",
  "roleId": "uuid-of-role",
  "siteIds": ["uuid-of-site-1"],
  "deviceGroupIds": ["uuid-of-group-1"]
}
```

### 2.3 Managing User Accounts

#### List Users

```bash
GET /api/v1/users
```

#### Get User Details

```bash
GET /api/v1/users/{id}
```

#### Update User

```bash
PATCH /api/v1/users/{id}
Content-Type: application/json

{
  "name": "John Smith",
  "status": "active"
}
```

### 2.4 Changing User Roles

```bash
POST /api/v1/users/{id}/role
Content-Type: application/json

{
  "roleId": "uuid-of-new-role"
}
```

### 2.5 Deactivating Users

To deactivate a user while preserving their data:

```bash
PATCH /api/v1/users/{id}
Content-Type: application/json

{
  "status": "disabled"
}
```

### 2.6 Reactivating Users

```bash
PATCH /api/v1/users/{id}
Content-Type: application/json

{
  "status": "active"
}
```

### 2.7 Removing Users

Removing a user removes their association with the partner/organization:

```bash
DELETE /api/v1/users/{id}
```

**Note:** This removes the user's membership but does not delete the user account if they belong to other organizations.

### 2.8 Resending Invitations

For users in `invited` status:

```bash
POST /api/v1/users/resend-invite
Content-Type: application/json

{
  "userId": "uuid-of-user"
}
```

---

## 3. Roles & Permissions

Breeze RMM uses a comprehensive Role-Based Access Control (RBAC) system with support for both system-defined and custom roles.

### 3.1 Understanding the RBAC System

#### Role Scopes

Roles exist at different scopes in the hierarchy:

| Scope | Description | Applies To |
|-------|-------------|------------|
| `system` | Platform-wide roles | Breeze administrators |
| `partner` | Partner-level roles | MSP/Enterprise users |
| `organization` | Organization-level roles | Customer organization users |

#### System vs Custom Roles

| Type | Description | Can Modify |
|------|-------------|------------|
| System Roles | Built-in roles provided by Breeze | No |
| Custom Roles | Roles created by administrators | Yes |

### 3.2 System Roles Overview

#### Partner-Level System Roles

| Role | Description |
|------|-------------|
| Partner Administrator | Full access to all partner and organization resources |
| Partner Manager | Can manage organizations and users, limited settings access |
| Partner Technician | Can manage devices and run scripts, no user management |
| Partner Viewer | Read-only access to all resources |

#### Organization-Level System Roles

| Role | Description |
|------|-------------|
| Organization Administrator | Full access to organization resources |
| Organization Manager | Can manage devices, users, and sites |
| Organization Technician | Can manage devices and run scripts |
| Organization Viewer | Read-only access to organization resources |

### 3.3 Permission Matrix

Permissions follow a `resource:action` pattern:

#### Available Resources

| Resource | Description |
|----------|-------------|
| `devices` | Managed endpoints |
| `scripts` | Script library and execution |
| `alerts` | Alert rules and instances |
| `automations` | Workflow automation |
| `reports` | Reports and dashboards |
| `users` | User management |
| `settings` | System and organization settings |
| `organizations` | Organization management |
| `sites` | Site management |
| `remote` | Remote access sessions |

#### Available Actions

| Action | Description |
|--------|-------------|
| `view` | Read access |
| `create` | Create new resources |
| `update` | Modify existing resources |
| `delete` | Remove resources |
| `execute` | Execute scripts/commands |

#### Full Permission Matrix

| Permission | Partner Admin | Partner Tech | Org Admin | Org Tech |
|------------|---------------|--------------|-----------|----------|
| `devices:view` | Yes | Yes | Yes | Yes |
| `devices:create` | Yes | Yes | Yes | Yes |
| `devices:update` | Yes | Yes | Yes | Yes |
| `devices:delete` | Yes | No | Yes | No |
| `devices:execute` | Yes | Yes | Yes | Yes |
| `scripts:view` | Yes | Yes | Yes | Yes |
| `scripts:create` | Yes | Yes | Yes | No |
| `scripts:update` | Yes | Yes | Yes | No |
| `scripts:delete` | Yes | No | Yes | No |
| `scripts:execute` | Yes | Yes | Yes | Yes |
| `users:view` | Yes | No | Yes | No |
| `users:create` | Yes | No | Yes | No |
| `users:update` | Yes | No | Yes | No |
| `users:delete` | Yes | No | Yes | No |
| `users:invite` | Yes | No | Yes | No |
| `organizations:view` | Yes | Yes | Yes | Yes |
| `organizations:create` | Yes | No | N/A | N/A |
| `organizations:update` | Yes | No | Yes | No |
| `organizations:delete` | Yes | No | Yes | No |
| `remote:access` | Yes | Yes | Yes | Yes |
| `audit:read` | Yes | No | Yes | No |
| `audit:export` | Yes | No | Yes | No |
| `*:*` (Admin) | Yes | No | Yes | No |

### 3.4 Creating Custom Roles

**Required permissions:** `users:write`

```bash
POST /api/v1/roles
Content-Type: application/json
Authorization: Bearer <token>

{
  "name": "Senior Technician",
  "description": "Technician with elevated permissions",
  "permissions": [
    { "resource": "devices", "action": "view" },
    { "resource": "devices", "action": "create" },
    { "resource": "devices", "action": "update" },
    { "resource": "devices", "action": "delete" },
    { "resource": "devices", "action": "execute" },
    { "resource": "scripts", "action": "view" },
    { "resource": "scripts", "action": "create" },
    { "resource": "scripts", "action": "execute" },
    { "resource": "remote", "action": "access" }
  ]
}
```

### 3.5 Cloning Existing Roles

A convenient way to create custom roles is to clone an existing role and modify it:

```bash
POST /api/v1/roles/{id}/clone
Content-Type: application/json

{
  "name": "Modified Technician Role"
}
```

### 3.6 Updating Custom Roles

```bash
PATCH /api/v1/roles/{id}
Content-Type: application/json

{
  "name": "Updated Role Name",
  "permissions": [
    { "resource": "devices", "action": "view" },
    { "resource": "devices", "action": "update" }
  ]
}
```

**Note:** System roles cannot be modified.

### 3.7 Deleting Custom Roles

Before deleting a role, you must reassign all users to a different role:

```bash
DELETE /api/v1/roles/{id}
```

**Note:** Deletion will fail if users are still assigned to the role.

### 3.8 Viewing Users by Role

```bash
GET /api/v1/roles/{id}/users
```

### 3.9 Role Inheritance

Roles do not inherit permissions from other roles. Each role explicitly defines its complete set of permissions. However, the scope hierarchy affects data access:

- **Partner-scope roles** can access resources across multiple organizations (based on `orgAccess` setting)
- **Organization-scope roles** can only access resources within their organization
- **Site restrictions** can further limit access for organization users

### 3.10 Best Practices for Role Design

1. **Principle of Least Privilege**: Assign the minimum permissions required for each role
2. **Separate Administrative and Operational Roles**: Keep user management separate from technical operations
3. **Use Site Restrictions**: For large organizations, restrict technicians to specific sites
4. **Regular Access Reviews**: Periodically review role assignments and permissions
5. **Document Custom Roles**: Maintain descriptions for custom roles explaining their purpose
6. **Clone Before Customizing**: Start with a system role and clone it rather than building from scratch

---

## 4. SSO Configuration

Breeze RMM supports Single Sign-On (SSO) via OpenID Connect (OIDC), with pre-configured presets for popular identity providers.

### 4.1 Supported Providers

| Provider | Type | Notes |
|----------|------|-------|
| **Microsoft Azure AD** | OIDC | Full support with auto-discovery |
| **Okta** | OIDC | Includes group sync support |
| **Google Workspace** | OIDC | Basic SSO authentication |
| **Auth0** | OIDC | Full support with custom domains |
| **Custom OIDC** | OIDC | Any OIDC-compliant provider |

### 4.2 SSO Provider Statuses

| Status | Description |
|--------|-------------|
| `inactive` | Provider is configured but not active |
| `testing` | Provider is being tested (limited users) |
| `active` | Provider is fully active for all users |

### 4.3 Setting Up OIDC

#### Step 1: View Available Presets

```bash
GET /api/v1/sso/presets
```

Response includes configuration templates for each supported provider.

#### Step 2: Create the Provider

**Azure AD Example:**

```bash
POST /api/v1/sso/providers
Content-Type: application/json
Authorization: Bearer <token>

{
  "name": "Corporate Azure AD",
  "type": "oidc",
  "preset": "azure-ad",
  "issuer": "https://login.microsoftonline.com/{tenant-id}/v2.0",
  "clientId": "your-client-id",
  "clientSecret": "your-client-secret",
  "scopes": "openid profile email",
  "autoProvision": true,
  "defaultRoleId": "uuid-of-default-role",
  "allowedDomains": "contoso.com,contoso.org",
  "enforceSSO": false
}
```

**Okta Example:**

```bash
{
  "name": "Okta SSO",
  "type": "oidc",
  "preset": "okta",
  "issuer": "https://your-domain.okta.com",
  "clientId": "your-client-id",
  "clientSecret": "your-client-secret",
  "scopes": "openid profile email groups",
  "autoProvision": true,
  "attributeMapping": {
    "email": "email",
    "name": "name",
    "firstName": "given_name",
    "lastName": "family_name",
    "groups": "groups"
  }
}
```

**Google Workspace Example:**

```bash
{
  "name": "Google Workspace",
  "type": "oidc",
  "preset": "google",
  "clientId": "your-client-id.apps.googleusercontent.com",
  "clientSecret": "your-client-secret",
  "autoProvision": true,
  "allowedDomains": "company.com"
}
```

### 4.4 Attribute Mapping

Map identity provider attributes to Breeze user fields:

| Breeze Field | Description | Common IdP Attributes |
|--------------|-------------|----------------------|
| `email` | User email address | `email`, `mail`, `upn` |
| `name` | Display name | `name`, `displayName` |
| `firstName` | First name | `given_name`, `firstName` |
| `lastName` | Last name | `family_name`, `lastName` |
| `groups` | Group memberships | `groups`, `roles` |

Default mapping:
```json
{
  "email": "email",
  "name": "name",
  "firstName": "given_name",
  "lastName": "family_name"
}
```

### 4.5 Auto-Provisioning Users

When `autoProvision` is enabled:

1. Users authenticating via SSO are automatically created in Breeze
2. New users are assigned the `defaultRoleId` role
3. Users are added to the organization associated with the SSO provider

Configure auto-provisioning:

```bash
PATCH /api/v1/sso/providers/{id}
Content-Type: application/json

{
  "autoProvision": true,
  "defaultRoleId": "uuid-of-viewer-role"
}
```

### 4.6 Domain Restrictions

Limit SSO access to specific email domains:

```bash
{
  "allowedDomains": "company.com,subsidiary.com"
}
```

Users with email addresses outside these domains will be denied access.

### 4.7 Testing SSO Configuration

Before activating SSO for all users:

```bash
POST /api/v1/sso/providers/{id}/test
```

This validates:
- OIDC discovery endpoint accessibility
- Endpoint URLs are correctly configured
- Provider responds to discovery requests

### 4.8 Activating SSO

```bash
POST /api/v1/sso/providers/{id}/status
Content-Type: application/json

{
  "status": "active"
}
```

### 4.9 Enforcing SSO

When `enforceSSO` is enabled:
- Password-based login is disabled for the organization
- Users must authenticate via SSO
- Local password reset is disabled

```bash
PATCH /api/v1/sso/providers/{id}
Content-Type: application/json

{
  "enforceSSO": true
}
```

**Warning:** Before enabling enforceSSO, ensure:
1. SSO is fully tested and working
2. At least one admin can access via SSO
3. You have a backup access plan (e.g., system admin account)

### 4.10 SSO Login Flow

1. User navigates to `/login` and selects SSO
2. System redirects to IdP authorization URL with PKCE challenge
3. User authenticates with IdP
4. IdP redirects back with authorization code
5. Breeze exchanges code for tokens
6. User info is retrieved and mapped
7. User is created/updated and logged in

### 4.11 Checking SSO Status for Organization

```bash
GET /api/v1/sso/check/{orgId}
```

Response:
```json
{
  "ssoEnabled": true,
  "provider": {
    "id": "uuid",
    "name": "Azure AD",
    "type": "oidc"
  },
  "enforceSSO": false,
  "loginUrl": "/api/v1/sso/login/{orgId}"
}
```

---

## 5. API Keys

API keys enable programmatic access to the Breeze RMM API for integrations, automation scripts, and third-party applications.

### 5.1 API Key Format

Breeze API keys follow this format:
```
brz_<32-character-random-string>
```

Example: `brz_Ab3dEf6gHi9jKlMnOpQrStUvWxYz12`

The prefix `brz_` identifies it as a Breeze API key, and the first 12 characters are stored as a key prefix for identification.

### 5.2 Creating API Keys

**Required permissions:** Organization, Partner, or System scope

```bash
POST /api/v1/api-keys
Content-Type: application/json
Authorization: Bearer <token>

{
  "orgId": "uuid-of-organization",
  "name": "Integration API Key",
  "scopes": ["devices:read", "devices:write", "scripts:execute"],
  "expiresAt": "2025-12-31T23:59:59Z",
  "rateLimit": 1000
}
```

**Important:** The full API key is only returned once at creation. Store it securely immediately.

Response:
```json
{
  "id": "uuid",
  "orgId": "uuid",
  "name": "Integration API Key",
  "key": "brz_Ab3dEf6gHi9jKlMnOpQrStUvWxYz12",
  "keyPrefix": "brz_Ab3dEf6g",
  "scopes": ["devices:read", "devices:write", "scripts:execute"],
  "expiresAt": "2025-12-31T23:59:59Z",
  "rateLimit": 1000,
  "createdAt": "2024-01-15T10:00:00Z",
  "status": "active",
  "warning": "Store this API key securely. It will not be shown again."
}
```

### 5.3 Scope Management

API keys use the same permission scopes as roles:

| Scope | Description |
|-------|-------------|
| `devices:read` | Read device information |
| `devices:write` | Create/update devices |
| `devices:execute` | Execute commands on devices |
| `scripts:read` | Read script library |
| `scripts:write` | Create/update scripts |
| `scripts:execute` | Execute scripts |
| `alerts:read` | Read alerts |
| `alerts:write` | Create/update alert rules |
| `reports:read` | Access reports |

**Best Practice:** Grant only the minimum required scopes for each integration.

### 5.4 Rate Limiting

Each API key has an individual rate limit:

| Setting | Description | Default |
|---------|-------------|---------|
| `rateLimit` | Maximum requests per hour | 1000 |

Rate limit headers are included in API responses:
```
X-RateLimit-Limit: 1000
X-RateLimit-Remaining: 987
X-RateLimit-Reset: 2024-01-15T11:00:00Z
```

Adjust rate limits based on integration needs:

```bash
PATCH /api/v1/api-keys/{id}
Content-Type: application/json

{
  "rateLimit": 5000
}
```

### 5.5 Key Rotation

Regularly rotate API keys to maintain security:

```bash
POST /api/v1/api-keys/{id}/rotate
```

This generates a new key and immediately invalidates the old one.

Response:
```json
{
  "id": "uuid",
  "key": "brz_NewKeyXyZ123AbCdEfGhIjKlMnOp",
  "keyPrefix": "brz_NewKeyXy",
  "warning": "Store this new API key securely. The old key has been invalidated."
}
```

**Recommended rotation frequency:** Every 90 days

### 5.6 Listing API Keys

```bash
GET /api/v1/api-keys?orgId={orgId}&status=active
```

**Note:** The full key value is never returned after creation.

### 5.7 Viewing API Key Details

```bash
GET /api/v1/api-keys/{id}
```

Response includes usage statistics:
```json
{
  "id": "uuid",
  "name": "Integration API Key",
  "keyPrefix": "brz_Ab3dEf6g",
  "scopes": ["devices:read"],
  "status": "active",
  "lastUsedAt": "2024-01-15T09:30:00Z",
  "usageCount": 1543,
  "rateLimit": 1000
}
```

### 5.8 Revoking API Keys

```bash
DELETE /api/v1/api-keys/{id}
```

Revocation is immediate and permanent. The key status changes to `revoked`.

### 5.9 API Key Statuses

| Status | Description |
|--------|-------------|
| `active` | Key is valid and can be used |
| `revoked` | Key has been manually revoked |
| `expired` | Key has passed its expiration date |

### 5.10 Security Best Practices

1. **Never expose API keys in client-side code**: Use server-side integrations only
2. **Use environment variables**: Store keys in secure environment configuration
3. **Implement key rotation**: Rotate keys at least every 90 days
4. **Monitor usage**: Regularly review `lastUsedAt` and `usageCount`
5. **Principle of least privilege**: Grant minimum required scopes
6. **Set expiration dates**: Avoid indefinite keys where possible
7. **Revoke unused keys**: Remove keys for retired integrations immediately
8. **Use separate keys per integration**: Don't share keys between systems

---

## 6. Audit & Compliance

Breeze RMM maintains comprehensive audit logs for security and compliance purposes.

### 6.1 Understanding Audit Logs

Every significant action in the system is logged with:

| Field | Description |
|-------|-------------|
| `timestamp` | When the action occurred (UTC) |
| `actorType` | Type of actor (`user`, `api_key`, `agent`, `system`) |
| `actorId` | Unique identifier of the actor |
| `actorEmail` | Email address (for user actors) |
| `action` | The action performed |
| `resourceType` | Type of resource affected |
| `resourceId` | Unique identifier of the resource |
| `resourceName` | Human-readable name of the resource |
| `details` | Additional action-specific data |
| `ipAddress` | Source IP address |
| `userAgent` | Browser/client information |
| `result` | Outcome (`success`, `failure`, `denied`) |
| `checksum` | Integrity verification hash |

### 6.2 Actor Types

| Type | Description | Examples |
|------|-------------|----------|
| `user` | Human user via web UI | Login, create device group |
| `api_key` | Programmatic via API key | Integration sync, automated script |
| `agent` | Breeze agent on endpoint | Heartbeat, metrics upload |
| `system` | Automated system process | Scheduled cleanup, alert trigger |

### 6.3 Common Actions

| Action | Description |
|--------|-------------|
| `auth.login` | User login attempt |
| `auth.logout` | User logout |
| `auth.mfa.enable` | MFA enabled |
| `user.create` | User account created |
| `user.update` | User account modified |
| `user.delete` | User account removed |
| `device.create` | Device enrolled |
| `device.update` | Device information updated |
| `device.delete` | Device removed |
| `device.script.execute` | Script executed on device |
| `device.remote.connect` | Remote session initiated |
| `script.create` | Script added to library |
| `script.update` | Script modified |
| `alert.create` | Alert rule created |
| `alert.acknowledge` | Alert acknowledged |
| `role.create` | Custom role created |
| `role.update` | Role permissions modified |
| `apikey.create` | API key generated |
| `apikey.revoke` | API key revoked |
| `sso.login` | SSO authentication |

### 6.4 Searching and Filtering Logs

```bash
GET /api/v1/audit/logs?page=1&limit=100&from=2024-01-01&to=2024-01-31
```

#### Available Filters

| Parameter | Description | Example |
|-----------|-------------|---------|
| `actorId` | Filter by specific actor | `actorId=uuid` |
| `actorType` | Filter by actor type | `actorType=user` |
| `action` | Filter by action | `action=auth.login` |
| `resourceType` | Filter by resource type | `resourceType=device` |
| `resourceId` | Filter by specific resource | `resourceId=uuid` |
| `result` | Filter by outcome | `result=failure` |
| `from` | Start date (ISO 8601) | `from=2024-01-01` |
| `to` | End date (ISO 8601) | `to=2024-01-31` |

#### Example Queries

**Failed login attempts:**
```bash
GET /api/v1/audit/logs?action=auth.login&result=failure&from=2024-01-01
```

**All actions by a specific user:**
```bash
GET /api/v1/audit/logs?actorId=uuid-of-user
```

**Device remote access sessions:**
```bash
GET /api/v1/audit/logs?action=device.remote.connect&resourceType=device
```

### 6.5 Exporting Audit Data

#### JSON Export

```bash
GET /api/v1/audit/logs/export?format=json&from=2024-01-01&to=2024-01-31
```

#### CSV Export

```bash
GET /api/v1/audit/logs/export?format=csv&from=2024-01-01&to=2024-01-31
```

CSV headers:
```
timestamp,actor_type,actor_email,action,resource_type,resource_name,result
```

### 6.6 Viewing Activity Summary

```bash
GET /api/v1/audit/summary?from=2024-01-01&to=2024-01-31
```

Response:
```json
{
  "totalActions": 15420,
  "byAction": {
    "auth.login": 342,
    "device.update": 8901,
    "script.execute": 2156
  },
  "byActor": [
    { "actorId": "uuid", "email": "admin@example.com", "count": 523 }
  ],
  "byResource": {
    "device": 10234,
    "script": 3456,
    "user": 245
  },
  "recentActivity": [...]
}
```

### 6.7 Access Reviews

Conduct periodic access reviews by:

1. **Export user list with roles:**
   ```bash
   GET /api/v1/users
   ```

2. **Review role assignments:**
   ```bash
   GET /api/v1/roles/{id}/users
   ```

3. **Check recent login activity:**
   ```bash
   GET /api/v1/audit/logs?action=auth.login&from=<90-days-ago>
   ```

4. **Identify inactive users:** Users with no login in 90+ days should be reviewed

5. **Review permission changes:**
   ```bash
   GET /api/v1/audit/logs?resourceType=role&from=<review-period>
   ```

### 6.8 Retention Policies

Configure audit log retention per organization:

| Setting | Description | Default |
|---------|-------------|---------|
| `retentionDays` | Days to retain logs | 365 |
| `archiveToS3` | Archive to S3 before deletion | false |

**Note:** Compliance requirements may dictate minimum retention periods:
- SOC 2: 1 year minimum
- HIPAA: 6 years
- PCI-DSS: 1 year

### 6.9 Compliance Reporting

For compliance audits, generate reports covering:

1. **Access Control:**
   - Current user/role matrix
   - Permission changes over review period
   - Privileged access usage

2. **Authentication:**
   - Login success/failure rates
   - MFA adoption rates
   - SSO usage statistics

3. **Data Access:**
   - Device access patterns
   - Script execution history
   - Remote session logs

4. **Changes:**
   - Configuration changes
   - Policy modifications
   - User account changes

---

## 7. System Settings

### 7.1 Global Settings

Global settings affect the entire Breeze deployment:

| Setting | Description | Default |
|---------|-------------|---------|
| `sessionTimeout` | User session timeout | 24 hours |
| `refreshTokenLifetime` | Refresh token validity | 7 days |
| `mfaRequired` | Require MFA for all users | false |
| `passwordPolicy` | Password complexity requirements | Standard |
| `ipAllowlist` | Restrict access by IP | Disabled |

### 7.2 Partner Settings

Partners can customize settings for their organizations:

```json
{
  "settings": {
    "defaultTimezone": "America/New_York",
    "brandingEnabled": true,
    "customLogo": "https://...",
    "supportEmail": "support@partner.com",
    "defaultAlertSettings": {
      "emailNotifications": true,
      "slackIntegration": false
    }
  }
}
```

### 7.3 Organization Settings

Organizations inherit partner settings but can override:

```json
{
  "settings": {
    "timezone": "Europe/London",
    "maintenanceWindows": [
      {
        "name": "Weekly Maintenance",
        "schedule": "0 2 * * SUN",
        "duration": 120
      }
    ],
    "alertRecipients": ["alerts@org.com"],
    "scriptApprovalRequired": true
  }
}
```

### 7.4 Notification Preferences

Configure notification channels at the organization level:

| Channel | Configuration |
|---------|--------------|
| Email | SMTP settings, recipient lists |
| Slack | Webhook URL, channel mapping |
| Microsoft Teams | Connector URL |
| Webhook | Custom HTTP endpoints |
| PagerDuty | Integration key |

### 7.5 Security Settings

#### MFA Enforcement

Enable mandatory MFA for all users:

```bash
PATCH /api/v1/settings/security
Content-Type: application/json

{
  "mfaRequired": true,
  "mfaGracePeriodDays": 7
}
```

Users without MFA will have a grace period to enable it.

#### Session Timeout

Configure session duration:

```bash
{
  "sessionTimeout": "8h",
  "idleTimeout": "30m"
}
```

#### IP Allowlisting

Restrict access to specific IP ranges:

```bash
{
  "ipAllowlist": {
    "enabled": true,
    "ranges": [
      "10.0.0.0/8",
      "192.168.1.0/24",
      "203.0.113.50/32"
    ]
  }
}
```

#### Password Policy

Configure password requirements:

```bash
{
  "passwordPolicy": {
    "minLength": 12,
    "requireUppercase": true,
    "requireLowercase": true,
    "requireNumbers": true,
    "requireSymbols": true,
    "preventReuse": 10,
    "expirationDays": 90
  }
}
```

### 7.6 Rate Limiting Configuration

Default rate limits protect the API from abuse:

| Endpoint | Limit | Window |
|----------|-------|--------|
| Login | 5 attempts | 5 minutes |
| Forgot Password | 3 requests | 1 hour |
| MFA Verification | 5 attempts | 5 minutes |
| API (per key) | Configurable | 1 hour |

---

## 8. Troubleshooting

### 8.1 Common Issues

#### Login Problems

**Issue:** User cannot log in

**Troubleshooting steps:**
1. Check user status is `active`
2. Verify email address is correct
3. Check for SSO enforcement (`enforceSSO: true`)
4. Review audit logs for `auth.login` failures
5. Check rate limiting (5 attempts per 5 minutes)

**Issue:** MFA not working

**Troubleshooting steps:**
1. Verify server time is synchronized
2. Check TOTP secret is correctly stored
3. Ensure authenticator app time is correct
4. Review audit logs for `auth.mfa.verify` failures

#### Permission Errors

**Issue:** User receives 403 Forbidden

**Troubleshooting steps:**
1. Verify user's current role
2. Check role has required permission
3. For partner users, check `orgAccess` setting
4. For org users, check `siteIds` restrictions
5. Review audit log for denied actions

#### SSO Issues

**Issue:** SSO login fails

**Troubleshooting steps:**
1. Test provider configuration: `POST /api/v1/sso/providers/{id}/test`
2. Check provider status is `active`
3. Verify client ID and secret are correct
4. Check allowed domains include user's email domain
5. Review callback URL configuration in IdP
6. Check browser console for CORS errors

**Issue:** SSO users not auto-provisioned

**Troubleshooting steps:**
1. Verify `autoProvision: true`
2. Check `defaultRoleId` is set
3. Verify attribute mapping is correct
4. Check allowed domains configuration

#### API Key Issues

**Issue:** API key returns 401 Unauthorized

**Troubleshooting steps:**
1. Verify key status is `active`
2. Check key hasn't expired (`expiresAt`)
3. Verify correct Authorization header format: `Authorization: Bearer brz_...`
4. Check rate limit hasn't been exceeded
5. Verify required scopes are assigned

### 8.2 Log Locations

#### API Server Logs

```
Location: stdout/stderr (containerized) or ./logs/api.log
Content: Request logs, errors, authentication events
```

#### Audit Logs

```
Location: PostgreSQL database (audit_logs table)
Query: GET /api/v1/audit/logs
Export: GET /api/v1/audit/logs/export
```

#### Agent Logs

```
Windows: C:\ProgramData\Breeze\logs\agent.log
macOS: /Library/Application Support/Breeze/logs/agent.log
Linux: /var/log/breeze/agent.log
```

### 8.3 Diagnostic Commands

**Check API health:**
```bash
curl https://api.breeze.local/health
```

**Verify database connectivity:**
```bash
pnpm db:studio
```

**Test Redis connection:**
```bash
redis-cli ping
```

**Check agent connectivity:**
```bash
curl https://api.breeze.local/api/v1/agents/health
```

### 8.4 Getting Support

#### Self-Service Resources

- Documentation: `/docs`
- API Reference: `/api/v1/docs` (OpenAPI/Swagger)
- Status Page: Check system status and incidents

#### Support Channels

| Plan | Support Level | Response Time |
|------|--------------|---------------|
| Free | Community forums | Best effort |
| Pro | Email support | 24 hours |
| Enterprise | Priority email + phone | 4 hours |
| Unlimited | Dedicated support | 1 hour |

#### Information to Include

When contacting support, provide:

1. **Environment details:**
   - Breeze version
   - Deployment type (cloud/self-hosted)
   - Browser/OS version

2. **Issue description:**
   - Steps to reproduce
   - Expected vs actual behavior
   - Screenshots or screen recordings

3. **Relevant logs:**
   - Audit log entries
   - Browser console errors
   - API response bodies

4. **Context:**
   - User role and permissions
   - Organization/site information
   - Recent changes

---

## Appendix A: API Quick Reference

### Authentication

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v1/auth/login` | POST | Email/password login |
| `/api/v1/auth/register` | POST | Create account |
| `/api/v1/auth/logout` | POST | End session |
| `/api/v1/auth/refresh` | POST | Refresh tokens |
| `/api/v1/auth/mfa/setup` | POST | Initialize MFA |
| `/api/v1/auth/mfa/verify` | POST | Verify MFA code |
| `/api/v1/auth/forgot-password` | POST | Request password reset |
| `/api/v1/auth/reset-password` | POST | Complete password reset |

### Organizations

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v1/orgs/partners` | GET/POST | List/create partners |
| `/api/v1/orgs/partners/:id` | GET/PATCH/DELETE | Manage partner |
| `/api/v1/orgs/organizations` | GET/POST | List/create organizations |
| `/api/v1/orgs/organizations/:id` | GET/PATCH/DELETE | Manage organization |
| `/api/v1/orgs/sites` | GET/POST | List/create sites |
| `/api/v1/orgs/sites/:id` | GET/PATCH/DELETE | Manage site |

### Users

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v1/users` | GET | List users |
| `/api/v1/users/:id` | GET/PATCH/DELETE | Manage user |
| `/api/v1/users/invite` | POST | Invite user |
| `/api/v1/users/resend-invite` | POST | Resend invitation |
| `/api/v1/users/:id/role` | POST | Assign role |

### Roles

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v1/roles` | GET/POST | List/create roles |
| `/api/v1/roles/:id` | GET/PATCH/DELETE | Manage role |
| `/api/v1/roles/:id/clone` | POST | Clone role |
| `/api/v1/roles/:id/users` | GET | List users with role |
| `/api/v1/roles/permissions/available` | GET | Get available permissions |

### SSO

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v1/sso/presets` | GET | List provider presets |
| `/api/v1/sso/providers` | GET/POST | List/create providers |
| `/api/v1/sso/providers/:id` | GET/PATCH/DELETE | Manage provider |
| `/api/v1/sso/providers/:id/status` | POST | Change provider status |
| `/api/v1/sso/providers/:id/test` | POST | Test configuration |
| `/api/v1/sso/login/:orgId` | GET | Initiate SSO login |
| `/api/v1/sso/callback` | GET | SSO callback |
| `/api/v1/sso/check/:orgId` | GET | Check SSO status |

### API Keys

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v1/api-keys` | GET/POST | List/create API keys |
| `/api/v1/api-keys/:id` | GET/PATCH/DELETE | Manage API key |
| `/api/v1/api-keys/:id/rotate` | POST | Rotate API key |

### Audit

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v1/audit/logs` | GET | Query audit logs |
| `/api/v1/audit/logs/:id` | GET | Get specific log entry |
| `/api/v1/audit/logs/export` | GET | Export logs |
| `/api/v1/audit/summary` | GET | Activity summary |

---

## Appendix B: Permission Reference

### Complete Permission List

| Resource | Actions |
|----------|---------|
| `devices` | view, create, update, delete, execute |
| `scripts` | view, create, update, delete, execute |
| `alerts` | view, create, update, delete, acknowledge |
| `automations` | view, create, update, delete, execute |
| `reports` | view, create, update, delete |
| `users` | view, create, update, delete, invite |
| `settings` | view, update |
| `organizations` | view, create, update, delete |
| `sites` | view, create, update, delete |
| `remote` | access |
| `audit` | read, export |
| `*` | * (administrator wildcard) |

---

*Last updated: January 2024*
*Breeze RMM Documentation*
