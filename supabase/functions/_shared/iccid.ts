/**
 * ICCID validation utilities.
 * Kenyan SIMs typically use 19 or 20 digit ICCIDs.
 * A Luhn check digit is usually the last digit.
 */

export function isNumeric(str: string): boolean {
  return /^\d+$/.test(str);
}

export function isValidIccidLength(iccid: string): boolean {
  return iccid.length === 19 || iccid.length === 20;
}

/**
 * Standard Luhn algorithm check.
 * Returns true if the check digit is valid.
 */
export function luhnCheck(num: string): boolean {
  if (!isNumeric(num)) return false;
  let sum = 0;
  let alternate = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let n = parseInt(num[i], 10);
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

/**
 * Extract the network prefix (first 5 digits usually).
 * Kenya SIMs commonly start with 89254.
 */
export function iccidPrefix(iccid: string): string {
  return iccid.slice(0, 5);
}

/**
 * Normalize an ICCID: strip whitespace and non-digits.
 */
export function normalizeIccid(raw: string): string {
  return raw.replace(/[^\d]/g, '');
}

export interface IccidValidation {
  normalized: string;
  valid_length: boolean;
  valid_luhn: boolean;
  warning: string | null;
}

export function validateIccid(raw: string): IccidValidation {
  const normalized = normalizeIccid(raw);
  const valid_length = isValidIccidLength(normalized);
  const valid_luhn = normalized.length >= 2 ? luhnCheck(normalized) : false;

  let warning: string | null = null;
  if (!valid_length) {
    warning = `ICCID length ${normalized.length} is unusual (expected 19 or 20 digits)`;
  } else if (!valid_luhn) {
    warning = 'ICCID check digit (Luhn) failed - likely an OCR error';
  }

  return { normalized, valid_length, valid_luhn, warning };
}