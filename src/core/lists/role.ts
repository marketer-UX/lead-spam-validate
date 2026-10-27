// Role / functional mailboxes. Flag only (`role_account`) — in the German Mittelstand info@/kontakt@ is often the ONLY address.
export const ROLE_LOCAL_PARTS: ReadonlySet<string> = new Set<string>([
  'info', 'kontakt', 'contact', 'office', 'buero', 'büro', 'mail', 'post', 'email', 'e-mail', 'hallo', 'hello', 'hi', 'team',
  'admin', 'administrator', 'webmaster', 'hostmaster', 'postmaster', 'abuse', 'noc', 'security', 'root', 'sysadmin',
  'support', 'help', 'helpdesk', 'service', 'kundenservice', 'kundendienst', 'customerservice', 'customer-service',
  'sales', 'vertrieb', 'verkauf', 'anfrage', 'anfragen', 'angebot', 'angebote', 'bestellung', 'order', 'orders', 'shop',
  'billing', 'rechnung', 'rechnungen', 'buchhaltung', 'finance', 'finanzen', 'accounting', 'invoice', 'invoices',
  'marketing', 'presse', 'press', 'pr', 'media', 'newsletter', 'news', 'kommunikation',
  'jobs', 'job', 'karriere', 'career', 'careers', 'bewerbung', 'bewerbungen', 'hr', 'personal', 'recruiting', 'recruitment',
  'noreply', 'no-reply', 'no_reply', 'donotreply', 'do-not-reply', 'mailer-daemon', 'bounce', 'bounces',
  'datenschutz', 'privacy', 'legal', 'recht', 'compliance', 'impressum', 'geschaeftsfuehrung', 'geschäftsführung', 'gf', 'ceo',
  'zentrale', 'empfang', 'reception', 'sekretariat', 'assistenz', 'verwaltung', 'management', 'direktion', 'vorstand',
]);
