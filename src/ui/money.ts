/**
 * Turning what someone typed into paise, and paise back into something
 * readable.
 *
 * This is where money apps go wrong. `parseFloat('12.10') * 100` is
 * 1209.9999999999998, and `Math.round` hides that until the day it does not.
 * Nothing here converts through a float: the text is split on the decimal
 * point and the two halves are combined as integers.
 */

const MAX_MINOR = Number.MAX_SAFE_INTEGER;

export class MoneyError extends Error {}

/**
 * Parse user input into integer minor units.
 *
 * Accepts "1200", "1200.50", "1,200.5", " ₹1200 ". Rejects anything else
 * loudly, because a silent zero in a ledger is worse than a refused entry.
 */
export function parseAmount(input: string, minorPerMajor = 100): number {
  const cleaned = input.replace(/[\s,₹$£€]/g, '');
  if (cleaned === '') throw new MoneyError('enter an amount');

  const match = /^(-)?(\d*)(?:\.(\d*))?$/.exec(cleaned);
  if (!match) throw new MoneyError(`"${input.trim()}" is not an amount`);

  const [, sign, whole = '', fraction = ''] = match;
  if (whole === '' && fraction === '') throw new MoneyError(`"${input.trim()}" is not an amount`);

  const places = String(minorPerMajor).length - 1;
  if (fraction.length > places) {
    throw new MoneyError(`more than ${places} decimal places: "${input.trim()}"`);
  }

  // Integers throughout - the fraction is padded, never multiplied by a float.
  const padded = fraction.padEnd(places, '0');
  const minor = Number(whole || '0') * minorPerMajor + Number(padded || '0');
  if (!Number.isSafeInteger(minor) || minor > MAX_MINOR) {
    throw new MoneyError('that amount is too large');
  }
  return sign === '-' ? -minor : minor;
}

/** Render minor units for display. Always two places; never a float. */
export function formatAmount(minor: number, minorPerMajor = 100): string {
  if (!Number.isInteger(minor)) {
    throw new MoneyError(`amounts are minor units and must be integers, got ${minor}`);
  }
  const places = String(minorPerMajor).length - 1;
  const negative = minor < 0;
  const absolute = Math.abs(minor);
  const whole = Math.trunc(absolute / minorPerMajor);
  const fraction = absolute - whole * minorPerMajor;

  const grouped = whole.toLocaleString('en-IN');
  return `${negative ? '-' : ''}${grouped}.${String(fraction).padStart(places, '0')}`;
}

export const withSymbol = (minor: number): string => `₹${formatAmount(minor)}`;
