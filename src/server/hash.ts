import { createHash } from 'node:crypto';

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
export function emailHash(normalizedEmail: string): string {
  return sha256Hex(normalizedEmail.trim().toLowerCase());
}
export function phoneHash(e164: string): string {
  return sha256Hex(e164);
}
/** DSGVO: IPs are never stored in clear; daily salt → correlation only within a day. */
export function ipHash(ip: string, salt: string, now: number = Date.now()): string {
  const day = new Date(now).toISOString().slice(0, 10);
  return sha256Hex(`${salt}:${day}:${ip}`).slice(0, 32);
}
