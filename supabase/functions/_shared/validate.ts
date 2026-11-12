export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function isStrongPassword(password: string): boolean {
  // At least 8 chars, one letter, one number
  return password.length >= 8 && /[A-Za-z]/.test(password) && /\d/.test(password);
}

export function requireFields(body: Record<string, unknown>, fields: string[]): string | null {
  for (const f of fields) {
    if (body[f] === undefined || body[f] === null || body[f] === '') {
      return `Missing required field: ${f}`;
    }
  }
  return null;
}