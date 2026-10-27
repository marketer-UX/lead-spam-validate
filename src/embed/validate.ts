// lead-spam-validate browser embed. Zero deps, ES2017, IIFE, 10 KB size budget.
// Works without jQuery, but also hooks into jQuery when present (Webflow / multi-step libs).
// Field names/values mirror src/core/types.ts (HIDDEN_FIELDS, DEFAULT_HONEYPOT) —
// duplicated on purpose so the bundle has no runtime dependency.
// Style: short names, aliased DOM APIs, markup via HTML strings — otherwise the budget breaks.
import { CSS } from './css';

declare const __VERSION__: string;

export type Mode = 'observe' | 'enforce' | 'off';

export interface InitOptions {
  script?: HTMLScriptElement | null;
  site?: string;
  mode?: Mode;
  country?: string;
  honeypot?: string;
  email?: string; // selector
  phone?: string; // selector
  forms?: string; // selector (opt-in)
  endpoint?: string;
  noCss?: boolean;
  dry?: boolean;
}

/** One watched field (index 0 = email, 1 = phone). */
interface Fld {
  i: HTMLInputElement | null;
  r: any; // last field result
  v: string; // value that `r` belongs to
  c: AbortController | null;
  t: any; // debounce timer
}

interface St {
  f: HTMLFormElement;
  F: Fld[];
  hp: HTMLInputElement; // honeypot
  H: any; // HTMLCollection of the hidden fields, order = HF
  vr: any; // last /v1/validate result
  vv: string; // value key it belongs to
  busy: boolean;
  by: boolean; // bypass for our own resubmit
  un: boolean; // validator unreachable -> validator_unreachable
  m: Mode; // effective mode (site mode, overridden by a per-form rule)
  s: boolean; // effective strict
  K: boolean[]; // field enabled? index as in F (0 = email, 1 = phone)
}

const W: any = window;
const D = document;
const TO = setTimeout;
const CO = clearTimeout;
const sa = (e: Element, n: string, v: string) => e.setAttribute(n, v);
const ga = (e: Element, n: string) => e.getAttribute(n) || '';
/** Build markup from HTML — saves a lot of bytes compared to createElement + N × setAttribute. */
const el = (html: string): any => {
  const d = D.createElement('div');
  d.innerHTML = html;
  return d.firstChild;
};

const VER: string = typeof __VERSION__ !== 'undefined' ? __VERSION__ : '0.0.0';

// Hidden field names = CONTRACT.md §"Embed hidden fields" (both name AND data-name).
const HF = 'email_verdict email_flags phone_e164 phone_type lead_risk_score lead_risk_flags lv_vt lv_vs'.split(' ');

// Hard reject reasons (only these block in `enforce`). too_fast/rate_limited = flag only.
const HARD = /^(email_(disposable|no_mx|syntax)|phone_(invalid|premium_rate))$/;
// Fallback texts; `messages` from /v1/token override them (managed centrally on the config server).
const EMAIL_MSG = 'Please enter a valid email address.';
const PHONE_MSG = 'Please enter a valid phone number.';
const PSOFT = 'This number looks incomplete — please check it.';
const HC = 'lv-hint';
const CHK = 'lv-checking';
const UNREACH = 'validator_unreachable';
const EMAIL_N = /^(email|e_mail|mail|e_mail_adresse)$/;
const PHONE_N = /^(telefon|telefonnummer|phone|tel|mobil|handynummer)$/;
const COMPANY_N = /^(firma|company|unternehmen)$/;
const EMAILISH = /.+@.+\..+/;
const SKIP_T = /^(hidden|submit|button|checkbox|radio)$/;

let SITE = 'default';
let CTRY = 'DE';
let HPN = 'company_url_confirm';
let SELE = ''; // data-email
let SELP = ''; // data-phone
let SELF = ''; // data-forms
let NOCSS = false;
let API = '';
let MODE: Mode = 'observe';
let STRICT = false; // server flag from /v1/token: block invalid number/email (enforce)
let DRY = false;
let TOKEN = '';
let TOKAT = 0;
let INTER = false; // real user interaction seen
let WD = false; // navigator.webdriver
let PL = 0; // ms navigationStart -> init
let TZ = ''; // browser IANA time zone (spam signal, no PII)
let LG = ''; // navigator.language
let MSGS: any = {}; // messages from /v1/token (email/phone)
let RULES: any = null; // forms map from /v1/token (null = no rules known)
let SEEN: WeakMap<HTMLFormElement, St> = new WeakMap();
// In addition to the WeakMap: list of bound forms, so token rules that arrive
// asynchronously can be applied afterwards.
let FORMS: HTMLFormElement[] = [];
let started = false;
let MO: any = null;
let moT: any = 0;
let HID = 0;
let PUB: any = null;

/** Same normalization as the server side; strips e.g. Webflow's required-field asterisk ("E-Mail *"). */
export function normKey(k: string): string {
  return k
    .toLowerCase()
    .replace(/[-\s]+/g, '_')
    .replace(/[^a-z0-9_äöüß]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

// ---------------------------------------------------------------- transport

/** Content-Type text/plain = CORS simple request -> no preflight (CONTRACT §Auth).
 *  Timeout via AbortController + setTimeout (AbortSignal.timeout is missing in old Safari). */
const req = (path: string, data: any, ka?: boolean, ac?: AbortController): Promise<any> => {
  const c = ac || new AbortController();
  const t = TO(() => c.abort(), 1500);
  return W.fetch(API + path, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify(data),
    credentials: 'omit',
    keepalive: !!ka,
    signal: c.signal,
  }).then((r: any) => {
    CO(t);
    if (!r.ok) throw r; // any non-200 = unknown, never block (fail-open)
    return r.json();
  });
};

const loadToken = () =>
  W.fetch(API + '/v1/token?site=' + SITE, { credentials: 'omit' })
    .then((r: any) => r.json())
    .then((j: any) => {
      TOKEN = j.token || '';
      TOKAT = Date.now();
      if (j.mode) MODE = j.mode; // server mode overrides data-mode (kill switch)
      STRICT = !!j.strict;
      if (j.country) CTRY = j.country; // server country overrides data-country
      MSGS = j.messages || {}; // field missing (older server) -> constants
      RULES = j.forms || null;
      if (PUB) { PUB.mode = MODE; PUB.strict = STRICT; PUB.rules = RULES; }
      rules(); // apply rules to forms that are already bound
      if (MODE !== 'off') start();
    })
    .catch(() => 0); // fail-open: no token, data-mode stays

// ------------------------------------------------------------------ helpers

const q = (f: ParentNode, s: string) => f.querySelector(s) as HTMLInputElement | null;

/** Key in the forms map: data-name > name > id. */
const fkey = (f: HTMLFormElement) => ga(f, 'data-name') || f.name || f.id;
/** This form's rule from /v1/token (null = no rule known). */
const ruleOf = (f: HTMLFormElement) => (RULES && RULES[fkey(f)]) || null;
/** Error text: `messages` from /v1/token override the constant. p = phone. */
const txt = (p: any) => (p ? MSGS.phone || PHONE_MSG : MSGS.email || EMAIL_MSG);

const byName = (f: HTMLFormElement, re: RegExp): HTMLInputElement | null =>
  ([] as any).filter.call(
    f.querySelectorAll('input[name]'),
    (e: HTMLInputElement) => !SKIP_T.test(e.type) && re.test(normKey(e.name))
  )[0] || null;

/** intl-tel-input: real E.164 from the plugin, otherwise the dial code from the selected flag. */
const itiNum = (i: HTMLInputElement): string => {
  const v = i.value.trim();
  try {
    const g = W.intlTelInputGlobals;
    const n = g && g.getInstance(i);
    const s = n && n.getNumber();
    if (s) return s;
    const w = i.closest('.iti');
    const m = (w ? ga(w.querySelector('[title]') as Element, 'title') : '').match(/\+(\d+)/);
    if (m) return '+' + m[1] + v.replace(/^\+?\d{1,3}[\s\-.]*/, '');
  } catch (x) {
    /* fail-open */
  }
  return v;
};

const fire = (e: Element, n: string) => e.dispatchEvent(new Event(n, { bubbles: true }));
const ev = (f: Element, n: string, d: any) => f.dispatchEvent(new CustomEvent(n, { detail: d, bubbles: true }));
const val = (f: Fld) => (f.i ? f.i.value.trim() : '');
const vkey = (st: St) => val(st.F[0]) + ' ' + val(st.F[1]);

// --------------------------------------------------------------------- hints

/** kind: '' = neutral, 'error' | 'ok'. No typo suggestion (by design: only the two error texts). */
const say = (inp: HTMLInputElement | null, kind: string, text: string) => {
  if (!inp) return;
  const I: any = inp;
  let h: HTMLElement = I._lvh;
  if (!h || !h.parentNode) {
    h = I._lvh = el('<div role=status aria-live=polite></div>');
    h.id = 'lv-h' + ++HID;
    sa(inp, 'aria-describedby', h.id);
    // With intl-tel-input: place after the .iti wrapper, not inside it (would break the widget).
    const a: any = inp.closest('.iti') || inp;
    a.parentNode.insertBefore(h, a.nextSibling);
  }
  h.className = HC + (kind && ' ' + HC + '--' + kind);
  h.textContent = text;
  sa(inp, 'aria-invalid', kind === 'error' ? 'true' : 'false');
};

const show = (st: St, k: number) => {
  const f = st.F[k];
  const inp = f.i as HTMLInputElement; // show() only runs from chk(), where i is set
  const r = f.r;
  if (!r) return say(inp, '', '');
  if (k) {
    // server decides (strict: invalid, premium rate, bot pattern) -> error in enforce mode, soft hint otherwise
    if (r.reject_reason && st.m === 'enforce') return say(inp, 'error', txt(1));
    if (('' + r.flags).indexOf('premium_rate') >= 0) return say(inp, 'error', txt(1));
    // Valid: only confirm, NEVER rewrite the input (E.164 only goes into the hidden field).
    if (r.valid) return say(inp, 'ok', '✓ ' + (r.national || r.international || r.e164 || ''));
    if (st.m === 'enforce' && st.s) return say(inp, 'error', txt(1));
    return say(inp, '', PSOFT); // soft: no aria-invalid, never blocks
  }
  if (st.m === 'enforce' && HARD.test(r.reject_reason || '')) return say(inp, 'error', txt(0));
  say(inp, '', '');
};

// ------------------------------------------------------------ hidden fields

/** Write hidden fields from state (after every result + synchronously on submit). */
const sync = (st: St) => {
  const v = st.vr;
  const e = (v && v.email) || st.F[0].r;
  const p = (v && v.phone) || st.F[1].r;
  let fl: string[] = ((v && v.flags) || (e && e.flags) || []).concat();
  // without an overall server result: filter phone flags locally (risk only, no types)
  if (!v && p) fl = fl.concat((p.flags || []).filter((x: string) => !/^(mobile|fixed_line|toll_free)$/.test(x)));
  if (st.un) fl.push(UNREACH); // fail-open marker for the webhook / lead store
  const out = [
    e ? e.verdict : st.un ? 'unknown' : '',
    e && e.flags ? '' + e.flags : '',
    (p && p.e164) || '',
    (p && p.type) || '',
    v ? '' + v.score : '',
    '' + fl,
    TOKEN,
    'v1;i=' + +INTER + ';wd=' + +WD + ';pl=' + PL,
  ];
  out.forEach((x, i) => (st.H[i].value = x)); // H[8] = honeypot, left untouched
};

// ------------------------------------------------------------- field checks

/** k: 0 = email (/v1/email), 1 = phone (/v1/phone). */
const chk = (st: St, k: number) => {
  const f = st.F[k];
  const inp = f.i;
  if (!inp || st.m === 'off' || !st.K[k]) return; // field disabled by rule -> never check
  const v = val(f);
  if (!(k ? v.length > 3 : EMAILISH.test(v))) {
    f.r = null;
    f.v = '';
    say(inp, '', '');
    return sync(st);
  }
  if (v === f.v && f.r) return; // already fresh
  if (f.c) f.c.abort(); // abort the previous request
  const c = (f.c = new AbortController());
  const d: any = k ? { phone: itiNum(inp), phone_raw: v, country: CTRY } : { email: v };
  d.site = SITE; // site/form on field checks too: the event sink counts them per form
  d.form = fkey(st.f);
  req(k ? '/v1/phone' : '/v1/email', d, false, c).then(
    (r: any) => {
      f.r = r;
      f.v = v;
      show(st, k);
      sync(st);
    },
    () => {
      if (c === f.c) {
        st.un = true; // fail-open -> flag validator_unreachable
        sync(st);
      }
    }
  );
};

// Delegated on document so late/replaced inputs are covered too.
const fieldEv = (e: Event) => {
  const deb = e.type === 'input'; // focusout -> immediate, input -> 600 ms debounced
  const t: any = e.target;
  const st = t.form && SEEN.get(t.form);
  if (!st) return;
  const k = t === st.F[0].i ? 0 : t === st.F[1].i ? 1 : -1;
  if (k < 0 || !st.K[k]) return; // disabled field: no hint, no check
  const f = st.F[k];
  CO(f.t);
  if (!deb) return chk(st, k); // focusout -> check immediately
  if (val(f) !== f.v) {
    f.r = null; // value changed -> invalidate result + hidden fields
    say(t, '', '');
  }
  st.vr = null;
  sync(st);
  f.t = TO(() => chk(st, k), 600);
};

// -------------------------------------------------------------- submit path

const body = (st: St, m: string) => {
  const f = st.f;
  const E = st.F[0];
  const P = st.F[1];
  const c = byName(f, COMPANY_N);
  const b: any = {
    mode: m,
    budget_ms: 1500,
    token: TOKEN,
    honeypot: st.hp.value,
    honeypot_name: HPN,
    country: CTRY,
    signals: { i: INTER, wd: WD, pl: PL, tz: TZ, lg: LG },
    context: { site: SITE, form: fkey(f), company: c ? c.value.trim() : '' },
  };
  // A disabled field (fields.email/phone=false) is not sent at all.
  if (E.i && st.K[0]) b.email = val(E);
  if (P.i && st.K[1]) {
    b.phone = itiNum(P.i);
    b.phone_raw = val(P);
  }
  return b;
};

/** Honeypot reject: fake success for the bot — hide the form, show Webflow's .w-form-done. */
const fake = (st: St) => {
  const f: any = st.f;
  const w: any = f.closest('.w-form') || f.parentNode;
  f.style.display = 'none';
  const d = q(w, '.w-form-done');
  if (d) d.style.display = 'block';
};

/** true = submit blocked (only in `enforce`, only for hard reasons). */
const block = (st: St): boolean => {
  const v = st.vr;
  if (st.m !== 'enforce' || !v || v.decision !== 'reject') return false;
  const rr = v.reject_reason || '';
  // Honeypot and explicitly denied senders (blocklist, IP, repeat): fake success, send nothing.
  if (rr === 'honeypot' || /^(contact|ip|repeat)_denied$/.test(rr)) fake(st);
  else {
    if (!HARD.test(rr)) return false; // too_fast / rate_limited -> flag only, never block
    const p = +/^phone/.test(rr);
    const inp = st.F[p].i;
    say(inp, 'error', txt(p));
    inp && inp.focus();
  }
  ev(st.f, 'lv:rejected', v);
  return true;
};

/** Bypass window for our own resubmit; reset via timeout in case no event arrives
 *  (e.g. when requestSubmit fails HTML constraint validation). */
const pass = (st: St, fn: () => void) => {
  st.by = true;
  fn();
  TO(() => (st.by = false), 0);
};

const resub = (st: St, btn: any) =>
  pass(st, () => {
    const f: any = st.f;
    try {
      if (f.requestSubmit) return f.requestSubmit(btn || undefined);
    } catch (x) {
      /* falls back to the button click */
    }
    // NEVER form.submit(): it skips Webflow's jQuery handler -> bare GET navigation.
    const b = el('<button type=submit hidden></button>');
    f.appendChild(b);
    b.click();
    f.removeChild(b);
  });

const slow = (st: St, btn: any, again: () => void) => {
  st.busy = true;
  // A class instead of `disabled` — disabled would break requestSubmit(submitter) on resubmit.
  if (btn) btn.classList.add(CHK);
  let done = false;
  const fin = (r: any) => {
    if (done) return;
    done = true;
    CO(wd);
    st.busy = false;
    if (btn) btn.classList.remove(CHK);
    if (r) {
      st.vr = r;
      st.vv = vkey(st);
      [r.email, r.phone].forEach((x: any, i: number) => {
        if (x) {
          st.F[i].r = x;
          st.F[i].v = val(st.F[i]);
        }
      });
    }
    sync(st);
    if (r && block(st)) return;
    if (r) ev(st.f, 'lv:validated', r);
    again();
  };
  // Watchdog: the form ALWAYS goes through, even if fetch hangs.
  const wd = TO(() => fin(null), 2500);
  req('/v1/validate', body(st, 'submit'), true).then(fin, () => {
    st.un = true;
    fin(null);
  });
};

const gate = (st: St, e: any, btn: any, again: () => void) => {
  if (st.by) {
    st.by = false; // our own resubmit -> let it through untouched
    return;
  }
  if (st.m === 'off') return;
  const hp = !!st.hp.value;
  // Dry run: never preventDefault, never block, never resubmit — only log.
  if (DRY) return console.log('[lv-val] dry', st.m, st.f, hp, st.vr);
  const stop = () => {
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  if (hp && st.m === 'enforce') {
    stop();
    sync(st);
    fake(st);
    return ev(st.f, 'lv:rejected', { decision: 'reject', reject_reason: 'honeypot' });
  }
  if (st.busy) return stop(); // swallow double submits while a check is running
  if (st.vr && st.vv === vkey(st)) {
    // Fast path: result matches the values -> write synchronously, let the event continue.
    sync(st);
    if (block(st)) return stop();
    return ev(st.f, 'lv:validated', st.vr);
  }
  stop();
  slow(st, btn, again);
};

// A single capture listener on document: runs before Webflow's jQuery handler,
// regardless of registration order. Enter key = native submit = handled here.
const onSubmit = (e: Event) => {
  const f = e.target as HTMLFormElement;
  const st = f.tagName === 'FORM' && SEEN.get(f);
  if (!st) return;
  const btn = (e as any).submitter || null;
  gate(st, e, btn, () => resub(st, btn));
};

// Multi-step libs submit via jQuery(form).trigger('submit') — that fires NO native event.
const hookJq = (st: St) => {
  const $ = W.jQuery;
  if (!$) return;
  const f = st.f;
  const h = (e: any) => {
    if (e.originalEvent) return; // native submit -> already handled by the capture path
    if (SEEN.get(f) !== st) return; // after unbind() just let it through
    gate(st, e, null, () => pass(st, () => $(f).trigger('submit')));
  };
  try {
    $(f).on('submit', h);
    // Webflow binds its handler earlier -> move ours to the front.
    const sub = $._data(f, 'events').submit;
    if (sub.length > 1) sub.unshift(sub.pop());
  } catch (x) {
    /* jQuery internals are optional */
  }
};

// ------------------------------------------------------------------ binding

const mkFld = (i: HTMLInputElement | null): Fld => ({ i: i, r: null, v: '', c: null, t: 0 });

/** Lookup order: configured selector > type > autocomplete > normKey(name) > fallback id. */
const pick = (f: HTMLFormElement, sel: string, t: string, re: RegExp, last?: string) =>
  (sel && q(f, sel)) ||
  q(f, 'input[type=' + t + ']') ||
  q(f, 'input[autocomplete=' + t + ']') ||
  byName(f, re) ||
  (last ? q(f, last) : null);

/** Cascade site -> form: copy mode/strict/fields from the rule into the form state. */
const applyRule = (st: St) => {
  const r = ruleOf(st.f);
  st.m = (r && r.mode) || MODE;
  st.s = r && r.strict != null ? !!r.strict : STRICT;
  const fl = (r && r.fields) || {};
  st.K = [fl.email !== false, fl.phone !== false];
  // Late rule: clear a hint already shown for a field that is now disabled.
  st.F.forEach((x, k) => {
    const i: any = x.i;
    if (!st.K[k] && i && i._lvh) {
      x.r = null;
      say(i, '', '');
    }
  });
};

/** Forget a form: remove container + hints, drop state (enabled:false). */
const unbind = (f: HTMLFormElement) => {
  const st = SEEN.get(f);
  if (!st) return;
  SEEN.delete(f);
  const n = FORMS.indexOf(f);
  if (n >= 0) FORMS.splice(n, 1);
  const box = q(f, '[data-lv]');
  if (box && box.parentNode) box.parentNode.removeChild(box);
  st.F.forEach((x) => {
    CO(x.t);
    const i: any = x.i;
    const h = i && i._lvh;
    if (h && h.parentNode) h.parentNode.removeChild(h);
    if (i) {
      i._lvh = null;
      i.removeAttribute('aria-describedby'); // otherwise the reference would dangle
    }
  });
};

/** Token arrived -> apply rules to all forms that are already bound. */
const rules = () =>
  FORMS.slice().forEach((f) => {
    const r = ruleOf(f);
    const st = SEEN.get(f);
    if (r && r.enabled === false) return unbind(f);
    if (st) applyRule(st);
  });

const bind = (f: HTMLFormElement) => {
  if (SEEN.has(f) || ga(f, 'data-validate') === 'off') return;
  const r = ruleOf(f);
  if (r && r.enabled === false) return; // excluded by config -> do not touch at all
  const e = pick(f, SELE, 'email', EMAIL_N);
  const p = pick(f, SELP, 'tel', PHONE_N, '#Phone');
  if (!e && !p) return; // unrelated forms stay completely untouched
  // Hidden fields + honeypot in an off-screen container. `display:none` would give the
  // honeypot away and disable browser autofill -> only position it off-screen.
  const old = q(f, '[data-lv]');
  if (old) f.removeChild(old); // re-init / double include: no duplicate fields
  const box = el(
    '<div data-lv aria-hidden=true style="position:absolute;left:-9999px;top:-9999px;height:0;overflow:hidden">' +
      // data-name: the Webflow webhook delivers fields as data[<data-name>]
      HF.map((n) => '<input type=hidden name=' + n + ' data-name=' + n + '>').join('') +
      '<input type=text tabindex=-1 autocomplete=off aria-hidden=true></div>'
  );
  const kids = box.children; // 0..7 = hidden fields (order HF), 8 = honeypot
  const hp = kids[HF.length] as HTMLInputElement;
  hp.name = HPN;
  sa(hp, 'data-name', HPN);
  f.appendChild(box);
  const st: St = {
    f: f, F: [mkFld(e), mkFld(p)], hp: hp, H: kids, vr: null, vv: '', busy: false, by: false, un: false,
    m: MODE, s: STRICT, K: [true, true],
  };
  SEEN.set(f, st);
  FORMS.push(f);
  applyRule(st); // late-bound forms get their rule immediately
  sync(st);
  hookJq(st);
};

const bindAll = () => D.querySelectorAll(SELF || 'form').forEach(bind as any); // data-forms = Opt-in

const start = () => {
  if (started) return;
  started = true;
  if (!NOCSS && !D.getElementById('lv-css'))
    (D.head || D.documentElement).appendChild(el('<style id=lv-css>' + CSS + '</style>'));
  bindAll();
  // Late forms (lightbox/CMS/React, also the not-yet-parsed body) —
  // debounced, idempotent via SEEN. Replaces a DOMContentLoaded branch.
  if (MO) return;
  MO = new MutationObserver(() => {
    CO(moT);
    moT = TO(bindAll, 100);
  });
  MO.observe(D.documentElement, { childList: true, subtree: true });
};

// -------------------------------------------------------------- public API

const boot = (o: InitOptions) => {
  SEEN = new WeakMap();
  FORMS = [];
  MSGS = {};
  RULES = null;
  started = false;
  if (!W.fetch) return null; // no fetch, no embed (fail-open: page stays untouched)

  const s = o.script !== undefined ? o.script : (D.currentScript as HTMLScriptElement | null);
  // Options override data attributes; attribute name = 'data-' + option name.
  const at = (n: string) => (o as any)[n] || (s && s.getAttribute('data-' + n)) || '';
  const m = ((s && (s as any).src) || '').match(/^(.*)\/embed\/v1\/validate\.js/);

  SITE = at('site') || 'default';
  CTRY = at('country') || 'DE';
  HPN = at('honeypot') || 'company_url_confirm';
  SELE = at('email');
  SELP = at('phone');
  SELF = at('forms');
  API = (at('endpoint') || (m ? m[1] : '')).replace(/\/+$/, '');
  MODE = (at('mode') || 'observe') as Mode;
  NOCSS = !!o.noCss || !!(s && s.hasAttribute('data-no-css'));
  DRY = !!o.dry || /[?&]lv_dry=1/.test(location.search);

  TOKEN = '';
  TOKAT = 0;
  INTER = false;
  WD = !!navigator.webdriver;
  PL = performance.now() | 0;
  try { TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { TZ = ''; }
  LG = navigator.language || '';

  W.leadValidate = PUB = {
    version: VER,
    mode: MODE,
    rules: RULES, // forms map from /v1/token (debug)
    validateEmail: (x: string) => req('/v1/email', { email: x, site: SITE }),
    validatePhone: (x: string, raw?: string) =>
      req('/v1/phone', { phone: x, phone_raw: raw || x, country: CTRY, site: SITE }),
    validateForm: (f: HTMLFormElement) => {
      const st = SEEN.get(f);
      return st ? req('/v1/validate', body(st, 'field')) : Promise.resolve(null);
    },
    // State + effective form config in plain form (a copy, so nothing can be changed from outside).
    getState: (f: HTMLFormElement) => {
      const st = SEEN.get(f);
      return st
        ? Object.assign({}, st, { mode: st.m, strict: st.s, fields: { email: st.K[0], phone: st.K[1] } })
        : null;
    },
  };

  if (MODE !== 'off') start();
  loadToken();
  return PUB;
};

/** Init — exported so tests can run without document.currentScript. */
export function init(opts?: InitOptions): any {
  try {
    return boot(opts || {});
  } catch (x) {
    return null; // init must never take the page down
  }
}

// Listeners ONCE per module (not per init) — no teardown needed, every handler
// bails out immediately without a bound form. Capture on document runs before Webflow.
const AL: any = D.addEventListener.bind(D);
'pointerdown keydown touchstart'.split(' ').forEach((n) => AL(n, () => (INTER = true), { passive: 1, capture: 1, once: 1 }));
AL('submit', onSubmit, true);
AL('focusout', fieldEv, true);
AL('input', fieldEv, true);
// bfcache / tab switch: renew the token after 5 h (server TTL 6 h).
AL('visibilitychange', () => {
  if (PUB && !D.hidden && Date.now() - TOKAT > 18e6) loadToken();
});

// Auto-start only as a real <script> in the browser. Ignore double includes.
if (D.currentScript && !W.leadValidate) init();
