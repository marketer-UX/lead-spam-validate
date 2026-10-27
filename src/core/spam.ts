// Spam layer — the signals that separate paid-traffic junk from real German B2B leads when
// e-mail and phone are structurally fine (valid gmail + parseable DE number). Pure functions:
// no I/O, no env, no clock. The caller passes country, client fingerprint and timestamp in.
//
// Rule groups, each switchable off / score / block via the remote config:
//   geo          — IP country (allow/deny list); with `geo_phone_fallback` the phone country
//                  stands in when no IP country arrived (the Webflow-webhook path has none)
//   geo_freemail — foreign country AND a freemail address (a very precise combination: real foreign
//                  enquiries usually come from company domains, real domestic ones from local numbers)
//   client       — browser timezone + language reported by the embed
//   ua           — device substrings in the User-Agent (cheap Android models used by click farms)
//   text         — keyword blocklist over the free-text values the caller passes in (embed: company
//                  only; Webflow webhook: company, name and message)
//   contact      — blocklist of e-mail addresses / domains and full names (for fake-lead waves
//                  that reuse a fixed set of names, e.g. 'John Sample' — freemail, valid DE
//                  numbers, real browser, so every other rule stays silent)
//   repeat       — the same e-mail address or the same full name more than `repeat_max` times
//                  within `repeat_window_h` (the caller counts, this file only judges the count)
//   ip           — blocklist of client IPs (exact, IPv4 CIDR). Only the embed path knows the IP —
//                  the Webflow and Calendly webhooks are server-to-server
//   no_embed     — Webflow-webhook submission that never ran the embed (no token, no signals):
//                  bots posting straight to webflow.com/api/v1/form/<site>
// plus `night` (score only) and `block_threshold` (reject once the summed score is reached).
import type { RiskFlag } from './types.js';

export type SpamMode = 'off' | 'score' | 'block';
export const SPAM_MODES: readonly SpamMode[] = ['off', 'score', 'block'];

export interface SpamRule {
  /** IP country: 'off' ignores geo entirely, 'score' only flags, 'block' rejects a denied country */
  geo_mode: SpamMode;
  /** ISO-3166-1 alpha-2, upper case. Empty = every country allowed. */
  geo_allow: string[];
  /** ISO-3166-1 alpha-2, upper case. Wins over geo_allow. */
  geo_deny: string[];
  /**
   * Country outside geo_allow (or on geo_deny) AND a freemail address. Deliberately a rule of its
   * own: geo alone would cost the occasional real foreign enquiry (those come from company domains),
   * freemail alone is normal in German B2B. Only the combination is junk.
   */
  geo_freemail_mode: SpamMode;
  /**
   * On the Webflow-webhook path there is no client IP, hence no `CF-IPCountry`, hence both geo
   * rules above are blind there. Switched on, the phone country (libphonenumber) stands in for the
   * missing IP country — that is what makes geo work for webhook submissions at all. Off by
   * default and switchable per site, because a phone country is a weaker signal than an IP: it is
   * what the visitor typed. An arriving IP country always wins, and `geo_allow` keeps DACH numbers
   * (CH/AT) safe.
   */
  geo_phone_fallback: boolean;
  /** browser timezone / language check */
  client_mode: SpamMode;
  /** allowed IANA timezone prefixes, e.g. ['Europe/'] */
  client_allow_tz: string[];
  /** allowed primary language subtags, e.g. ['de','en'] */
  client_allow_lang: string[];
  /** User-Agent substring blocklist (device models), e.g. ['tecno','infinix','itel'] */
  ua_mode: SpamMode;
  ua_deny: string[];
  /** submission during the night window — flag/score only, never rejects on its own */
  night_mode: 'off' | 'score';
  /** local hours [from, to) in Europe/Berlin, 0-23 */
  night_from: number;
  night_to: number;
  /** keyword blocklist over name/company/message */
  text_mode: SpamMode;
  /** lower-case substrings; a hit flags (mode 'score') or rejects (mode 'block') */
  text_deny: string[];
  /** reject once the total risk score reaches this value. null = off. */
  block_threshold: number | null;
  /** contact blocklist: 'block' rejects a listed address/name, 'score' only flags */
  contact_mode: SpamMode;
  /** lower-case; 'name@domain.de' matches exactly, '@domain.de' matches the whole domain */
  contact_deny_emails: string[];
  /** lower-case full names, whitespace collapsed ('john sample') — exact match, no substrings */
  contact_deny_names: string[];
  /** same e-mail or same full name too often */
  repeat_mode: SpamMode;
  /** earlier submissions allowed inside the window; the next one fires (2 = the third submission) */
  repeat_max: number;
  /** window in hours, 1–720 */
  repeat_window_h: number;
  /** webhook submission without any trace of the embed (no token, no signals) */
  no_embed_mode: SpamMode;
  /** client IP blocklist: 'block' rejects, 'score' only flags */
  ip_mode: SpamMode;
  /** '203.0.113.7', '198.51.100.0/24', '2001:db8::1' */
  ip_deny: string[];
}

export const DEFAULT_SPAM_RULE: SpamRule = {
  geo_mode: 'off',
  geo_allow: [],
  geo_deny: [],
  geo_freemail_mode: 'off',
  geo_phone_fallback: false,
  client_mode: 'off',
  client_allow_tz: [],
  client_allow_lang: [],
  ua_mode: 'off',
  ua_deny: [],
  night_mode: 'off',
  night_from: 1,
  night_to: 5,
  text_mode: 'off',
  text_deny: [],
  block_threshold: null,
  contact_mode: 'block', // the lists are empty by default, so this only acts once someone fills them
  contact_deny_emails: [],
  contact_deny_names: [],
  repeat_mode: 'off',
  repeat_max: 2,
  repeat_window_h: 168,
  no_embed_mode: 'off',
  ip_mode: 'block', // empty list by default, so this only acts once someone fills it
  ip_deny: [],
};

/** What the pipeline hands in — every field optional, unknown values simply produce no flag (fail-open). */
export interface SpamInput {
  /**
   * ISO-3166-1 alpha-2 from the edge (CF-IPCountry). null/unknown = no geo check, unless
   * `geo_phone_fallback` lets `phoneCountry` stand in.
   */
  country?: string | null;
  /** IANA timezone reported by the browser, e.g. 'Africa/Lagos' */
  tz?: string | null;
  /** navigator.language, e.g. 'en-NG' */
  lang?: string | null;
  /** local hour 0-23 in the reference timezone (Europe/Berlin), computed by the caller */
  hour?: number | null;
  /** phone country from libphonenumber, e.g. 'DE' */
  phoneCountry?: string | null;
  /** e-mail domain is a freemailer (gmail, gmx, web.de …) — from the e-mail stage */
  freemail?: boolean;
  /** raw User-Agent of the submitting browser */
  ua?: string | null;
  /**
   * Free-text values to scan. What the caller can offer differs per path: the embed sends only the
   * company field (`context.company`), the Webflow webhook sees the whole submission and passes
   * company, name and message. Anything absent is simply not scanned.
   */
  texts?: (string | null | undefined)[];
  /** normalized e-mail address (lower case) — contact blocklist */
  email?: string | null;
  /** full name as typed — contact blocklist (normalized here) */
  name?: string | null;
  /**
   * earlier submissions with the same e-mail or the same name inside `repeat_window_h`
   * (the higher of both counts). null = not counted (field check, nothing to count by).
   */
  repeatCount?: number | null;
  /** webhook only: neither the embed token nor its signals field arrived */
  embedMissing?: boolean;
  /** raw client IP (embed path only) — compared, never stored or logged */
  ip?: string | null;
}

export type SpamReject =
  | 'geo_denied' | 'text_denied' | 'client_denied' | 'device_denied'
  | 'contact_denied' | 'ip_denied' | 'repeat_denied' | 'embed_missing';

export interface SpamResult {
  flags: RiskFlag[];
  /** a rule in 'block' mode fired → hard reject with this reason */
  reject: SpamReject | null;
  /**
   * The country the geo rules actually ran against — for logs and the decision event (no PII).
   * Normally the IP country; with `geo_phone_fallback` on and no IP country it is the phone
   * country, and the `geo_from_phone` flag then says so whenever a geo rule fired.
   */
  country: string | null;
}

const ISO2 = /^[A-Za-z]{2}$/;

export function normCountry(v: unknown): string | null {
  return typeof v === 'string' && ISO2.test(v.trim()) ? v.trim().toUpperCase() : null;
}

/** 'de-DE' → 'de'; 'EN' → 'en'; garbage → null */
export function primaryLang(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = v.trim().toLowerCase().match(/^([a-z]{2,3})(?:[-_]|$)/);
  return m ? m[1] : null;
}

/** 'John  Sample ' → 'john sample'. Letters, digits and single spaces only; null when too short to mean anything. */
export function normName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const n = v.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return n.length >= 3 ? n : null;
}

function ipv4(v: string): number | null {
  const m = v.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((x) => x <= 255) ? ((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3] : null;
}

/** exact IPv4/IPv6 or IPv4 CIDR; '::ffff:1.2.3.4' counts as 1.2.3.4 */
export function ipDenied(ip: string, list: string[]): boolean {
  const raw = ip.trim().toLowerCase().replace(/^::ffff:(?=\d+\.)/, '');
  const v4 = ipv4(raw);
  return list.some((entry) => {
    const e = entry.trim().toLowerCase();
    if (!e) return false;
    const [net, bits] = e.split('/');
    if (bits === undefined) return e === raw;
    const n = ipv4(net); const b = Number(bits);
    if (v4 === null || n === null || !Number.isInteger(b) || b < 0 || b > 32) return false;
    const mask = b === 0 ? 0 : (0xffffffff << (32 - b)) >>> 0;
    return ((v4 & mask) >>> 0) === ((n & mask) >>> 0);
  });
}

function emailDenied(email: string, list: string[]): boolean {
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf('@');
  const domain = at > 0 ? e.slice(at) : null; // '@gmx.net'
  return list.some((x) => { const q = x.trim().toLowerCase(); return !!q && (q === e || (q.startsWith('@') && q === domain)); });
}

/** 'Africa/Lagos' → true for prefix 'Africa/'. Case-insensitive, prefix match on the raw string. */
function tzAllowed(tz: string, prefixes: string[]): boolean {
  const t = tz.toLowerCase();
  return prefixes.some((p) => {
    const q = p.trim().toLowerCase();
    return !!q && t.startsWith(q);
  });
}

function inNightWindow(hour: number, from: number, to: number): boolean {
  if (from === to) return false;
  return from < to ? hour >= from && hour < to : hour >= from || hour < to; // window may wrap midnight
}

/**
 * Evaluate the spam rules. Order matters only for `reject`: contact → ip → geo → client → device → text →
 * repeat → no_embed (first block wins),
 * so the reject reason names the strongest signal. Flags are always collected in full.
 */
export function checkSpam(i: SpamInput, r: SpamRule): SpamResult {
  const flags: RiskFlag[] = [];
  let reject: SpamResult['reject'] = null;

  // ── contact blocklist (entries listed explicitly by an operator — strongest signal, checked first) ──
  if (r.contact_mode !== 'off' && (r.contact_deny_emails.length > 0 || r.contact_deny_names.length > 0)) {
    const name = normName(i.name);
    const hitEmail = !!i.email && emailDenied(i.email, r.contact_deny_emails);
    const hitName = !!name && r.contact_deny_names.some((n) => normName(n) === name);
    if (hitEmail || hitName) {
      flags.push('contact_denied');
      if (r.contact_mode === 'block') reject = 'contact_denied';
    }
  }

  // ── IP blocklist ───────────────────────────────────────────────────────────
  if (r.ip_mode !== 'off' && r.ip_deny.length > 0 && typeof i.ip === 'string' && i.ip && ipDenied(i.ip, r.ip_deny)) {
    flags.push('ip_denied');
    if (r.ip_mode === 'block') reject ??= 'ip_denied';
  }

  // ── geo ────────────────────────────────────────────────────────────────────
  const geoOn = r.geo_mode !== 'off' || r.geo_freemail_mode !== 'off';
  const ipCountry = normCountry(i.country);
  const phoneCountry = normCountry(i.phoneCountry);
  // The IP country always wins. Only when none arrived (webhook without a client IP, host not
  // proxied through Cloudflare, T1/XX) and the remote config switched the fallback on does the phone number
  // stand in as the country. No phone country either → no geo check at all (fail-open).
  const fromPhone = !ipCountry && geoOn && r.geo_phone_fallback === true && !!phoneCountry;
  const country = ipCountry ?? (fromPhone ? phoneCountry : null);

  if (geoOn && country) {
    const deny = r.geo_deny.map((c) => c.toUpperCase());
    const allow = r.geo_allow.map((c) => c.toUpperCase());
    const denied = deny.includes(country);
    const outside = !denied && allow.length > 0 && !allow.includes(country);
    // Collected apart from `flags`: `geo_from_phone` explains a geo verdict, it is not a verdict of
    // its own — an allowed phone country (a CH number without an IP country) must stay clean.
    const geoFlags: RiskFlag[] = [];
    if (r.geo_mode !== 'off') {
      if (denied) {
        geoFlags.push('geo_denied');
        if (r.geo_mode === 'block') reject ??= 'geo_denied';
      } else if (outside) {
        geoFlags.push('geo_outside');
        if (r.geo_mode === 'block') reject ??= 'geo_denied';
      }
      // Phone says one country, the IP another — but only worth a flag when that IP country is
      // already unwanted. A German number dialled from Vienna (AT on the allow list) is normal
      // travel, not a click farm, and must not collect 40 points for it. Never when the country
      // came from the phone itself: one source can never disagree with itself.
      if ((denied || outside) && !fromPhone) {
        if (phoneCountry && phoneCountry !== country) geoFlags.push('phone_geo_mismatch');
      }
    }
    if (r.geo_freemail_mode !== 'off' && i.freemail === true && (denied || outside)) {
      geoFlags.push('geo_freemail');
      if (r.geo_freemail_mode === 'block') reject ??= 'geo_denied';
    }
    if (geoFlags.length > 0) {
      if (fromPhone) flags.push('geo_from_phone'); // source of the country — visible in log + decision event
      flags.push(...geoFlags);
    }
  }

  // ── client fingerprint (timezone / language) ────────────────────────────────
  if (r.client_mode !== 'off') {
    const tz = typeof i.tz === 'string' ? i.tz.trim() : '';
    if (tz && r.client_allow_tz.length > 0 && !tzAllowed(tz, r.client_allow_tz)) {
      flags.push('tz_foreign');
      if (r.client_mode === 'block') reject ??= 'client_denied';
    }
    const lg = primaryLang(i.lang);
    if (lg && r.client_allow_lang.length > 0 && !r.client_allow_lang.map((l) => l.toLowerCase()).includes(lg)) {
      flags.push('lang_foreign');
      if (r.client_mode === 'block') reject ??= 'client_denied';
    }
  }

  // ── device blocklist (User-Agent substrings) ───────────────────────────────
  if (r.ua_mode !== 'off' && r.ua_deny.length > 0 && typeof i.ua === 'string' && i.ua.trim()) {
    const ua = i.ua.toLowerCase();
    if (r.ua_deny.some((d) => { const q = d.trim().toLowerCase(); return !!q && ua.includes(q); })) {
      flags.push('ua_denied');
      if (r.ua_mode === 'block') reject ??= 'device_denied';
    }
  }

  // ── night window (score only) ──────────────────────────────────────────────
  if (r.night_mode === 'score' && typeof i.hour === 'number' && i.hour >= 0 && i.hour <= 23) {
    if (inNightWindow(i.hour, r.night_from, r.night_to)) flags.push('night_submit');
  }

  // ── free-text blocklist ────────────────────────────────────────────────────
  if (r.text_mode !== 'off' && r.text_deny.length > 0) {
    const hay = (i.texts ?? []).filter((t): t is string => typeof t === 'string' && !!t.trim()).join(' \n ').toLowerCase();
    if (hay && r.text_deny.some((w) => { const q = w.trim().toLowerCase(); return !!q && hay.includes(q); })) {
      flags.push('text_denied');
      if (r.text_mode === 'block') reject ??= 'text_denied';
    }
  }

  // ── repeated contact ───────────────────────────────────────────────────────
  if (r.repeat_mode !== 'off' && typeof i.repeatCount === 'number' && i.repeatCount >= Math.max(1, r.repeat_max)) {
    flags.push('repeat_contact');
    if (r.repeat_mode === 'block') reject ??= 'repeat_denied';
  }

  // ── webhook submission that bypassed the embed ─────────────────────────────
  if (r.no_embed_mode !== 'off' && i.embedMissing === true) {
    flags.push('embed_missing');
    if (r.no_embed_mode === 'block') reject ??= 'embed_missing';
  }

  return { flags, reject, country };
}

/** Local hour in a fixed reference zone — the night window is defined in German local time. */
export function localHour(now: number, timeZone = 'Europe/Berlin'): number | null {
  try {
    const h = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone }).format(new Date(now));
    const n = Number.parseInt(h, 10);
    return Number.isFinite(n) && n >= 0 && n <= 23 ? n : null;
  } catch {
    return null; // unknown zone in a stripped runtime → no night flag, never a crash
  }
}
