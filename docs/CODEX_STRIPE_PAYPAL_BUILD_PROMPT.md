# Codex — Stripe Billing z PayPal dla TimonConfigs

Repository: Timoon3k/timoconfigbot
Base and work branch: feature/vip-payments-integration
Do NOT merge, deploy or change real accounts automatically.

## Background
Hostinger Business Node 22 TypeScript app + Supabase PostgreSQL + WordPress timonconfigs.com + Discord Gateway. Production Free Member after Rules Screening already works and MUST NOT regress. Existing payments are mock-only and production VIP sync is deliberately blocked. Reuse schema migrations 001–003, entitlements engine and Discord sync.

Provider selection: Stripe Checkout + Stripe Billing, PayPal as a payment method inside Stripe when enabled/approved for subscription mode. DO NOT build separate PayPal API integration.
Official docs: https://docs.stripe.com/payments/paypal and https://docs.stripe.com/payments/paypal/activate and https://docs.stripe.com/billing/subscriptions/overview and https://docs.stripe.com/webhooks

## Products
- VIP_MONTHLY_AUTO: 4000 eurocents each calendar month, Checkout mode=subscription, paid invoice each period, VIP Monthly role.
- VIP_LIFETIME: 10000 eurocents one time, Checkout mode=payment, VIP Lifetime role.
- VIP_MONTHLY_ONCE: optional 4000 eurocents one-time month.
All amounts, product and price identifiers must come from backend allowlist and be cross-checked against Stripe account.

## Implement in small commits
1. Add isolated stripe test-mode provider using official Node Stripe SDK and env validation. Default PAYMENTS_ENABLED=false. Do not conflate mocked events with verified Stripe production events.
2. Write additive migration 004+ for Stripe customer mapping, Checkout attempts, event IDs, invoice and payment IDs, subscription ID, unique constraints and durable idempotent ledger. Never mutate production DB.
3. Implement authenticated POST checkout creation for the two required plans, with server-derived app_user_id, CSRF, rate limit, return domains allowlisted to timonconfigs.com, and session ownership validation.
4. Add Stripe webhook endpoint with raw body and SDK verifyHeader/constructEvent, guard Stripe account/environment/price/currency/amount/customer/order associations. No role grants based on success redirect or unchecked checkout.session.completed.
5. Build durable reconciler for invoice.paid, invoice.payment_failed, subscription.updated/deleted, single-payment completion, refunds and disputes. A successful paid invoice triggers a new monthly paid period exactly once; first invoice must not double-count checkout event. Resolve out-of-order events with Stripe API and DB locks. Handle past_due, grace policy and cancellation at period end.
6. Add protected Stripe Billing Customer Portal endpoint for authenticated subscription owner. Provide WordPress UI bridge or a separate private WordPress plugin without putting Stripe secret on WordPress; display product cards, connection status, billing period, cancellation and payment history.
7. Design a completely separate production VIP role-write approval gate, allow only VIP Monthly/Lifetime when verified entitlements are paid, retain Rules Screening recheck, role ownership, safe removals and immutable Founder/Staff/Free Member protections. Keep production flags DISCORD_VIP_SYNC_ENABLED=false and DISCORD_PRODUCTION_VIP_WRITES_ENABLED=false until owner review.
8. Unit, integration on disposable PostgreSQL, lint, typecheck, build. Test signature, duplicate events, wrong prices/accounts, concurrency, delayed/out-of-order events, cancellations/refunds/disputes, lifetime upgrades, expiration, Free Member regression. Never contact live Stripe, production Discord or Supabase.

## Release prerequisites
- Merchant account Stripe must be accepted, real Cronus Zen/XIM Matrix configurations/scripts accurately disclosed and approved for payments; PayPal recurring method must be approved/enabled in Dashboard.
- Billing auto-renew disclosures, cancellation, refund, Lifetime terms, GDPR/VAT/invoicing completed.
- Protected env for STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and specific verified Stripe Price IDs. Never commit secrets.
- No real payment charges or role mutations during this coding task; no deployment without explicit owner action.

Deliver diffs, commits, test results, migration notes, sandbox checklist and production rollback procedure. Stop.