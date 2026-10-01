// Recovery-readiness score bands (0-100). The API counts `lowReadiness` /
// `highReadiness`, raises the low-readiness alert and exports the metric from
// these; the web tiles and the Low Readiness Devices table read the same
// values so a device can never be "low" in one place and not the other.
// Leaf module, no imports.
export const BACKUP_LOW_READINESS_THRESHOLD = 70;
export const BACKUP_HIGH_READINESS_THRESHOLD = 85;
