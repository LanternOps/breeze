import type { Hono } from 'hono';
import { invoiceAutopayRoutes } from '../invoices/autopay';
export function mountAutopayChargingRoutes(api: Hono): void {
  api.route('/invoices', invoiceAutopayRoutes);
}
