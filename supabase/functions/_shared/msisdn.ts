/**
 * MSISDN (phone number) normalization for Kenyan numbers.
 * Always store in E.164 format: +254XXXXXXXXX
 */

export function normalizeMsisdn(raw: string): string | null {
  if (!raw) return null;

  // Strip everything except digits and leading +
  let cleaned = raw.replace(/[^\d+]/g, '');

  // Handle +254...
  if (cleaned.startsWith('+254')) {
    return '+254' + cleaned.slice(4).replace(/^0+/, '');
  }

  // Handle 254... (no +)
  if (cleaned.startsWith('254')) {
    return '+254' + cleaned.slice(3).replace(/^0+/, '');
  }

  // Handle 0XXXXXXXXX (local format)
  if (cleaned.startsWith('0')) {
    return '+254' + cleaned.slice(1);
  }

  // Handle 7XXXXXXXX or 1XXXXXXXX (9 digits, no leading 0)
  if (/^[71]\d{8}$/.test(cleaned)) {
    return '+254' + cleaned;
  }

  // Not a recognized Kenyan format — return null
  return null;
}

export function isValidMsisdn(msisdn: string): boolean {
  return /^\+254\d{9}$/.test(msisdn);
}

/**
 * Kenyan mobile prefixes: 70, 71, 72, 74, 75, 76, 77, 78, 79
 * and 11 for newer ranges.
 */
export function isValidKenyanPrefix(msisdn: string): boolean {
  if (!isValidMsisdn(msisdn)) return false;
  const prefix = msisdn.slice(4, 6);
  return ['70', '71', '72', '74', '75', '76', '77', '78', '79', '11'].includes(prefix);
}