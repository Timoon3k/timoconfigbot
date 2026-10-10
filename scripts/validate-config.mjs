import { readFileSync } from 'node:fs';
const p = JSON.parse(readFileSync(new URL('../config/plans.json', import.meta.url)));
const d = JSON.parse(readFileSync(new URL('../config/discord.example.json', import.meta.url)));
const products = p.plans;
if (p.currency !== 'EUR' || products.length !== 3) throw new Error('Expected 3 EUR products');
const expected = [['VIP_MONTHLY_ONCE',4000,'one_time','VIP_MONTHLY'], ['VIP_MONTHLY_AUTO',4000,'subscription','VIP_MONTHLY'], ['VIP_LIFETIME',10000,'one_time','VIP_LIFETIME']];
for (const [code,price,billing,role] of expected) {
  const item = products.find(x=>x.code===code);
  if (!item || item.price_minor!==price || item.billing!==billing || item.discord_role_key!==role) throw new Error('Plan does not match specification: '+code);
}
if (p.payment_processing_enabled || Object.values(p.provider_adapters).some(x=>x.enabled)) throw new Error('Production payment processing must remain disabled pending provider approval');
if (!d.sync.dry_run || d.security.administrator_permission_required) throw new Error('Default Discord configuration must be dry run without Administrator');
console.log('OK — product catalog, sandbox-only payment configuration and Discord safety defaults validated.');
