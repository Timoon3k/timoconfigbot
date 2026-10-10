import { PRODUCT_SPEC } from '../domain/products.js';
import type { PaymentProvider, VerifiedPaymentEvent } from './types.js';

export class MockPaymentProvider implements PaymentProvider {
  public readonly name = 'mock' as const;

  public createPurchase(input: Parameters<PaymentProvider['createPurchase']>[0]): VerifiedPaymentEvent {
    const spec = PRODUCT_SPEC[input.productCode];
    const subscription = input.productCode === 'VIP_MONTHLY_AUTO';
    return {
      provider: 'mock',
      eventId: input.eventId,
      userId: input.userId,
      occurredAt: input.occurredAt,
      correlationId: input.correlationId,
      type: subscription && input.periodStart ? 'SUBSCRIPTION_RENEWED' : 'PURCHASE_SUCCEEDED',
      productCode: input.productCode,
      providerPaymentId: input.providerPaymentId,
      providerOrderId: input.providerOrderId,
      amountMinor: spec.amountMinor,
      currency: spec.currency,
      ...(input.providerSubscriptionId ? { providerSubscriptionId: input.providerSubscriptionId } : {}),
      ...(input.periodStart ? { periodStart: input.periodStart } : {}),
      ...(input.periodEnd ? { periodEnd: input.periodEnd } : {}),
    };
  }

  public createFailedRenewal(input: Parameters<PaymentProvider['createFailedRenewal']>[0]): VerifiedPaymentEvent {
    return { ...input, provider: 'mock', type: 'PAYMENT_FAILED', productCode: 'VIP_MONTHLY_AUTO', amountMinor: 4000, currency: 'EUR' };
  }

  public createCancellation(input: Parameters<PaymentProvider['createCancellation']>[0]): VerifiedPaymentEvent {
    return { ...input, provider: 'mock', type: 'SUBSCRIPTION_CANCELLED' };
  }

  public createReversal(input: Parameters<PaymentProvider['createReversal']>[0]): VerifiedPaymentEvent {
    const { dispute, ...rest } = input;
    return { ...rest, provider: 'mock', type: dispute ? 'PAYMENT_DISPUTED' : 'PAYMENT_REFUNDED' };
  }
}
