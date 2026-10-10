import { z } from 'zod';
import { PRODUCT_CODES } from '../domain/products.js';

const common = z.object({
  provider: z.literal('mock'),
  eventId: z.string().min(1).max(200),
  userId: z.string().uuid(),
  occurredAt: z.coerce.date(),
  correlationId: z.string().uuid(),
});

const success = common.extend({
  type: z.enum(['PURCHASE_SUCCEEDED', 'SUBSCRIPTION_RENEWED']),
  productCode: z.enum(PRODUCT_CODES),
  providerPaymentId: z.string().min(1).max(200),
  providerOrderId: z.string().min(1).max(200).optional(),
  providerSubscriptionId: z.string().min(1).max(200).optional(),
  amountMinor: z.number().int().positive(),
  currency: z.literal('EUR'),
  periodStart: z.coerce.date().optional(),
  periodEnd: z.coerce.date().optional(),
});

const failed = common.extend({
  type: z.literal('PAYMENT_FAILED'),
  productCode: z.literal('VIP_MONTHLY_AUTO'),
  providerPaymentId: z.string().min(1).max(200),
  providerSubscriptionId: z.string().min(1).max(200),
  amountMinor: z.literal(4000),
  currency: z.literal('EUR'),
});

const cancellation = common.extend({
  type: z.literal('SUBSCRIPTION_CANCELLED'),
  providerSubscriptionId: z.string().min(1).max(200),
});

const reversal = common.extend({
  type: z.enum(['PAYMENT_REFUNDED', 'PAYMENT_DISPUTED']),
  providerPaymentId: z.string().min(1).max(200),
});

export const verifiedPaymentEventSchema = z.discriminatedUnion('type', [success, failed, cancellation, reversal]);
export type VerifiedPaymentEvent = z.infer<typeof verifiedPaymentEventSchema>;

export interface PaymentProvider {
  readonly name: 'mock';
  createPurchase(input: {
    userId: string;
    productCode: (typeof PRODUCT_CODES)[number];
    providerOrderId: string;
    providerPaymentId: string;
    eventId: string;
    occurredAt: Date;
    correlationId: string;
    providerSubscriptionId?: string;
    periodStart?: Date;
    periodEnd?: Date;
  }): VerifiedPaymentEvent;
  createFailedRenewal(input: {
    userId: string;
    providerSubscriptionId: string;
    providerPaymentId: string;
    eventId: string;
    occurredAt: Date;
    correlationId: string;
  }): VerifiedPaymentEvent;
  createCancellation(input: {
    userId: string;
    providerSubscriptionId: string;
    eventId: string;
    occurredAt: Date;
    correlationId: string;
  }): VerifiedPaymentEvent;
  createReversal(input: {
    userId: string;
    providerPaymentId: string;
    eventId: string;
    occurredAt: Date;
    correlationId: string;
    dispute?: boolean;
  }): VerifiedPaymentEvent;
}
