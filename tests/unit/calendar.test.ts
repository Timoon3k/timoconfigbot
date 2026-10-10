import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { addCalendarMonthsUtc } from '../../src/domain/calendar.js';
import { MockPaymentProvider } from '../../src/payments/mock.js';

describe('calendar month handling', () => {
  it('clamps end-of-month dates and preserves the UTC instant fields', () => {
    expect(addCalendarMonthsUtc(new Date('2028-01-31T23:59:58.123Z')).toISOString()).toBe('2028-02-29T23:59:58.123Z');
    expect(addCalendarMonthsUtc(new Date('2027-01-31T10:00:00.000Z')).toISOString()).toBe('2027-02-28T10:00:00.000Z');
  });
});

describe('safe configuration', () => {
  const base = {
    DATABASE_URL: 'postgresql://user:password@localhost:5432/database',
    SESSION_PEPPER: '12345678901234567890123456789012',
    PASSWORD_PEPPER: 'abcdefghijklmnopqrstuvwxyz123456',
  };

  it('keeps payments disabled and Discord in dry-run by default', () => {
    const config = loadConfig(base);
    expect(config.PAYMENTS_ENABLED).toBe(false);
    expect(config.DISCORD_DRY_RUN).toBe(true);
    expect(config.PAYMENT_PROVIDER).toBe('mock');
  });

  it('refuses live payment or Discord flags in Phase 1', () => {
    expect(() => loadConfig({ ...base, PAYMENTS_ENABLED: 'true' })).toThrow(/disabled/);
    expect(() => loadConfig({ ...base, DISCORD_DRY_RUN: 'false' })).toThrow(/DRY_RUN/);
  });
});

describe('mock payment adapter', () => {
  it('uses the approved product snapshot without calling an external provider', () => {
    const event = new MockPaymentProvider().createPurchase({
      userId: '4cb7bd3f-e9cc-4b8d-a927-e0ea810858ea',
      productCode: 'VIP_LIFETIME',
      providerOrderId: 'order-1',
      providerPaymentId: 'payment-1',
      eventId: 'event-1',
      occurredAt: new Date('2026-01-01T00:00:00Z'),
      correlationId: '43d3c539-ab29-4cb6-8e8c-4d7bcf4bfbed',
    });
    expect(event).toMatchObject({ type: 'PURCHASE_SUCCEEDED', amountMinor: 10000, currency: 'EUR' });
  });
});
