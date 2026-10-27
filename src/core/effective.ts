// Effective configuration: pure cascade global → site → form (null/undefined = inherit) plus the
// validator for the remote config. No I/O, no env — everything comes in as arguments.
import { DEFAULT_SPAM_RULE, SPAM_MODES, type SpamMode, type SpamRule } from './spam.js';
import { DEFAULT_HONEYPOT } from './types.js';

export type EmbedMode = 'observe' | 'enforce' | 'off';

export interface ValidateMessages {
  email: string;
  phone: string;
}

/** Per-form rule. Every field is optional; `null` means "inherit from the site". */
export interface FormRule {
  enabled?: boolean | null;
  fields?: { email?: boolean | null; phone?: boolean | null } | null;
  mode?: EmbedMode | null;
  strict?: boolean | null;
  /** denied dial prefixes; `null` means "inherit from the site" */
  phone_deny_prefixes?: string[] | null;
  /** only the spam fields this form overrides; everything else inherits from the site */
  spam?: Partial<SpamRule> | null;
}

export interface GlobalConfig {
  mode: EmbedMode;
  strict: boolean;
  rate_limit_hard: boolean;
  country: string;
  messages: ValidateMessages;
  /**
   * Country calling codes that must never come in: digits without the plus, matched as a prefix of
   * the parsed E.164 calling code (`['1','2','7','8','9']` = everything outside Europe, +1 North
   * America included). A hit rejects the number like any other invalid one (`phone_invalid`).
   * Empty = rule off. Lives next to `country` and `messages.phone`, not in the spam layer: it is a
   * phone rule that blocks in the browser and on the webhook path, not a scored spam signal.
   */
  phone_deny_prefixes: string[];
  /** complete spam rule set — sites and forms override single fields of it */
  spam: SpamRule;
}

export interface SiteRuntimeConfig {
  slug: string;
  name: string | null;
  active: boolean;
  origins: string[];
  webflow_site_id: string | null;
  honeypot: string | null;
  country: string | null;
  mode: EmbedMode | null;
  strict: boolean | null;
  rate_limit_hard: boolean | null;
  messages: ValidateMessages | null;
  /** denied dial prefixes; null/absent = inherit from global */
  phone_deny_prefixes: string[] | null;
  /** only the spam fields this site overrides; null/absent = everything from global */
  spam: Partial<SpamRule> | null;
  forward: boolean;
  forms: Record<string, FormRule>;
  /** merged from the service env (SITES_JSON) — never delivered by the config server */
  forward_token?: string;
  forward_origin?: string;
}

export interface RemoteConfig {
  version: string;
  global: GlobalConfig;
  sites: SiteRuntimeConfig[];
}

/** What the rest of the service sees: the last good config plus where it came from. */
export interface RuntimeConfig {
  source: 'remote' | 'env';
  version: string;
  fetched_at: string | null;
  global: GlobalConfig;
  sites: Map<string, SiteRuntimeConfig>;
  /** ALLOWED_ORIGINS ∪ origins of all active sites */
  allowedOrigins(): string[];
  /** slug of the site owning this origin (exact match wins over wildcard), else null */
  siteForOrigin(origin: string | null | undefined): string | null;
}

export interface EffectiveConfig {
  mode: EmbedMode;
  strict: boolean;
  rate_limit_hard: boolean;
  country: string;
  honeypot: string;
  messages: ValidateMessages;
  /** denied dial prefixes, global → site → form (the deepest list wins as a whole) */
  phone_deny_prefixes: string[];
  /** global → site → form merged, field by field */
  spam: SpamRule;
  /** false = form/site excluded from validation → accept without any check */
  enabled: boolean;
  fields: { email: boolean; phone: boolean };
  forward: boolean;
  forward_token?: string;
  forward_origin?: string;
  /** false = the slug is not in the config (remote source → observe, env source → env defaults) */
  known_site: boolean;
}

export const DEFAULT_MESSAGES: ValidateMessages = {
  email: 'Please enter a valid email address.',
  phone: 'Please enter a valid phone number.',
};

export const DEFAULT_COUNTRY = 'DE';

export const MODES: readonly EmbedMode[] = ['observe', 'enforce', 'off'];

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const HONEYPOT_RE = /^[a-zA-Z][a-zA-Z0-9_-]{1,63}$/;
const ORIGIN_RE = /^https?:\/\/(\*\.)?[a-z0-9.-]+(:\d{1,5})?$/;
const SITE_ID_RE = /^[a-f0-9]{24}$/;
const COUNTRY_RE = /^[A-Za-z]{2}$/;
/** denied dial prefix: digits only, without the plus — '1', '49', '234' … */
const DIAL_PREFIX_RE = /^[0-9]{1,4}$/;

export const LIMITS = {
  sites: 200,
  formsPerSite: 100,
  originsPerSite: 50,
  messageChars: 200,
  formNameChars: 100,
  siteNameChars: 100,
  versionChars: 128,
  /** denied dial prefixes (phone rule) */
  phoneDenyPrefixes: 20,
  phonePrefixDigits: 4,
  /** spam layer */
  spamCountries: 60,
  spamTzPrefixes: 25,
  spamLangs: 25,
  spamDenyWords: 100,
  spamWordChars: 60,
  /** contact blocklist */
  contactDenyEntries: 200,
  contactEntryChars: 120,
  ipDenyEntries: 500,
} as const;

/**
 * Cascade global → site → form. `site` is the slug (`normalizeSite`d by the caller),
 * `form` the form key (Webflow `data-name`) or null.
 */
export function effective(rt: RuntimeConfig, site: string | null | undefined, form?: string | null): EffectiveConfig {
  const g = rt.global;
  const s = site ? rt.sites.get(site) : undefined;
  const known = !!s;
  const f = (s && form && s.forms ? s.forms[form] : undefined) ?? undefined;

  // Unknown slug: global defaults, but never enforce when the config server is the source of truth
  // (a site nobody configured must not start blocking). Env source keeps the plain env behaviour.
  const baseMode = known ? g.mode : (rt.source === 'remote' ? 'observe' : g.mode);
  const siteActive = s ? s.active !== false : true;
  const formEnabled = f?.enabled !== false;
  const enabled = siteActive && formEnabled;

  let mode: EmbedMode = f?.mode ?? s?.mode ?? baseMode;
  if (!siteActive) mode = 'off'; // site switched off in the remote config → embed idle

  return {
    mode,
    strict: f?.strict ?? s?.strict ?? g.strict,
    rate_limit_hard: s?.rate_limit_hard ?? g.rate_limit_hard,
    country: s?.country ?? g.country ?? DEFAULT_COUNTRY,
    honeypot: s?.honeypot ?? DEFAULT_HONEYPOT,
    messages: { ...g.messages, ...(s?.messages ?? {}) },
    phone_deny_prefixes: f?.phone_deny_prefixes ?? s?.phone_deny_prefixes ?? g.phone_deny_prefixes,
    spam: { ...g.spam, ...(s?.spam ?? {}), ...(f?.spam ?? {}) },
    enabled,
    fields: { email: f?.fields?.email !== false, phone: f?.fields?.phone !== false },
    forward: s?.forward === true,
    ...(s?.forward_token ? { forward_token: s.forward_token } : {}),
    ...(s?.forward_origin ? { forward_origin: s.forward_origin } : {}),
    known_site: known,
  };
}

// ── validation of the remote payload ─────────────────────────────────────────
function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
function str(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s && s.length <= max ? s : null;
}
function optBool(v: unknown): boolean | null | undefined {
  if (v === undefined || v === null) return null;
  return typeof v === 'boolean' ? v : undefined; // undefined = invalid
}
function optMode(v: unknown): EmbedMode | null | undefined {
  if (v === undefined || v === null) return null;
  return typeof v === 'string' && (MODES as readonly string[]).includes(v) ? v as EmbedMode : undefined;
}
function optMessages(v: unknown): ValidateMessages | null | undefined {
  if (v === undefined || v === null) return null;
  if (!isObj(v)) return undefined;
  const email = str(v.email, LIMITS.messageChars);
  const phone = str(v.phone, LIMITS.messageChars);
  if (!email || !phone) return undefined;
  return { email, phone };
}
function optCountry(v: unknown): string | null | undefined {
  if (v === undefined || v === null || v === '') return null;
  return typeof v === 'string' && COUNTRY_RE.test(v) ? v.toUpperCase() : undefined;
}

function parseForms(v: unknown): Record<string, FormRule> | null {
  if (v === undefined || v === null) return {};
  if (!isObj(v)) return null;
  const keys = Object.keys(v);
  if (keys.length > LIMITS.formsPerSite) return null;
  const out: Record<string, FormRule> = {};
  for (const key of keys) {
    const name = str(key, LIMITS.formNameChars);
    if (!name) return null;
    const raw = v[key];
    if (!isObj(raw)) return null;
    const enabled = optBool(raw.enabled);
    const mode = optMode(raw.mode);
    const strict = optBool(raw.strict);
    const spam = optSpam(raw.spam);
    const denyPrefixes = optDialPrefixes(raw.phone_deny_prefixes);
    if (enabled === undefined || mode === undefined || strict === undefined || spam === undefined
      || denyPrefixes === undefined) return null;
    let fields: FormRule['fields'] = null;
    if (raw.fields !== undefined && raw.fields !== null) {
      if (!isObj(raw.fields)) return null;
      const e = optBool(raw.fields.email);
      const p = optBool(raw.fields.phone);
      if (e === undefined || p === undefined) return null;
      fields = { email: e, phone: p };
    }
    out[name] = { enabled, fields, mode, strict, phone_deny_prefixes: denyPrefixes, spam };
  }
  return out;
}


const TZ_PREFIX_RE = /^[A-Za-z][A-Za-z0-9_+\-\/]{0,59}$/;
const LANG_RE = /^[A-Za-z]{2,3}$/;

/** list of short strings: null = absent (inherit), undefined = invalid, [] = explicitly empty */
function optList(v: unknown, max: number, itemMax: number, re: RegExp, upper = false): string[] | null | undefined {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v)) return undefined;
  if (v.length > max) return undefined;
  const out: string[] = [];
  for (const raw of v) {
    if (typeof raw !== 'string') return undefined;
    const s = raw.trim();
    if (!s) continue; // empty entries from a textarea are dropped, not an error
    if (s.length > itemMax || !re.test(s)) return undefined;
    const n = upper ? s.toUpperCase() : s.toLowerCase();
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * Denied dial prefixes of one cascade level. null = absent (inherit), undefined = invalid payload
 * (discards the whole config, like every other field), [] = explicitly empty = rule off.
 */
function optDialPrefixes(v: unknown): string[] | null | undefined {
  return optList(v, LIMITS.phoneDenyPrefixes, LIMITS.phonePrefixDigits, DIAL_PREFIX_RE);
}

function optSpamMode(v: unknown): SpamMode | null | undefined {
  if (v === undefined || v === null) return null;
  return typeof v === 'string' && (SPAM_MODES as readonly string[]).includes(v) ? v as SpamMode : undefined;
}

/** IPv4, IPv4/CIDR or IPv6 (hex and colons, optionally with an embedded IPv4) */
const IP_ENTRY_RE = /^(?:\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?|[0-9a-fA-F:.]{2,41})$/;

/** 'name@domain.de' or '@domain.de' */
const CONTACT_EMAIL_RE = /^[^\s@]*@[^\s@]+\.[^\s@]+$/;

function optInt(v: unknown, min: number, max: number): number | null | undefined {
  if (v === undefined || v === null) return null;
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : undefined;
}

function optHour(v: unknown): number | null | undefined {
  if (v === undefined || v === null) return null;
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 23 ? v : undefined;
}

/**
 * Spam rule from the remote config. Returns only the fields actually set (site/form overrides merge into
 * global field by field). null = nothing set, undefined = invalid payload → whole config rejected.
 */
function optSpam(v: unknown): Partial<SpamRule> | null | undefined {
  if (v === undefined || v === null) return null;
  if (!isObj(v)) return undefined;
  const out: Partial<SpamRule> = {};

  for (const k of ['geo_mode', 'geo_freemail_mode', 'client_mode', 'ua_mode', 'text_mode', 'contact_mode', 'repeat_mode', 'no_embed_mode', 'ip_mode'] as const) {
    const m = optSpamMode(v[k]);
    if (m === undefined) return undefined;
    if (m !== null) out[k] = m;
  }
  if (v.night_mode !== undefined && v.night_mode !== null) {
    if (v.night_mode !== 'off' && v.night_mode !== 'score') return undefined;
    out.night_mode = v.night_mode;
  }

  // Boolean switch, inheritable like every other field: absent = inherit, anything but a boolean
  // discards the whole config (a half-understood payload must never widen or narrow the rules).
  const phoneFallback = optBool(v.geo_phone_fallback);
  if (phoneFallback === undefined) return undefined;
  if (phoneFallback !== null) out.geo_phone_fallback = phoneFallback;

  const allow = optList(v.geo_allow, LIMITS.spamCountries, 2, COUNTRY_RE, true);
  const deny = optList(v.geo_deny, LIMITS.spamCountries, 2, COUNTRY_RE, true);
  const tz = optList(v.client_allow_tz, LIMITS.spamTzPrefixes, 60, TZ_PREFIX_RE);
  const langs = optList(v.client_allow_lang, LIMITS.spamLangs, 3, LANG_RE);
  const words = optList(v.text_deny, LIMITS.spamDenyWords, LIMITS.spamWordChars, /^[^\u0000-\u001f]+$/);
  const uas = optList(v.ua_deny, LIMITS.spamDenyWords, LIMITS.spamWordChars, /^[^\u0000-\u001f]+$/);
  const denyEmails = optList(v.contact_deny_emails, LIMITS.contactDenyEntries, LIMITS.contactEntryChars, CONTACT_EMAIL_RE);
  const denyIps = optList(v.ip_deny, LIMITS.ipDenyEntries, 43, IP_ENTRY_RE);
  if (denyIps === undefined) return undefined;
  if (denyIps) out.ip_deny = denyIps;
  const denyNames = optList(v.contact_deny_names, LIMITS.contactDenyEntries, LIMITS.contactEntryChars, /^[^\u0000-\u001f]+$/);
  if (allow === undefined || deny === undefined || tz === undefined || langs === undefined
    || words === undefined || uas === undefined || denyEmails === undefined || denyNames === undefined) return undefined;
  if (denyEmails) out.contact_deny_emails = denyEmails;
  if (denyNames) out.contact_deny_names = denyNames.map((n) => n.replace(/\s+/g, ' '));
  if (allow) out.geo_allow = allow;
  if (deny) out.geo_deny = deny;
  if (tz) out.client_allow_tz = tz;
  if (langs) out.client_allow_lang = langs;
  if (words) out.text_deny = words;
  if (uas) out.ua_deny = uas;

  const from = optHour(v.night_from);
  const to = optHour(v.night_to);
  if (from === undefined || to === undefined) return undefined;
  if (from !== null) out.night_from = from;
  if (to !== null) out.night_to = to;

  const repeatMax = optInt(v.repeat_max, 1, 50);
  const repeatWindow = optInt(v.repeat_window_h, 1, 720);
  if (repeatMax === undefined || repeatWindow === undefined) return undefined;
  if (repeatMax !== null) out.repeat_max = repeatMax;
  if (repeatWindow !== null) out.repeat_window_h = repeatWindow;

  if (v.block_threshold !== undefined && v.block_threshold !== null) {
    const t = v.block_threshold;
    if (typeof t !== 'number' || !Number.isInteger(t) || t < 1 || t > 1000) return undefined;
    out.block_threshold = t;
  } else if (v.block_threshold === null) {
    out.block_threshold = null; // explicit "off", overrides an inherited threshold
  }
  return out;
}

function parseGlobal(v: unknown): GlobalConfig | null {
  if (!isObj(v)) return null;
  const mode = optMode(v.mode);
  const strict = optBool(v.strict);
  const rlh = optBool(v.rate_limit_hard);
  const country = optCountry(v.country);
  const messages = optMessages(v.messages);
  const spam = optSpam(v.spam);
  const denyPrefixes = optDialPrefixes(v.phone_deny_prefixes);
  if (mode === undefined || strict === undefined || rlh === undefined || country === undefined
    || messages === undefined || spam === undefined || denyPrefixes === undefined) return null;
  return {
    mode: mode ?? 'observe',
    strict: strict ?? false,
    rate_limit_hard: rlh ?? false,
    country: country ?? DEFAULT_COUNTRY,
    messages: { ...DEFAULT_MESSAGES, ...(messages ?? {}) },
    phone_deny_prefixes: denyPrefixes ?? [], // absent = rule off
    spam: { ...DEFAULT_SPAM_RULE, ...(spam ?? {}) },
  };
}

function parseSite(v: unknown): SiteRuntimeConfig | null {
  if (!isObj(v)) return null;
  const slug = typeof v.slug === 'string' ? v.slug.trim().toLowerCase() : '';
  if (!SLUG_RE.test(slug)) return null;
  if (v.origins !== undefined && v.origins !== null && !Array.isArray(v.origins)) return null;
  const rawOrigins = Array.isArray(v.origins) ? v.origins : [];
  if (rawOrigins.length > LIMITS.originsPerSite) return null;
  const origins: string[] = [];
  for (const o of rawOrigins) {
    if (typeof o !== 'string') return null;
    const s = o.trim().toLowerCase().replace(/\/+$/, '');
    if (!ORIGIN_RE.test(s)) return null;
    if (!origins.includes(s)) origins.push(s);
  }
  const mode = optMode(v.mode);
  const strict = optBool(v.strict);
  const rlh = optBool(v.rate_limit_hard);
  const country = optCountry(v.country);
  const messages = optMessages(v.messages);
  const active = optBool(v.active);
  const forwardOn = optBool(v.forward);
  const spam = optSpam(v.spam);
  const denyPrefixes = optDialPrefixes(v.phone_deny_prefixes);
  if (mode === undefined || strict === undefined || rlh === undefined || country === undefined
    || messages === undefined || active === undefined || forwardOn === undefined || spam === undefined
    || denyPrefixes === undefined) return null;
  let honeypot: string | null = null;
  if (v.honeypot !== undefined && v.honeypot !== null && v.honeypot !== '') {
    if (typeof v.honeypot !== 'string' || !HONEYPOT_RE.test(v.honeypot)) return null;
    honeypot = v.honeypot;
  }
  let siteId: string | null = null;
  if (v.webflow_site_id !== undefined && v.webflow_site_id !== null && v.webflow_site_id !== '') {
    if (typeof v.webflow_site_id !== 'string' || !SITE_ID_RE.test(v.webflow_site_id.toLowerCase())) return null;
    siteId = v.webflow_site_id.toLowerCase();
  }
  let name: string | null = null;
  if (v.name !== undefined && v.name !== null && v.name !== '') {
    name = str(v.name, LIMITS.siteNameChars);
    if (!name) return null;
  }
  const forms = parseForms(v.forms);
  if (!forms) return null;
  return {
    slug, name, active: active ?? true, origins, webflow_site_id: siteId, honeypot, country,
    mode, strict, rate_limit_hard: rlh, messages, phone_deny_prefixes: denyPrefixes, spam,
    forward: forwardOn ?? false, forms,
  };
}

/**
 * Validate + normalize the remote config payload. Returns null when ANYTHING is off — the caller keeps
 * its last good config then (fail-safe: a broken config server must never widen or narrow the rules).
 */
export function parseRemoteConfig(json: unknown): RemoteConfig | null {
  if (!isObj(json)) return null;
  const version = str(json.version, LIMITS.versionChars);
  if (!version) return null;
  const global = parseGlobal(json.global);
  if (!global) return null;
  if (!Array.isArray(json.sites)) return null;
  if (json.sites.length > LIMITS.sites) return null;
  const sites: SiteRuntimeConfig[] = [];
  const seen = new Set<string>();
  for (const raw of json.sites) {
    const site = parseSite(raw);
    if (!site) return null;
    if (seen.has(site.slug)) return null; // ambiguous config
    seen.add(site.slug);
    sites.push(site);
  }
  return { version, global, sites };
}
