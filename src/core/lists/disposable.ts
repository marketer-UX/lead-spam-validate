// Disposable / throwaway domains → hard reject (`disposable`).
// Base: npm `disposable-email-domains` (MIT, ~120k domains + wildcard suffix list). Plus hand-curated extras
// (seeded from Worldmonitor `server/_shared/email-validation.ts`) and an optional runtime refresh from GitHub raw
// (same idea as AfterShip's EnableAutoUpdateDisposable). Refresh is wired in src/server (not here) to keep core pure.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const BASE: string[] = require('disposable-email-domains/index.json');
const WILDCARD: string[] = require('disposable-email-domains/wildcard.json');

export const DISPOSABLE_EXTRA: readonly string[] = [
  'guerrillamail.com', 'guerrillamail.de', 'guerrillamail.net', 'guerrillamail.org', 'guerrillamailblock.com', 'grr.la',
  'sharklasers.com', 'spam4.me', 'tempmail.com', 'temp-mail.org', 'temp-mail.io', 'throwaway.email', 'throwaway.com',
  'mailinator.com', 'mailnesia.com', 'maildrop.cc', 'yopmail.com', 'yopmail.fr', 'yopmail.net', 'trashmail.com', 'trashmail.me',
  'trashmail.net', 'trashmail.de', 'dispostable.com', 'discard.email', 'fakeinbox.com', 'fakemail.net', 'getnada.com', 'nada.email',
  'tempinbox.com', 'tempr.email', 'tempmailaddress.com', 'emailondeck.com', '33mail.com', 'mohmal.com', 'mohmal.im', 'mohmal.in',
  'harakirimail.com', 'crazymailing.com', 'inboxbear.com', 'mailcatch.com', 'mintemail.com', 'mt2015.com', 'spamgourmet.com',
  'spamgourmet.net', 'mailexpire.com', 'mailforspam.com', 'safetymail.info', 'trashymail.com', 'mytemp.email', 'tempail.com',
  'burnermail.io', 'passinbox.com', 'passmail.net', 'passmail.com', 'silomails.com', 'slmail.me', 'spam.me', 'spambox.us',
  'wegwerfmail.de', 'wegwerfemail.de', 'wegwerf-email.de', 'wegwerfadresse.de', 'trash-mail.com', 'trash-mail.de', 'spoofmail.de',
  'squizzy.de', 'muellmail.com', 'mail-temporaire.fr', '10minutemail.com', '10minutemail.de', '10minutemail.net', '20minutemail.com',
  'emailfake.com', 'email-fake.com', 'fakemailgenerator.com', 'mailsac.com', 'inboxkitten.com', 'tempmailo.com', 'temp-mail.ru',
];

/** Mutable at runtime (server-side refresh adds to it). Exact-domain set. */
export const DISPOSABLE_DOMAINS: Set<string> = new Set<string>([...BASE, ...DISPOSABLE_EXTRA]);

/** Wildcard suffixes: any subdomain of these is disposable (e.g. `foo.10mail.org`). */
export const DISPOSABLE_WILDCARDS: Set<string> = new Set<string>(WILDCARD);

/** Domains that must never be classified as disposable even if a list says so (safety valve). */
export const DISPOSABLE_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  'gmail.com', 'googlemail.com', 'web.de', 'gmx.de', 'gmx.net', 'gmx.at', 'gmx.ch', 't-online.de', 'outlook.com', 'outlook.de',
  'hotmail.com', 'hotmail.de', 'yahoo.com', 'yahoo.de', 'icloud.com', 'posteo.de', 'mailbox.org', 'protonmail.com', 'proton.me',
  'freenet.de', 'arcor.de', 'mail.de', 'email.de', 'magenta.de', 'aol.com', 'live.de', 'live.com', 'me.com',
]);

export function isDisposableDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  if (DISPOSABLE_ALLOWLIST.has(d)) return false;
  if (DISPOSABLE_DOMAINS.has(d)) return true;
  // subdomain / wildcard match: a.b.example.com → check b.example.com, example.com
  const parts = d.split('.');
  for (let i = 1; i < parts.length - 1; i++) {
    const suffix = parts.slice(i).join('.');
    if (DISPOSABLE_WILDCARDS.has(suffix) || DISPOSABLE_DOMAINS.has(suffix)) return true;
  }
  return false;
}

/** Merge additional domains (runtime refresh). Returns number of new entries. */
export function addDisposableDomains(domains: Iterable<string>): number {
  let added = 0;
  for (const raw of domains) {
    const d = raw.trim().toLowerCase();
    if (!d || d.startsWith('#') || d.includes(' ')) continue;
    if (!DISPOSABLE_DOMAINS.has(d)) { DISPOSABLE_DOMAINS.add(d); added++; }
  }
  return added;
}
