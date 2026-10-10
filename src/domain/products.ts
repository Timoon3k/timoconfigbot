export const PRODUCT_CODES = ['VIP_MONTHLY_ONCE', 'VIP_MONTHLY_AUTO', 'VIP_LIFETIME'] as const;
export type ProductCode = (typeof PRODUCT_CODES)[number];
export type EntitlementTier = 'FREE' | 'VIP_MONTHLY' | 'VIP_LIFETIME';

export const PRODUCT_SPEC = {
  VIP_MONTHLY_ONCE: { amountMinor: 4000, currency: 'EUR', tier: 'VIP_MONTHLY', billing: 'one_time' },
  VIP_MONTHLY_AUTO: { amountMinor: 4000, currency: 'EUR', tier: 'VIP_MONTHLY', billing: 'subscription' },
  VIP_LIFETIME: { amountMinor: 10000, currency: 'EUR', tier: 'VIP_LIFETIME', billing: 'one_time' },
} as const satisfies Record<ProductCode, {
  amountMinor: number;
  currency: 'EUR';
  tier: Exclude<EntitlementTier, 'FREE'>;
  billing: 'one_time' | 'subscription';
}>;

export function isProductCode(value: string): value is ProductCode {
  return (PRODUCT_CODES as readonly string[]).includes(value);
}
