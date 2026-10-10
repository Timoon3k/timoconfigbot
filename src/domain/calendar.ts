import { DomainError } from '../errors.js';

export function addCalendarMonthsUtc(value: Date, count = 1): Date {
  if (Number.isNaN(value.getTime()) || !Number.isInteger(count) || count < 0) {
    throw new DomainError('INVALID_DATE', 'A valid date and non-negative whole month count are required.');
  }
  const targetFirst = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + count, 1));
  const targetLastDay = new Date(Date.UTC(targetFirst.getUTCFullYear(), targetFirst.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(
    targetFirst.getUTCFullYear(),
    targetFirst.getUTCMonth(),
    Math.min(value.getUTCDate(), targetLastDay),
    value.getUTCHours(),
    value.getUTCMinutes(),
    value.getUTCSeconds(),
    value.getUTCMilliseconds(),
  ));
}
