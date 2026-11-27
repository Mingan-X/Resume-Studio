import { exactFractionSchema } from '../../contracts/scoring.js';
export type Fraction = { n: bigint; d: bigint };
function gcd(a: bigint, b: bigint): bigint { while (b !== 0n) { const next = a % b; a = b; b = next; } return a; }
export function fraction(n: bigint, d = 1n): Fraction {
  if (n < 0n || d <= 0n) throw new Error('INVALID_NONNEGATIVE_FRACTION');
  const divisor = gcd(n, d); return { n: n / divisor, d: d / divisor };
}
export function decimal(value: number): Fraction {
  if (!Number.isFinite(value) || value < 0) throw new Error('INVALID_DECIMAL');
  const [mantissa = '', exponent = '0'] = value.toString().toLowerCase().split('e');
  const [integer = '', part = ''] = mantissa.split('.'), shift = Number(exponent) - part.length;
  const digits = BigInt(integer + part);
  return shift >= 0 ? fraction(digits * 10n ** BigInt(shift)) : fraction(digits, 10n ** BigInt(-shift));
}
export const add = (a: Fraction, b: Fraction) => fraction(a.n * b.d + b.n * a.d, a.d * b.d);
export const multiply = (a: Fraction, b: Fraction) => fraction(a.n * b.n, a.d * b.d);
export const divide = (a: Fraction, b: Fraction) => { if (b.n === 0n) throw new Error('ZERO_DENOMINATOR'); return fraction(a.n * b.d, a.d * b.n); };
export const compare = (a: Fraction, b: Fraction) => a.n * b.d < b.n * a.d ? -1 : a.n * b.d > b.n * a.d ? 1 : 0;
export const serialize = (a: Fraction) => exactFractionSchema.parse({ numerator: a.n.toString(), denominator: a.d.toString() });
export function scaledHalfUp(a: Fraction, decimals: number): number {
  const scale = 10n ** BigInt(decimals), quotient = (2n * a.n * scale + a.d) / (2n * a.d);
  if (quotient > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('SCORE_RANGE_EXCEEDED'); return Number(quotient);
}
export const display = (a: Fraction) => scaledHalfUp(a, 2) / 100;
