/** OFFLINE REFERENCE ONLY. Production must verify payment signatures, amounts,
 * order ownership and provider state before producing the events consumed here. */

export function addCalendarMonthsUtc(timestamp, count = 1) {
  const current = new Date(timestamp);
  if (Number.isNaN(current.getTime()) || !Number.isInteger(count) || count < 0) throw new Error('invalid date or month count');
  const first = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + count, 1));
  const endOfMonth = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(current.getUTCDate(), endOfMonth), current.getUTCHours(), current.getUTCMinutes(), current.getUTCSeconds(), current.getUTCMilliseconds())).toISOString();
}

export function createState() { return { entitlements: [], processedEventIds: new Set() }; }

function validTimestamp(s) { return typeof s === 'string' && !Number.isNaN(Date.parse(s)); }

export function applyVerifiedEvent(state, event) {
  // This verified flag is illustrative, NOT a cryptographic verification function.
  if (event.verified !== true) throw new Error('Refusing event without upstream verification');
  if (!event.eventId || !event.userId || !event.type || !event.sourceId) throw new Error('missing event fields');
  if (state.processedEventIds.has(event.eventId)) return { duplicate: true };
  const when = event.timestamp;
  if (!validTimestamp(when)) throw new Error('invalid timestamp');
  if (event.type === 'ONE_TIME_MONTH_PAID') {
    if (event.priceMinor !== 4000 || event.currency !== 'EUR') throw new Error('unexpected amount/currency');
    state.entitlements.push({ userId: event.userId, type: 'MONTHLY', sourceId: event.sourceId, startsAt: when, endsAt: addCalendarMonthsUtc(when), revokedAt: null });
  } else if (event.type === 'SUBSCRIPTION_PERIOD_PAID') {
    if (event.priceMinor !== 4000 || event.currency !== 'EUR') throw new Error('unexpected amount/currency');
    if (!validTimestamp(event.periodStart) || !validTimestamp(event.periodEnd) || Date.parse(event.periodEnd) <= Date.parse(event.periodStart)) throw new Error('invalid provider billing period');
    state.entitlements.push({ userId: event.userId, type: 'MONTHLY', sourceId: event.sourceId, startsAt: event.periodStart, endsAt: event.periodEnd, revokedAt: null });
  } else if (event.type === 'LIFETIME_PAID') {
    if (event.priceMinor !== 10000 || event.currency !== 'EUR') throw new Error('unexpected amount/currency');
    state.entitlements.push({ userId: event.userId, type: 'LIFETIME', sourceId: event.sourceId, startsAt: when, endsAt: null, revokedAt: null });
  } else if (event.type === 'PAYMENT_REVERSED') {
    // Refund/reversal is associated with a specific source, not the whole account.
    for (const e of state.entitlements) if (e.userId === event.userId && e.sourceId === event.sourceId) e.revokedAt = when;
  } else if (event.type === 'SUBSCRIPTION_CANCEL_SCHEDULED') {
    // The paid entitlement is deliberately not removed; stop future billing at the PSP.
  } else {
    throw new Error(`unsupported event type: ${event.type}`);
  }
  state.processedEventIds.add(event.eventId);
  return { duplicate: false };
}

export function activeTier(state, userId, now) {
  const t = Date.parse(now);
  if (Number.isNaN(t)) throw new Error('invalid current timestamp');
  const entries = state.entitlements.filter(e => e.userId === userId && Date.parse(e.startsAt) <= t && (!e.revokedAt || Date.parse(e.revokedAt) > t) && (e.endsAt === null || Date.parse(e.endsAt) > t));
  if (entries.some(e => e.type === 'LIFETIME')) return 'VIP_LIFETIME';
  if (entries.some(e => e.type === 'MONTHLY')) return 'VIP_MONTHLY';
  return 'FREE';
}

export function vipRolePlan({ currentRoleIds, desiredTier, monthlyRoleId, lifetimeRoleId }) {
  if (!monthlyRoleId || !lifetimeRoleId || monthlyRoleId === lifetimeRoleId) throw new Error('invalid VIP role IDs');
  if (!['FREE','VIP_MONTHLY','VIP_LIFETIME'].includes(desiredTier)) throw new Error('invalid tier');
  const desired = desiredTier === 'VIP_LIFETIME' ? lifetimeRoleId : desiredTier === 'VIP_MONTHLY' ? monthlyRoleId : null;
  const existing = new Set(currentRoleIds);
  // Never touch roles other than the two explicitly allowlisted VIP roles.
  return {
    add: desired && !existing.has(desired) ? [desired] : [],
    remove: [monthlyRoleId, lifetimeRoleId].filter(r => r !== desired && existing.has(r))
  };
}
