// Serves the built embed from dist/embed/v1/validate.js (read once, re-read when the file changes on disk).
import { readFileSync, statSync } from 'node:fs';
import { Hono } from 'hono';
import { sha256Hex } from '../hash.js';

export function embedRoutes(filePath: string): Hono {
  const r = new Hono();
  let cache: { body: string; etag: string; mtime: number } | null = null;
  const load = () => {
    try {
      const st = statSync(filePath);
      if (!cache || cache.mtime !== st.mtimeMs) {
        const body = readFileSync(filePath, 'utf8');
        cache = { body, etag: `"${sha256Hex(body).slice(0, 16)}"`, mtime: st.mtimeMs };
      }
      return cache;
    } catch { return null; }
  };
  r.get('/embed/v1/validate.js', (c) => {
    const e = load();
    if (!e) return c.text('// embed not built (run npm run build:embed)', 404, { 'Content-Type': 'application/javascript; charset=utf-8' });
    const headers = {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=300, stale-while-revalidate=86400',
      'ETag': e.etag,
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff',
    };
    if (c.req.header('if-none-match') === e.etag) return c.body(null, 304, headers);
    return c.body(e.body, 200, headers);
  });
  return r;
}
