# TimonConfigs — Phase 2: Discord-first Stripe Checkout + Billing + paid VIP roles

**Status: engineering specification only, not deployed.** This is the next step AFTER Ticket Tool's separate `VIP Shop` public panel was successfully published. Owner confirmed **Open VIP Ticket now works** (11 Oct 2026). Existing Ticket Tool stays installed and operates ticket creation/closure.

**Base ref**: `feature/vip-ticket-permissions`; inspect current HEAD, PR #1, and `docs/VIP_TICKET_PERMISSIONS_PL.md` first. Phase 1 code is not automatically deployed merely because the Ticket Tool panel works. DO NOT branch from old `main`; do not merge directly to production.

## Fixed Discord and product scope

- Guild `1557854161805115402`, VIP Orders category `1558892807786209360`, general Support category `1557857668964687913` (never use Support for purchase).
- Ticket Tool bot user `557628352828014614`; public purchase panel channel `1558927395233468416`. Do not modify Ticket Tool configurations via bot API.
- VIP Monthly `VIP_MONTHLY_AUTO` = EUR 40.00/month (`4000` cents), recurring, Discord VIP Monthly role ID from protected existing configuration.
- VIP Lifetime `VIP_LIFETIME` = EUR 100.00 once (`10000` cents), Discord VIP Lifetime role ID from existing configuration.
- No `VIP_MONTHLY_ONCE` button in this phase. No WordPress portal, no requirement to log into timonconfigs.com.
- Backend remains Node.js 22 on Hostinger Business + existing Supabase PostgreSQL. Stripe hosted Checkout/hosted Customer Portal, no handling card credentials. PayPal **only** if Stripe actually offers and approves it for this account, EUR currency, recurring or one-time use. Do not force `payment_method_types` in a way that causes unapproved options to appear.
- The production Free Member after Rules Screening **already works**; preserve all its flags, IDs, role writes, gateway and worker. Founder/Staff protected. No `Administrator` permissions.

## Milestone A — Discord-selected checkout (Stripe TEST mode only)

1. Inspect `src/tickets/service.ts`, `src/discord/commands.ts`, `src/discord/interactions-http.ts`, `src/http/app.ts`, `src/config.ts`, `src/payments/*`, `src/membership/service.ts`, `src/discord/operations.ts`, `src/discord/sync.ts`, `src/discord/rest.ts`, `src/discord/config.ts`, `db/migrations/001..005`. Reuse existing ticket buttons and durable outbox; don't rebuild Ticket Tool. Note phase 1 may still have ticket flags OFF on Hostinger.
2. New purchase CTA only for signed Discord button interactions on a bot-authored selection message recorded in DB, private channel in exact VIP Orders category, current verified Discord human member with `pending=false` and channel access. **Buyer = interaction.member.user.id**. Never use channel name, Ticket Tool messages or Stripe metadata as an authority for buyer identity. Binding must survive opening in external browser.
3. **Discord-first buyer identity and entitlement**: existing `app_users` requires a real email/password; do not invent placeholder email, weak password or linked site account to create paid membership. Use a durable unique Discord principal and Stripe Customer relationship with add-only database migration(s) or a carefully designed auth bridge. Stripe Customer email is a billing contact, not proof of Discord account ownership. Future WordPress OAuth link must explicitly and securely link the existing paid Discord principal without duplicate access.
4. One Checkout Session for each deliberate plan selection, with server-side `STRIPE_VIP_MONTHLY_PRICE_ID` / `STRIPE_VIP_LIFETIME_PRICE_ID` (NOT client-supplied), validated against matching exact configured product/currency/amount/recurring interval from Stripe's test account. Monthly `mode=subscription`; Lifetime `mode=payment`. Server-issued idempotency key, `customer` mapped to authenticated Discord principal, `client_reference_id` opaque internal checkout/order ID, provider metadata only as non-authoritative correlation.
5. Reject duplicate active monthly subscriptions and repeat lifetime purchases, abandoned checkout races and malicious cross-user attempts. Expiring links and pending sessions must not create entitlements. Return checkout URL through ephemeral Discord interaction response/followup, never a public channel payment link. If network may exceed 3 sec interaction response deadline, defer immediately and send a correctly scoped ephemeral followup within Discord response-token TTL; no double responses. Do not DM unsolicited payment links.
6. Use HTTPS Hostinger backend `/billing/return` and `/billing/cancel` with no-store neutral content (no WordPress). Do not hardcode the temporary Hostinger URL; `PUBLIC_BILLING_BASE_URL` must be reviewed and allowlisted. Neither redirect grants VIP or even claims paid status without server verification.
7. Before checkout, clear EN disclosure of price, auto-renew, cancellation, VIP entitlement scope and publicly hosted terms, privacy and refund/consumer withdrawal policy; fail closed while required legal URLs/terms are missing. Lifetime must say covered service lifetime under published terms, not guaranteed infinite updates.

## Milestone B — Authenticated Stripe webhook and money ledger

1. Use official Stripe Node SDK pinned to a supported version. Route `POST /api/payments/stripe/webhook`; Fastify scoped *raw bytes* parser and `stripe.webhooks.constructEvent(rawBody, stripeSignature, STRIPE_WEBHOOK_SECRET)` with actual endpoint secret, test/live segregation, deduplicated Stripe event IDs, relevant Stripe account/mode validation. Respect current app's signed Discord route body parsing.
2. Persist Stripe events and payment state durably, with UNIQUE constraints (checkout session, Stripe event ID, Stripe invoice ID, subscription, payment intent/charge) and a transactional worker; safely tolerate out-of-order webhook delivery, retries and crashes. Validate Checkout Session/price ID, customer principal, subscription/invoice, amount `4000`/ `10000`, currency `eur`, recorded order ID, exact paid status and actual charge/paid invoice. Fetch canonical Stripe objects when events are incomplete/changed by API version. Never trust unverified metadata, a success redirect, or a Discord user's 'paid' message.
3. Monthly: initial paid invoice **exactly once** creates paid-through entitlement; each genuine newly paid recurring invoice renews to Stripe's verified billing period. `checkout.session.completed` or `customer.subscription.created` alone do not grant Monthly; `invoice.paid` may include out-of-band invoice and is NOT enough without genuine charge verification. Handle failed initial invoice, retries, past_due, incomplete, unpaid, cancel_at_period_end, subscription deleted, partial/full refunds and disputes without double extend.
4. Lifetime: after verified real successful one-time PaymentIntent/Checkout payment (including asynchronous method completion if relevant) grant VIP Lifetime exactly once. Refund/dispute should reconcile precisely the payment's entitlement, not all customer's benefits.
5. Upgrade Monthly → Lifetime needs explicit policy to avoid accidentally leaving auto-renew running. Prevent recurring charge surprises: explicit user confirmation, cancel scheduled monthly as appropriate, correct paid-through/role precedence; do not silently create 2 independent active subscriptions.
6. Stripe-hosted Customer Portal for Monthly cancellation/payment method updates; launch from a securely authenticated Discord command/component and a principal-owned Stripe Customer (never ID from request). Cancellation retains paid access to verified end of already paid period, unless a documented refund/reversal requires earlier ending.
7. Worker uses Discord REST to reconcile payment entitlements and actual role state, safely retrying; ticket shows confirmed payment separately from confirmed role assignment. Do not auto-close tickets with unresolved payments. No credit-card/billing personal data or sensitive provider response bodies in Discord messages or logs.

## Milestone C — Production VIP role-write preparation (leave OFF)

1. Keep existing `DISCORD_VIP_SYNC_ENABLED=false` and `DISCORD_PRODUCTION_VIP_WRITES_ENABLED=false` in live environment. Existing config forbids these in production and REST guards allow only Free Member. Add independent, restrictive, owner-approved VIP-only role operation policy; **do not loosen Free Member's gates**, never route VIP grants through Free Member approval. Separate explicit approvals and audit trail for payment-linked monthly/lifetime role grants and revocations.
2. Existing VIP Monthly / VIP Lifetime role IDs are taken from validated config, not user input. Verify guild, Discord account, `pending=false`, not bot, role hierarchy and protected Founder/Staff/Owner. Free Member should never be automatically removed. Role journal and ownership ledger required; remove only bot-owned paid role and only on verified expiry/refund/dispute, never manually granted roles.
3. Handle rejoin, downtime, expired Monthly, renewal, simultaneous webhook events, race between 2 workers, disconnected Discord, and unknown / uncertain REST write outcome without double role operations or unjustified revocations.
4. Until live merchant approval and test checklist is complete, all real payment and VIP mutation gates **default OFF**. Existing Free Member production flags must remain exactly as configured.

## Tests and deploy artifacts

- Run `npm run typecheck`, `npm run build`, `npm run lint`, `npm run test:unit`. Integration tests **disposable PostgreSQL ONLY**; never production Supabase (some suites use TRUNCATE).
- Add sandbox/fake Stripe tests for valid/invalid/missing signature, replay, webhook out of order, mismatched price/guild/buyer/customer/amount/currency, double-click Checkout, abandoned checkout, failed initial invoice, duplicate paid invoice, unpaid/out-of-band marked invoice, renewal race, cancellation paid-through, chargeback/refund, lifetime upgrade, role grant retries and other member's ticket. Regression for Support exclusion and Free Member.
- Keep migration additive and backwards compatible with existing 001..005, with checksums consistent; avoid destructive down. Keep code review limited to files needed. Prefer a few self-contained commits in **new branch** `feature/discord-stripe-billing` from latest `feature/vip-ticket-permissions`, separate from the existing draft PR; do not auto-merge, deploy or mutate production.
- At finish report: changed files, actual tests run/skipped, signed webhook URL, required env key **names only** (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_VIP_MONTHLY_PRICE_ID`, `STRIPE_VIP_LIFETIME_PRICE_ID`, `PUBLIC_BILLING_BASE_URL` etc.), Stripe Dashboard click-by-click product and webhook setup, SQL migrations and exact host deployment order, Free Member regressions, feature flags, test checklists and emergency rollback. Never output any real keys.
- Production acceptance also requires Stripe KYC and explicit Stripe/PayPal approval for truthful actual digital offerings (Cronus Zen/XIM Matrix), recurring eligibility, and legal/accounting review. No false product description to bypass merchant review.

## Official docs for API behavior

- https://docs.stripe.com/payments/checkout
- https://docs.stripe.com/billing/subscriptions/overview
- https://docs.stripe.com/webhooks/signature
- https://docs.stripe.com/payments/paypal
- https://docs.stripe.com/billing/subscriptions/customer-portal

## External dependency to verify

Ticket Tool has already published the public Open VIP Ticket panel, but **this does not prove phase 1 `feature/vip-ticket-permissions` is deployed**. Codex must not claim live auto-message or Stripe working until explicit Hostinger deployment and test results. Opening a new private ticket is necessary to obtain the ticket channel ID for permission audit, see `docs/VIP_TICKET_PERMISSIONS_PL.md`.
