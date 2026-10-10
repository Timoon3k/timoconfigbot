# Implementation request for coding agent

Act as a senior full-stack architect and security engineer. Implement a production-quality TimonConfigs membership system using the supplied blueprint as the functional specification. The user-facing site and all customer messages must be English. Development explanations and handoff documentation should be Polish.

## Requirements
- Build a responsive dark premium Cyberpunk Tech-Vault Next.js frontend with pages: home, plans, catalog, account, downloads, Discord link, billing, admin. Use provided TimonConfigs brand assets when available; otherwise do not fabricate logos or products.
- Implement secure Discord OAuth2 identify connection with state and appropriate token handling; do not auto-join without explicit user consent.
- Implement PostgreSQL migrations for users, orders, subscriptions, payment events, entitlements, files, downloads and role reconciliation jobs.
- Model 3 products: VIP_MONTHLY_ONCE €40 one calendar month without renewal, VIP_MONTHLY_AUTO €40 per confirmed paid billing cycle, VIP_LIFETIME €100 no preset expiration under clear license terms. Both Monthly products map to the SAME VIP Monthly Discord role. Lifetime maps to VIP Lifetime.
- Every premium download must be authorized server-side; store objects in private R2 and use short-lived presigned URLs.
- Implement a background Discord role reconciliation worker with strict role allowlist, no Administrator permission, bounded retries, rate-limit handling, structured audit logs and periodic reconciliation.
- Build an explicit, clearly separated payment provider adapter layer. DO NOT activate real checkout or claim provider approval. Production checkout must stay disabled until there is documented written approval for the *actual* Cronus/XIM product catalog and legal requirements are met. Sandbox/test data ONLY until then.
- When a future approved adapter is added, verify incoming webhook signatures and merchant/payment/amount/currency/order identity; handle retries, out-of-order events and idempotency. Do not grant membership solely from a success redirect or an unverified subscription-activated event.
- Automatic renewal cancellation must preserve remaining paid access, while expiry/reversal/refund must lead to membership recalculation and Discord synchronization.
- When a user with Auto Renew purchases Lifetime, warn and offer authorized cancellation of future subscription renewals; never silently continue an unnecessary second charge.
- All secrets server-side; HTTPS; least-privilege; CSRF protection; RBAC; rate limits; transaction integrity; test isolation. Provide migration/rollback plans.

## Deliverables
1. Executable application and worker code with dependency lock file.
2. `.env.example` without actual secrets, configuration validator, Docker dev environment.
3. DB migrations and seed for demo only.
4. Test suite: expiry, end-of-month, subscription payment failure, cancellation at period end, duplicate/out-of-order webhook, refunds, concurrent events, role conflicts, absent Discord member, unauthorized download, signed URL expiry.
5. Staging deployment guide (Polish) and production launch checklist blocked on payment compliance approval.
6. Full e2e QA against two independent test Discord accounts and payment sandbox.

Never claim functionality is production-ready until integration tests with real Discord developer credentials and an approved payment sandbox pass. Do not send unsolicited Discord invites or DMs, do not evade processor restrictions, and do not build game exploit/anti-cheat bypass features.
