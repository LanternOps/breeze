import { z } from 'zod';

const nonEmptyString = z.string().min(1);

/**
 * Context handed to an extension's device-detail-tab slot component.
 */
export const deviceDetailTabContextV1Schema = z.object({
  contractVersion: z.literal(1),
  deviceId: nonEmptyString,
  organizationId: nonEmptyString,
  siteId: nonEmptyString,
}).strict();

export type DeviceDetailTabContextV1 = z.infer<typeof deviceDetailTabContextV1Schema>;

export function parseDeviceDetailTabContextV1(input: unknown): DeviceDetailTabContextV1 {
  return deviceDetailTabContextV1Schema.parse(input);
}

/**
 * Context handed to a top-level extension page component.
 */
export const extensionPageContextV1Schema = z.object({
  contractVersion: z.literal(1),
  extensionName: nonEmptyString,
  path: nonEmptyString,
  organizationId: nonEmptyString,
}).strict();

export type ExtensionPageContextV1 = z.infer<typeof extensionPageContextV1Schema>;

export function parseExtensionPageContextV1(input: unknown): ExtensionPageContextV1 {
  return extensionPageContextV1Schema.parse(input);
}

/**
 * Context handed to an extension's organization-settings-section slot component.
 */
export const organizationSettingsSectionContextV1Schema = z.object({
  contractVersion: z.literal(1),
  organizationId: nonEmptyString,
}).strict();

export type OrganizationSettingsSectionContextV1 = z.infer<typeof organizationSettingsSectionContextV1Schema>;

export function parseOrganizationSettingsSectionContextV1(
  input: unknown,
): OrganizationSettingsSectionContextV1 {
  return organizationSettingsSectionContextV1Schema.parse(input);
}
