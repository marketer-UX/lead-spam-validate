#!/usr/bin/env node
// Builds the browser embed: src/embed/validate.ts -> dist/embed/v1/validate.js
// IIFE, minified, ES2017, zero runtime deps. Then hard asserts (size + content).
import { build } from 'esbuild';
import { readFileSync, statSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'dist/embed/v1/validate.js');
const MAX_BYTES = 10 * 1024; // size budget of the shipped embed

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

// Keep it short: the banner counts toward the size budget. Docs live in docs/CONTRACT.md.
const BANNER = `/*! lead-spam-validate v${pkg.version} <script src=.../embed/v1/validate.js defer data-site data-mode> */`;

mkdirSync(dirname(OUT), { recursive: true });

const res = await build({
  entryPoints: [join(ROOT, 'src/embed/validate.ts')],
  outfile: OUT,
  bundle: true,
  format: 'iife',
  minify: true,
  target: ['es2017'],
  charset: 'utf8',
  legalComments: 'none',
  define: { __VERSION__: JSON.stringify(pkg.version) },
  banner: { js: BANNER },
  logLevel: 'warning',
  metafile: true,
});

const code = readFileSync(OUT, 'utf8');
const bytes = statSync(OUT).size;
const fail = [];

// 1. Size budget
if (bytes > MAX_BYTES) fail.push(`bundle too big: ${bytes} B > ${MAX_BYTES} B budget`);

// 2. No phone library in the browser bundle (it lives server-side only).
if (/libphonenumber/i.test(code)) fail.push('libphonenumber must not be bundled into the embed');

// 3. Zero runtime deps: nothing from node_modules baked in.
const inputs = Object.keys(res.metafile.outputs[Object.keys(res.metafile.outputs)[0]].inputs);
const ext = inputs.filter((f) => f.includes('node_modules'));
if (ext.length) fail.push(`external deps bundled: ${ext.join(', ')}`);

// 4. Must be an IIFE, not an ESM/CJS wrapper.
if (/\bexport\s*[{*]/.test(code) || /module\.exports/.test(code)) fail.push('bundle is not a self-contained IIFE');

// 5. Contract field names must appear verbatim (a typo = silent data loss in the webhook).
for (const n of [
  'email_verdict',
  'email_flags',
  'phone_e164',
  'phone_type',
  'lead_risk_score',
  'lead_risk_flags',
  'lv_vt',
  'lv_vs',
  'company_url_confirm',
  'validator_unreachable',
  '/v1/validate',
  '/v1/email',
  '/v1/phone',
  '/v1/token',
]) {
  if (!code.includes(n)) fail.push(`contract string missing from bundle: ${n}`);
}

// 6. The version placeholder must have been replaced.
if (!code.includes(pkg.version)) fail.push('__VERSION__ was not inlined');

const pct = ((bytes / MAX_BYTES) * 100).toFixed(1);
console.log(`embed: dist/embed/v1/validate.js  ${bytes} B  (${pct} % of ${MAX_BYTES} B budget)`);

if (fail.length) {
  for (const f of fail) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log('  ✓ all assertions passed');
