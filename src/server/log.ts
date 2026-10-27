// JSON-lines logger. Never log raw email/phone/name/IP/token/body — callers pass hashes and classes only.
type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold: Level = 'info';

export function setLogLevel(l: Level): void { threshold = l; }

function emit(level: Level, ev: string, fields?: Record<string, unknown>): void {
  if (ORDER[level] < ORDER[threshold]) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, ev, ...(fields ?? {}) });
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export const log = {
  debug: (ev: string, f?: Record<string, unknown>) => emit('debug', ev, f),
  info: (ev: string, f?: Record<string, unknown>) => emit('info', ev, f),
  warn: (ev: string, f?: Record<string, unknown>) => emit('warn', ev, f),
  error: (ev: string, f?: Record<string, unknown>) => emit('error', ev, f),
};

export function errMsg(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 200) : String(e).slice(0, 200);
}
