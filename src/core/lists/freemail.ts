// Consumer / free email providers. Flag only (`freemail`) — never a reject (German B2B: gmx/web.de/t-online are normal).
// Seeded from Worldmonitor `convex/lib/emailDomain.ts` FREE_EMAIL_DOMAINS + German additions.
export const FREEMAIL_DOMAINS: ReadonlySet<string> = new Set<string>([
  // global
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.de', 'yahoo.fr', 'yahoo.co.uk', 'yahoo.co.jp', 'ymail.com', 'rocketmail.com',
  'hotmail.com', 'hotmail.de', 'hotmail.fr', 'hotmail.co.uk', 'hotmail.it', 'outlook.com', 'outlook.de', 'outlook.fr', 'outlook.at',
  'live.com', 'live.de', 'live.at', 'live.fr', 'msn.com', 'aol.com', 'aol.de', 'icloud.com', 'me.com', 'mac.com',
  'protonmail.com', 'protonmail.ch', 'proton.me', 'pm.me', 'mail.com', 'email.com', 'zoho.com', 'zohomail.eu', 'yandex.com', 'yandex.ru',
  'gmx.com', 'gmx.net', 'gmx.de', 'gmx.at', 'gmx.ch', 'gmx.eu', 'gmx.li', 'gmx.org', 'gmx.info', 'gmx.biz',
  'web.de', 'mail.ru', 'inbox.com', 'inbox.lv', 'fastmail.com', 'fastmail.fm', 'tutanota.com', 'tutanota.de', 'tuta.io', 'tuta.com', 'hey.com',
  'qq.com', '163.com', '126.com', 'sina.com', 'foxmail.com', 'rediffmail.com',
  'wanadoo.fr', 'free.fr', 'laposte.net', 'orange.fr', 'sfr.fr', 'libero.it', 'virgilio.it', 'bluewin.ch', 'sunrise.ch', 'hispeed.ch',
  // german / dach
  't-online.de', 'magenta.de', 'freenet.de', 'arcor.de', 'vodafone.de', 'vodafonemail.de', 'unitybox.de', 'kabelmail.de',
  '1und1.de', 'online.de', 'onlinehome.de', 'posteo.de', 'posteo.net', 'mailbox.org', 'mail.de', 'email.de', 'emailn.de',
  'firemail.de', 'smart-mail.de', 'gmx.de', 'o2online.de', 'o2mail.de', 'alice.de', 'alice-dsl.de', 'hanmail.net',
  'aon.at', 'a1.net', 'chello.at', 'drei.at', 'kabsi.at', 'inode.at', 'utanet.at',
]);
