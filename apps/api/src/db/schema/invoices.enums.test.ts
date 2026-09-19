import { describe, it, expect } from 'vitest';
import {
  INVOICE_STATUSES,
  PAYMENT_METHODS,
  INVOICE_LINE_SOURCE_TYPES,
  INVOICE_LINE_DEVICE_COUNTED_AS,
} from '@breeze/shared';
import {
  invoiceStatusEnum,
  invoiceLineSourceTypeEnum,
  invoiceLineDeviceCountedAsEnum,
  paymentMethodEnum,
} from './invoices';

describe('invoice pgEnum ⇄ @breeze/shared tuple parity', () => {
  it('invoice_status pgEnum equals the shared tuple (order-sensitive)', () => {
    expect(invoiceStatusEnum.enumValues).toEqual([...INVOICE_STATUSES]);
  });
  it('payment_method pgEnum equals the shared tuple (order-sensitive)', () => {
    expect(paymentMethodEnum.enumValues).toEqual([...PAYMENT_METHODS]);
  });
  it('invoice_line_source_type pgEnum equals the shared tuple (order-sensitive)', () => {
    expect(invoiceLineSourceTypeEnum.enumValues).toEqual([...INVOICE_LINE_SOURCE_TYPES]);
  });
  it('invoice_line_device_counted_as pgEnum equals the shared tuple (order-sensitive) (#3205 W07)', () => {
    expect(invoiceLineDeviceCountedAsEnum.enumValues).toEqual([...INVOICE_LINE_DEVICE_COUNTED_AS]);
  });
});
