import { expect, test } from 'bun:test';
import { formatCreditAmount, formatCreditBalance } from './format-credit';
test('recharge balance is yuan without a cents or dollar conversion', () => {
  expect(formatCreditBalance({ remaining: 5, currency: 'CNY' })).toBe('5.00 元');
  expect(formatCreditBalance({ remaining: 5 })).toBe('5.00 元');
  expect(formatCreditAmount(0.1234)).toBe('0.1234 元');
  expect(formatCreditBalance({ remaining: 5, currency: 'USD' })).toBe('$5.00 USD');
  expect(formatCreditAmount(NaN)).toBe('—');
});
