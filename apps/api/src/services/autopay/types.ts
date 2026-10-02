import type { db } from '../../db';
export type Tx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
export interface RenderedNotice {
  subject: string;
  html: string;
  text: string;
  frozen: Record<string, string | number | null>;
}
