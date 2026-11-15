import { deviceHardware } from '../db/schema';

/**
 * Every device_hardware column a generic read may return: all of them but the
 * TPM endorsement-key baseline (#8318 T1, spec 2026-10-12 §12.2). The EK hash
 * is evidence for a later reinstall, read only by the reattach comparison
 * (wave T2); it never reaches device detail, the hardware route or an AI
 * tool's output. Listed by hand so a module that mocks drizzle still loads;
 * `deviceHardwareColumns.test.ts` fails when a new column is missing here,
 * and on a whole-row `select().from(deviceHardware)` anywhere in the API.
 */
export const DEVICE_HARDWARE_READ_COLUMNS = {
  deviceId: deviceHardware.deviceId,
  orgId: deviceHardware.orgId,
  cpuModel: deviceHardware.cpuModel,
  cpuCores: deviceHardware.cpuCores,
  cpuThreads: deviceHardware.cpuThreads,
  ramTotalMb: deviceHardware.ramTotalMb,
  diskTotalGb: deviceHardware.diskTotalGb,
  gpuModel: deviceHardware.gpuModel,
  serialNumber: deviceHardware.serialNumber,
  productSku: deviceHardware.productSku,
  manufacturer: deviceHardware.manufacturer,
  model: deviceHardware.model,
  motherboardManufacturer: deviceHardware.motherboardManufacturer,
  motherboardProduct: deviceHardware.motherboardProduct,
  motherboardVersion: deviceHardware.motherboardVersion,
  biosVersion: deviceHardware.biosVersion,
  systemUuid: deviceHardware.systemUuid,
  memorySlotsTotal: deviceHardware.memorySlotsTotal,
  memoryMaxCapacityMb: deviceHardware.memoryMaxCapacityMb,
  memorySoldered: deviceHardware.memorySoldered,
  memoryObservedAt: deviceHardware.memoryObservedAt,
  tpmAttestedAt: deviceHardware.tpmAttestedAt,
  tpmAvailable: deviceHardware.tpmAvailable,
  updatedAt: deviceHardware.updatedAt,
  partnerExportUpdatedAt: deviceHardware.partnerExportUpdatedAt,
};
