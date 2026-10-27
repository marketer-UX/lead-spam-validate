// Phone validation. Offline via libphonenumber-js — MUST import from `/max` (default bundle lacks getType metadata).
import { parsePhoneNumberFromString, type CountryCode, type PhoneNumber } from 'libphonenumber-js/max';
import type { PhoneCheckResult, PhoneFlag, PhoneType } from './types.js';

export const DACH = new Set(['DE', 'AT', 'CH']);

/** German spellings → parseable: strip separators, `0049…` → `+49…`. Trunk zero (`+49 (0)211`) handled by double parse. */
export function normalizePhoneInput(input: string): string {
  return input.replace(/[\s\-/().\u00a0]/g, '').replace(/^00/, '+');
}

function stripTrunkZero(s: string): string {
  return s.replace(/^(\+\d{1,3})0+/, '$1');
}

export function repeatedDigits(digits: string): boolean {
  const d = digits.replace(/\D/g, '');
  if (d.length < 7) return false;
  if (/^(\d)\1{6,}$/.test(d)) return true; // entire number is one repeated digit
  if (/(\d)\1{5,}/.test(d)) return true; // 6+ identical in a row
  const counts = new Map<string, number>();
  for (const ch of d) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  return Math.max(...counts.values()) / d.length >= 0.7;
}

/** Longest run of consecutive ascending or descending digits (1234567 / 9876543). Bots love these. */
export function sequentialRun(digits: string): number {
  const d = digits.replace(/\D/g, '');
  let best = d.length ? 1 : 0, up = 1, down = 1;
  for (let i = 1; i < d.length; i++) {
    const diff = d.charCodeAt(i) - d.charCodeAt(i - 1);
    up = diff === 1 ? up + 1 : 1;
    down = diff === -1 ? down + 1 : 1;
    best = Math.max(best, up, down);
  }
  return best;
}

/** Humans in DACH type national numbers with the trunk 0 (0211 …) or an explicit +/00 country code. Raw digit blobs (9677306983) are bot-typical. */
export function hasTrunkOrCountryPrefix(normalized: string): boolean {
  return /^(\+|0)/.test(normalized);
}

/**
 * Denied dial prefixes (`phone_deny_prefixes` of the remote config: digits, no plus). True when the
 * E.164 country calling code of the parsed number starts with one of them — `['1','2','7','8','9']`
 * therefore denies +1 (North America), +2 (Africa), +7, +8 and +9 in one go, while +3x/+4x
 * (Europe, incl. +49/+43/+41) stay untouched. Empty list or no calling code = rule off (fail-open).
 */
export function deniedDialPrefix(callingCode: string | undefined | null, denyPrefixes: readonly string[] = []): boolean {
  if (!callingCode || !denyPrefixes.length) return false;
  return denyPrefixes.some((raw) => {
    const p = (raw ?? '').trim().replace(/^\+/, '');
    return !!p && callingCode.startsWith(p);
  });
}

function mapType(t: string | undefined): PhoneType | undefined {
  switch (t) {
    case 'MOBILE': return 'mobile';
    case 'FIXED_LINE':
    case 'FIXED_LINE_OR_MOBILE': return 'fixed_line';
    case 'VOIP': return 'voip';
    case 'PREMIUM_RATE': return 'premium_rate';
    case 'TOLL_FREE': return 'toll_free';
    case undefined: return undefined;
    default: return 'other';
  }
}

function tryParse(s: string, country: CountryCode): PhoneNumber | undefined {
  try { return parsePhoneNumberFromString(s, country); } catch { return undefined; }
}

/** Parse with the default country, then fall back to the other DACH countries for national formats typed without +43/+41. */
function parseDach(norm: string, defaultCountry: CountryCode): PhoneNumber | undefined {
  const order: CountryCode[] = [defaultCountry, ...(['DE', 'AT', 'CH'] as CountryCode[]).filter((c) => c !== defaultCountry)];
  const candidates = [norm, stripTrunkZero(norm)].filter((v, i, a) => a.indexOf(v) === i);
  let firstPossible: PhoneNumber | undefined;
  for (const cc of order) {
    for (const cand of candidates) {
      const p = tryParse(cand, cc);
      if (!p) continue;
      if (p.isValid()) return p;
      if (!firstPossible && cc === defaultCountry) firstPossible = p;
    }
    // fallback countries only for national formats (leading 0); +/00 carry their own country, raw digit blobs stay with the default
    if (!norm.startsWith('0')) break;
  }
  return firstPossible;
}

export function checkPhone(input: string, defaultCountry = 'DE', denyPrefixes: readonly string[] = []): PhoneCheckResult {
  const raw = (input ?? '').toString();
  if (!raw.trim()) return { valid: false, flags: [] }; // empty optional field: no check, no flag
  const country = (defaultCountry || 'DE').toUpperCase() as CountryCode;
  const norm = normalizePhoneInput(raw);
  const p = parseDach(norm, country);
  const digitsOnly = norm.replace(/\D/g, '');
  // set on both exits (valid and invalid): the country code is known as soon as the number parsed
  // at all, and `decide()` turns the flag into a `phone_invalid` reject regardless of strict mode.
  const denied: PhoneFlag[] = deniedDialPrefix(p?.countryCallingCode, denyPrefixes) ? ['phone_prefix_denied'] : [];
  const botFlags: PhoneFlag[] = [];
  if (repeatedDigits(p?.nationalNumber ?? digitsOnly)) botFlags.push('repeated_digits');
  if (sequentialRun(p?.nationalNumber ?? digitsOnly) >= 9) botFlags.push('sequential_digits'); // 1234567890 / 0123456789 / 123456789; real numbers never run 9+
  if (!hasTrunkOrCountryPrefix(norm)) botFlags.push('no_trunk_prefix');
  if (!p || !p.isValid() || (p.nationalNumber?.length ?? 0) < 6) {
    return { valid: false, flags: ['invalid', ...denied, ...botFlags] };
  }
  const type = mapType(p.getType());
  const flags: PhoneFlag[] = [];
  if (type === 'mobile') flags.push('mobile');
  if (type === 'fixed_line') flags.push('fixed_line');
  if (type === 'voip') flags.push('voip');
  if (type === 'premium_rate') flags.push('premium_rate');
  if (type === 'toll_free') flags.push('toll_free');
  if (!p.country || !DACH.has(p.country)) flags.push('foreign');
  flags.push(...denied);
  flags.push(...botFlags);
  return {
    valid: true,
    e164: p.number,
    national: p.formatNational(),
    international: p.formatInternational(),
    country: p.country,
    type: type ?? 'other',
    flags,
  };
}
