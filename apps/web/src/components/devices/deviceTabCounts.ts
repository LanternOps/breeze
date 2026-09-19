/** Shape of GET /devices/:id/tab-counts — one "needs attention" count per
 *  signal tab on the device detail page (see apps/api routes/devices/tabCounts.ts). */
export type DeviceTabCounts = {
  alerts: number;
  anomalies: number;
  tickets: number;
  operatorTasks: number;
  monitoring: number;
  compliance: number;
};
