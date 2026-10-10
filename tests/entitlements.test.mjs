import test from 'node:test';
import assert from 'node:assert/strict';
import {addCalendarMonthsUtc, createState, applyVerifiedEvent, activeTier, vipRolePlan} from '../src/entitlements.mjs';
const base={verified:true,userId:'u',timestamp:'2026-10-10T10:30:00.000Z',currency:'EUR'};
test('one calendar month expires at the same UTC instant next month',()=>{
  const s=createState(); applyVerifiedEvent(s,{...base,eventId:'1',type:'ONE_TIME_MONTH_PAID',sourceId:'pay',priceMinor:4000});
  assert.equal(activeTier(s,'u','2026-11-10T10:29:59.999Z'),'VIP_MONTHLY');
  assert.equal(activeTier(s,'u','2026-11-10T10:30:00.000Z'),'FREE');
});
test('end-of-month clamps the day',()=>assert.equal(addCalendarMonthsUtc('2026-01-31T12:00:00Z'),'2026-02-28T12:00:00.000Z'));
test('subscription period extends only after verified paid cycle',()=>{
 const s=createState(); applyVerifiedEvent(s,{...base,eventId:'s1',type:'SUBSCRIPTION_PERIOD_PAID',sourceId:'sale-s1',priceMinor:4000,periodStart:'2026-10-10T10:30:00.000Z',periodEnd:'2026-11-10T10:30:00.000Z'});
 applyVerifiedEvent(s,{...base,eventId:'cancel-1',type:'SUBSCRIPTION_CANCEL_SCHEDULED',sourceId:'sub-1'});
 assert.equal(activeTier(s,'u','2026-11-09T10:30:00Z'),'VIP_MONTHLY');
 assert.equal(activeTier(s,'u','2026-11-11T10:30:00Z'),'FREE');
});
test('lifetime wins; refunds only revoke their source',()=>{
 const s=createState(); applyVerifiedEvent(s,{...base,eventId:'m1',type:'ONE_TIME_MONTH_PAID',sourceId:'month',priceMinor:4000});
 applyVerifiedEvent(s,{...base,eventId:'l1',type:'LIFETIME_PAID',sourceId:'life',priceMinor:10000});
 assert.equal(activeTier(s,'u','2030-01-01T00:00:00Z'),'VIP_LIFETIME');
 applyVerifiedEvent(s,{...base,eventId:'refund',type:'PAYMENT_REVERSED',sourceId:'life',timestamp:'2026-10-11T00:00:00.000Z'});
 assert.equal(activeTier(s,'u','2026-10-12T00:00:00Z'),'VIP_MONTHLY');
});
test('idempotent events and unverified events rejected',()=>{
 const s=createState(); const e={...base,eventId:'x',type:'LIFETIME_PAID',sourceId:'l',priceMinor:10000};
 applyVerifiedEvent(s,e); assert.deepEqual(applyVerifiedEvent(s,e),{duplicate:true}); assert.equal(s.entitlements.length,1);
 assert.throws(()=>applyVerifiedEvent(s,{...e,verified:false,eventId:'y'}));
});
test('role plan modifies only VIP roles, never staff roles',()=>{
 const diff=vipRolePlan({currentRoleIds:['STAFF_ROLE','MONTHLY_ROLE'],desiredTier:'VIP_LIFETIME',monthlyRoleId:'MONTHLY_ROLE',lifetimeRoleId:'LIFETIME_ROLE'});
 assert.deepEqual(diff,{add:['LIFETIME_ROLE'],remove:['MONTHLY_ROLE']});
});
