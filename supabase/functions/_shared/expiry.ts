/**
 * Expiry date parsing. Handles common formats printed on SIM cards.
 * Returns ISO date string (YYYY-MM-DD) or null.
 */

const MONTH_NAMES: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

function twoDigitYear(y: number): number {
  // Assume 2000s for years 00-79, 1900s for 80-99 (unlikely for SIMs)
  return y < 80 ? 2000 + y : 1900 + y;
}

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

export function parseExpiry(raw: string): string | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();

  // MM/YY or MM/YYYY
  let m = s.match(/^(\d{1,2})\s*[/\-.]\s*(\d{2,4})$/);
  if (m) {
    const month = parseInt(m[1], 10);
    const year = m[2].length === 2 ? twoDigitYear(parseInt(m[2], 10)) : parseInt(m[2], 10);
    if (month >= 1 && month <= 12 && year >= 2020 && year <= 2100) {
      // Assume last day of the month
      const lastDay = new Date(year, month, 0).getDate();
      return `${year}-${pad(month)}-${pad(lastDay)}`;
    }
  }

  // DD/MM/YY or DD/MM/YYYY
  m = s.match(/^(\d{1,2})\s*[/\-.]\s*(\d{1,2})\s*[/\-.]\s*(\d{2,4})$/);
  if (m) {
    const d = parseInt(m[1], 10);
    const month = parseInt(m[2], 10);
    const year = m[3].length === 2 ? twoDigitYear(parseInt(m[3], 10)) : parseInt(m[3], 10);
    if (d >= 1 && d <= 31 && month >= 1 && month <= 12 && year >= 2020 && year <= 2100) {
      return `${year}-${pad(month)}-${pad(d)}`;
    }
  }

  // YYYY-MM-DD
  m = s.match(/^(\d{4})\s*[/\-.]\s*(\d{1,2})\s*[/\-.]\s*(\d{1,2})$/);
  if (m) {
    const year = parseInt(m[1], 10);
    const month = parseInt(m[2], 10);
    const d = parseInt(m[3], 10);
    if (d >= 1 && d <= 31 && month >= 1 && month <= 12 && year >= 2020 && year <= 2100) {
      return `${year}-${pad(month)}-${pad(d)}`;
    }
  }

  // Month name formats: "DEC 2027", "Dec 27", "December 2027"
  m = s.match(/^([a-z]+)\s*[/\-\s.]?\s*(\d{2,4})$/);
  if (m) {
    const month = MONTH_NAMES[m[1]];
    const year = m[2].length === 2 ? twoDigitYear(parseInt(m[2], 10)) : parseInt(m[2], 10);
    if (month && year >= 2020 && year <= 2100) {
      const lastDay = new Date(year, month, 0).getDate();
      return `${year}-${pad(month)}-${pad(lastDay)}`;
    }
  }

  // 2027-12 (YYYY-MM)
  m = s.match(/^(\d{4})\s*[/\-.]\s*(\d{1,2})$/);
  if (m) {
    const year = parseInt(m[1], 10);
    const month = parseInt(m[2], 10);
    if (month >= 1 && month <= 12 && year >= 2020 && year <= 2100) {
      const lastDay = new Date(year, month, 0).getDate();
      return `${year}-${pad(month)}-${pad(lastDay)}`;
    }
  }

  return null;
}