import { describe, expect, it } from 'vitest';
import { formatAmount, MoneyError, parseAmount, withSymbol } from './money';

describe('parseAmount', () => {
  it('reads ordinary input', () => {
    expect(parseAmount('1200')).toBe(120000);
    expect(parseAmount('1200.50')).toBe(120050);
    expect(parseAmount('0.05')).toBe(5);
    expect(parseAmount('.5')).toBe(50);
  });

  it('survives the values that break float arithmetic', () => {
    // parseFloat('12.10') * 100 is 1209.9999999999998. Nothing here goes
    // through a float, so these are exact rather than nearly right.
    expect(parseAmount('12.10')).toBe(1210);
    expect(parseAmount('0.29')).toBe(29);
    expect(parseAmount('8.70')).toBe(870);
  });

  it('forgives formatting a person would actually type', () => {
    expect(parseAmount(' ₹1,200.50 ')).toBe(120050);
    expect(parseAmount('1,00,000')).toBe(10000000);
  });

  it('refuses nonsense instead of quietly returning zero', () => {
    for (const bad of ['', '   ', 'abc', '12.3.4', '1-2', '₹']) {
      expect(() => parseAmount(bad)).toThrow(MoneyError);
    }
  });

  it('refuses more precision than the currency has', () => {
    expect(() => parseAmount('10.123')).toThrow(/decimal places/);
  });

  it('handles negatives, for refunds and corrections', () => {
    expect(parseAmount('-45.50')).toBe(-4550);
  });

  it('refuses an amount too large to stay exact', () => {
    expect(() => parseAmount('99999999999999999999')).toThrow(/too large/);
  });
});

describe('formatAmount', () => {
  it('always shows both places', () => {
    expect(formatAmount(120050)).toBe('1,200.50');
    expect(formatAmount(5)).toBe('0.05');
    expect(formatAmount(0)).toBe('0.00');
  });

  it('groups the way the locale does', () => {
    // Indian grouping: 10,00,000 rather than 1,000,000.
    expect(formatAmount(100000000)).toBe('10,00,000.00');
  });

  it('keeps the sign', () => {
    expect(formatAmount(-4550)).toBe('-45.50');
    expect(withSymbol(-4550)).toBe('₹-45.50');
  });

  it('refuses to render a fraction of a paisa', () => {
    expect(() => formatAmount(12.5)).toThrow(MoneyError);
  });
});

describe('round trip', () => {
  it('survives parse then format', () => {
    for (const text of ['0.01', '7.00', '1,234.56', '999.99']) {
      expect(formatAmount(parseAmount(text))).toBe(text.replace(/^0(?=\.)/, '0'));
    }
  });
});
