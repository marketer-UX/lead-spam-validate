// Form-field name normalization + DE/EN synonyms (copied from the lead store so both sides agree).
export type StdField = 'first_name' | 'last_name' | 'email' | 'phone' | 'company' | 'message' | 'name';

export const SYNONYMS: Record<string, StdField> = {
  vorname: 'first_name', firstname: 'first_name', first_name: 'first_name', given_name: 'first_name',
  nachname: 'last_name', lastname: 'last_name', last_name: 'last_name', surname: 'last_name', family_name: 'last_name',
  email: 'email', e_mail: 'email', email_address: 'email', e_mail_adresse: 'email', email_adresse: 'email', mail: 'email', emailadresse: 'email',
  telefon: 'phone', telefonnummer: 'phone', tel: 'phone', phone: 'phone', phone_number: 'phone', telefon_nummer: 'phone',
  mobil: 'phone', mobile: 'phone', handynummer: 'phone', handy: 'phone', rufnummer: 'phone',
  firma: 'company', company: 'company', unternehmen: 'company', betrieb: 'company', firma_betrieb: 'company', firmenname: 'company',
  nachricht: 'message', message: 'message', anliegen: 'message', mitteilung: 'message',
  name: 'name', full_name: 'name', fullname: 'name', vor_und_nachname: 'name', ihr_name: 'name',
};

/** "E-Mail *" → "e_mail" (Webflow adds the required asterisk to display names). */
export function normKey(k: string): string {
  return k.toLowerCase().replace(/[-\s]+/g, '_').replace(/[^a-z0-9_äöüß]/g, '').replace(/_+/g, '_').replace(/^_|_$/g, '');
}

export interface MappedFields {
  std: Partial<Record<StdField, string>>;
  /** original key that produced each std field (to drop it from forwarded bodies) */
  keys: Partial<Record<StdField, string>>;
}

export function mapFields(data: Record<string, unknown>): MappedFields {
  const std: MappedFields['std'] = {};
  const keys: MappedFields['keys'] = {};
  for (const [k, v] of Object.entries(data)) {
    if (typeof v !== 'string') continue;
    const mapped = SYNONYMS[normKey(k)];
    if (!mapped) continue;
    const sv = v.trim();
    if (!sv) continue;
    if (mapped === 'email' && std.email) continue; // first email wins
    if (mapped === 'phone' && std.phone) continue;
    std[mapped] = sv;
    keys[mapped] = k;
  }
  return { std, keys };
}
