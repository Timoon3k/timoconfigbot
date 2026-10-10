import {createState,applyVerifiedEvent,activeTier,vipRolePlan} from '../src/entitlements.mjs';
const state=createState();
const event={verified:true,eventId:'sample-completed-1',userId:'demo-user',type:'ONE_TIME_MONTH_PAID',sourceId:'sample-payment-1',timestamp:'2026-10-10T12:00:00.000Z',priceMinor:4000,currency:'EUR'};
applyVerifiedEvent(state,event);
console.log('At purchase:',activeTier(state,'demo-user','2026-10-10T12:01:00.000Z'));
console.log('After one calendar month:',activeTier(state,'demo-user','2026-11-10T12:00:00.000Z'));
console.log('Mock role diff:',vipRolePlan({currentRoleIds:['FREE_MEMBER_ROLE'],desiredTier:'VIP_MONTHLY',monthlyRoleId:'MONTHLY_ROLE',lifetimeRoleId:'LIFETIME_ROLE'}));
console.log('No request sent to Discord or to a payment provider.');
