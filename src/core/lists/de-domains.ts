// Known-good mail domains for the typo suggester (major German providers + common DACH/intl providers).
// Order matters only for tie-breaks (earlier = preferred suggestion).
export const SUGGEST_DOMAINS: readonly string[] = [
  'gmail.com', 'web.de', 'gmx.de', 't-online.de', 'outlook.de', 'hotmail.de', 'googlemail.com', 'yahoo.de', 'icloud.com',
  'posteo.de', 'mailbox.org',
  'outlook.com', 'hotmail.com', 'yahoo.com', 'gmx.net', 'gmx.at', 'gmx.ch', 'live.de', 'live.com', 'freenet.de', 'arcor.de',
  'aol.com', 'protonmail.com', 'proton.me', 'me.com', 'mail.de', 'magenta.de', 'vodafone.de', 'online.de', 'email.de',
  'bluewin.ch', 'aon.at', 'a1.net', 'hotmail.co.uk', 'yahoo.co.uk', 'outlook.at',
];

/** Domains that are legit on their own and must never trigger a suggestion (they are close to a suggest domain). */
export const KNOWN_GOOD_DOMAINS: ReadonlySet<string> = new Set<string>([
  ...SUGGEST_DOMAINS,
  'gmail.de', 'mail.com', 'email.com', 'gmx.com', 'gmx.eu', 'gmx.li', 'gmx.org', 'gmx.info', 'gmx.biz', 'web.com', 'live.at',
  'yahoo.fr', 'yahoo.it', 'hotmail.fr', 'hotmail.it', 'outlook.fr', 'outlook.it', 'posteo.net', 'posteo.eu', 'mailbox.de',
  'tutanota.com', 'tutanota.de', 'tuta.io', 'tuta.com', 'hey.com', 'pm.me', 'msn.com', 'ymail.com', 'mac.com', 'zoho.com',
  'sunrise.ch', 'hispeed.ch', 'chello.at', 'drei.at', 'inode.at', 'o2online.de', 'alice.de', 'unitybox.de', 'kabelmail.de',
  '1und1.de', 'onlinehome.de', 'emailn.de', 'firemail.de', 'smart-mail.de',
]);
