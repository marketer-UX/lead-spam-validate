// @vitest-environment jsdom
//
// Tests for the Webflow embed. The TS module is loaded directly (not the bundle):
// `init(opts)` is exported for exactly this purpose, because jsdom has no `document.currentScript`.
// All network calls go through a fetch mock that routes on the URL path.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { init, normKey } from '../src/embed/validate';

const API = 'https://validate.test';

// Names per docs/CONTRACT.md §"Embed hidden fields" (must match src/core/types.ts).
const HIDDEN = [
  'email_verdict',
  'email_flags',
  'phone_e164',
  'phone_type',
  'lead_risk_score',
  'lead_risk_flags',
  'lv_vt',
  'lv_vs',
];

// --------------------------------------------------------------- fetch mock

type Handler = (body: any, url: string) => any;
let routes: Record<string, Handler>;
let calls: Array<{ path: string; url: string; body: any; opts: any }>;

const res = (data: any, ok = true) => ({ ok, status: ok ? 200 : 500, json: () => Promise.resolve(data) });
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
/** Several macrotask rounds — covers fetch -> then -> resubmit -> then. */
const settle = async (n = 4) => {
  for (let i = 0; i < n; i++) await tick();
};

const pathOf = (url: string) => url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
const callsTo = (p: string) => calls.filter((c) => c.path === p);

function installFetch() {
  const fn = vi.fn((url: string, opts: any = {}) => {
    const path = pathOf(url);
    let body: any = null;
    try {
      body = opts.body ? JSON.parse(opts.body) : null;
    } catch (e) {
      body = opts.body;
    }
    calls.push({ path, url, body, opts });
    const h = routes[path];
    if (!h) return Promise.reject(new Error('no route: ' + path));
    return Promise.resolve(h(body, url));
  });
  (globalThis as any).fetch = fn;
  (window as any).fetch = fn;
  return fn;
}

const validateResult = (over: Partial<any> = {}) => ({
  decision: 'accept',
  reject_reason: null,
  score: 0,
  flags: [],
  suspicious: false,
  review: false,
  email: { verdict: 'valid', flags: [], provider: 'native', latency_ms: 4, normalized: 'a@b.de', cached: false },
  phone: { valid: true, e164: '+4921112345678', national: '0211 12345678', country: 'DE', type: 'fixed_line', flags: ['fixed_line'] },
  bot: { honeypot: 'empty', token: 'ok', elapsed_ms: 9000, rate_limited: false, flags: [] },
  degraded: false,
  request_id: 'rid',
  latency_ms: 9,
  ...over,
});

// ------------------------------------------------------------------ fixtures

/** Typical Webflow form markup (a download form). */
function webflowForm(): HTMLFormElement {
  document.body.innerHTML = `
  <div class="w-form">
    <form id="wf-form-Download-Form" name="wf-form-Download-Form" data-name="Download Form"
          redirect="/landing/thank-you" data-redirect="/landing/thank-you"
          method="get" class="contact04_form">
      <input type="text" name="Name" id="Name" required>
      <input type="text" name="Firma" id="Firma" required>
      <input type="email" name="E-Mail" id="E-Mail" required>
      <input type="tel" name="Telefonnummer" id="Telefonnummer" required>
      <label><input type="checkbox" name="Datenschutz" id="Datenschutz" required> Einverstanden</label>
      <input type="submit" class="w-button" data-wait="Bitte warten..." value="Absenden">
    </form>
    <div class="w-form-done">Danke!</div>
    <div class="w-form-fail">Fehler</div>
  </div>`;
  return document.querySelector('form') as HTMLFormElement;
}

/** Second form: intl-tel-input wrapper + email without a type=email name match. */
function itiForm(): HTMLFormElement {
  document.body.innerHTML = `
  <div class="w-form">
    <form id="funnel" data-name="Funnel">
      <div class="iti">
        <div class="iti__selected-flag" title="Germany (Deutschland): +49"></div>
        <input type="text" id="Phone" name="Phone">
      </div>
      <input type="email" id="email" name="E-Mail">
      <input type="submit" value="Los">
    </form>
    <div class="w-form-done">Danke!</div>
  </div>`;
  return document.querySelector('form') as HTMLFormElement;
}

function fill(f: HTMLFormElement, email = 'k.mueller@firma.de', phone = '0211 12345678') {
  const set = (sel: string, v: string) => {
    const el = f.querySelector(sel) as HTMLInputElement;
    if (el) el.value = v;
  };
  set('#Name', 'Klaus Müller');
  set('#Firma', 'Muster GmbH');
  set('#E-Mail', email);
  set('#email', email);
  set('#Telefonnummer', phone);
  set('#Phone', phone);
  const cb = f.querySelector('#Datenschutz') as HTMLInputElement;
  if (cb) cb.checked = true;
}

const hidden = (f: HTMLFormElement, n: string) => f.querySelector(`input[name="${n}"]`) as HTMLInputElement;
const submitBtn = (f: HTMLFormElement) => f.querySelector('input[type=submit]') as HTMLInputElement;

/** Webflow binds its AJAX handler as a bubbling listener on the form. */
function webflowHandler(f: HTMLFormElement) {
  const spy = vi.fn((e: Event) => e.preventDefault());
  f.addEventListener('submit', spy);
  return spy;
}

const boot = (opts: any = {}) => init({ endpoint: API, site: 'demo', mode: 'observe', ...opts });

// --------------------------------------------------------------------- setup

beforeEach(() => {
  routes = {
    '/v1/token': () => res({ token: 'v1.demo.abc.def.sig', ttl_s: 21600 }),
    '/v1/validate': () => res(validateResult()),
    '/v1/email': () => res({ verdict: 'valid', flags: [], provider: 'native', latency_ms: 3, normalized: '', cached: false }),
    '/v1/phone': () =>
      res({ valid: true, e164: '+4921112345678', national: '0211 12345678', country: 'DE', type: 'fixed_line', flags: ['fixed_line'] }),
  };
  calls = [];
  installFetch();
  delete (window as any).jQuery;
  delete (window as any).intlTelInputGlobals;
  delete (window as any).leadValidate;
  window.history.replaceState({}, '', '/');
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------- 1+2

describe('detection & injection', () => {
  it('(1) finds email/phone in real Webflow markup and injects hidden fields + honeypot', () => {
    const f = webflowForm();
    const api = boot();
    const st = api.getState(f);

    expect(st).toBeTruthy();
    expect(st.F[0].i.id).toBe('E-Mail'); // type=email
    expect(st.F[1].i.id).toBe('Telefonnummer'); // type=tel

    for (const n of HIDDEN) {
      const el = hidden(f, n);
      expect(el, n).toBeTruthy();
      expect(el.type).toBe('hidden');
      expect(el.getAttribute('data-name')).toBe(n); // the Webflow webhook reads data-name
    }

    const hp = hidden(f, 'company_url_confirm');
    expect(hp.type).toBe('text');
    expect(hp.getAttribute('data-name')).toBe('company_url_confirm');
    expect(hp.getAttribute('tabindex')).toBe('-1');
    expect(hp.getAttribute('autocomplete')).toBe('off');
    expect(hp.getAttribute('aria-hidden')).toBe('true');

    const wrap = hp.parentElement as HTMLElement;
    expect(wrap.style.position).toBe('absolute');
    expect(wrap.style.left).toBe('-9999px');
    expect(wrap.style.display).not.toBe('none'); // never display:none
    expect(f.querySelector('style#lv-css')).toBeNull();
    expect(document.getElementById('lv-css')).toBeTruthy();
    expect(api.version).toBeTruthy();
  });

  it('(1b) leaves forms without email/phone untouched', () => {
    document.body.innerHTML = '<form id="search"><input type="text" name="Suche"><input type="submit"></form>';
    const f = document.querySelector('form') as HTMLFormElement;
    boot();
    expect(f.querySelector('[data-lv]')).toBeNull();
    expect(hidden(f, 'company_url_confirm')).toBeNull();
  });

  it('(2) normKey strips the Webflow required-field asterisk', () => {
    expect(normKey('E-Mail *')).toBe('e_mail');
    expect(normKey('Telefonnummer')).toBe('telefonnummer');
    expect(normKey('  Firma  ')).toBe('firma');
    expect(normKey('E-Mail-Adresse')).toBe('e_mail_adresse');
  });
});

// ------------------------------------------------------------------------ 3

describe('submit interception', () => {
  it('(3) capture blocks the Webflow handler, which runs exactly once after the response', async () => {
    const f = webflowForm();
    boot();
    await settle(2); // wait for the token — a user does not type within the same millisecond
    fill(f);
    const wf = webflowHandler(f);
    const btn = submitBtn(f);

    f.requestSubmit(btn);

    // Slow path: our capture handler called stopImmediatePropagation.
    expect(wf).not.toHaveBeenCalled();
    expect(btn.classList.contains('lv-checking')).toBe(true);
    expect(btn.disabled).toBe(false); // disabled would break requestSubmit(submitter)

    await settle();

    expect(wf).toHaveBeenCalledTimes(1);
    expect(btn.classList.contains('lv-checking')).toBe(false);
    expect(hidden(f, 'email_verdict').value).toBe('valid');
    expect(hidden(f, 'phone_e164').value).toBe('+4921112345678');
    expect(hidden(f, 'phone_type').value).toBe('fixed_line');
    expect(hidden(f, 'lv_vt').value).toBe('v1.demo.abc.def.sig');
    expect(hidden(f, 'lv_vs').value).toMatch(/^v1;i=[01];wd=[01];pl=\d+$/);

    const c = callsTo('/v1/validate')[0];
    expect(c.opts.method).toBe('POST');
    expect(c.opts.headers['Content-Type']).toBe('text/plain'); // CORS simple, no preflight
    expect(c.opts.credentials).toBe('omit');
    expect(c.opts.keepalive).toBe(true); // data-redirect navigates away immediately
    expect(c.body.mode).toBe('submit');
    expect(c.body.token).toBe('v1.demo.abc.def.sig');
    expect(c.body.honeypot).toBe('');
    expect(c.body.honeypot_name).toBe('company_url_confirm');
    expect(c.body.context).toMatchObject({ site: 'demo', form: 'Download Form', company: 'Muster GmbH' });
    expect(c.body.signals).toHaveProperty('pl');
  });

  it('(3b) fast path: fresh result -> no second request, event passes through', async () => {
    const f = webflowForm();
    boot();
    fill(f);
    const wf = webflowHandler(f);
    f.requestSubmit(submitBtn(f));
    await settle();
    expect(callsTo('/v1/validate')).toHaveLength(1);

    f.requestSubmit(submitBtn(f));
    expect(wf).toHaveBeenCalledTimes(2); // let through synchronously
    expect(callsTo('/v1/validate')).toHaveLength(1);
  });

  it('(4) fail-open: fetch fails -> submit proceeds, lead_risk_flags contains validator_unreachable', async () => {
    const f = webflowForm();
    boot();
    fill(f);
    const wf = webflowHandler(f);
    routes['/v1/validate'] = () => Promise.reject(new Error('network down'));

    f.requestSubmit(submitBtn(f));
    await settle();

    expect(wf).toHaveBeenCalledTimes(1);
    expect(hidden(f, 'lead_risk_flags').value).toContain('validator_unreachable');
    expect(hidden(f, 'email_verdict').value).toBe('unknown');
  });

  it('(4b) fail-open on non-200 as well', async () => {
    const f = webflowForm();
    boot();
    fill(f);
    const wf = webflowHandler(f);
    routes['/v1/validate'] = () => res({ error: 'boom' }, false);

    f.requestSubmit(submitBtn(f));
    await settle();

    expect(wf).toHaveBeenCalledTimes(1);
    expect(hidden(f, 'lead_risk_flags').value).toContain('validator_unreachable');
  });
});

// ------------------------------------------------------------------------ 5

describe('mode enforce vs. observe', () => {
  const disposable = () =>
    validateResult({
      decision: 'reject',
      reject_reason: 'email_disposable',
      score: 0,
      flags: ['disposable'],
      email: { verdict: 'undeliverable', flags: ['disposable'], provider: 'native', latency_ms: 2 },
      phone: null,
    });

  it('(5) enforce + disposable blocks and renders the error hint', async () => {
    const f = webflowForm();
    boot({ mode: 'enforce' });
    fill(f, 'spam@wegwerf.de');
    const wf = webflowHandler(f);
    const rejected = vi.fn();
    f.addEventListener('lv:rejected', rejected);
    routes['/v1/validate'] = () => res(disposable());

    f.requestSubmit(submitBtn(f));
    await settle();

    expect(wf).not.toHaveBeenCalled();
    const hint = f.querySelector('.lv-hint--error') as HTMLElement;
    expect(hint).toBeTruthy();
    expect(hint.textContent).toBe('Please enter a valid email address.');
    expect(hint.getAttribute('role')).toBe('status');
    expect(hint.getAttribute('aria-live')).toBe('polite');
    const email = f.querySelector('#E-Mail') as HTMLInputElement;
    expect(email.getAttribute('aria-invalid')).toBe('true');
    expect(email.getAttribute('aria-describedby')).toBe(hint.id);
    expect(rejected).toHaveBeenCalledTimes(1);
    // hidden fields are filled anyway (diagnostics in the lead store)
    expect(hidden(f, 'email_flags').value).toBe('disposable');
  });

  it('(5b) observe + disposable does NOT block', async () => {
    const f = webflowForm();
    boot({ mode: 'observe' });
    fill(f, 'spam@wegwerf.de');
    const wf = webflowHandler(f);
    routes['/v1/validate'] = () => res(disposable());

    f.requestSubmit(submitBtn(f));
    await settle();

    expect(wf).toHaveBeenCalledTimes(1);
    expect(f.querySelector('.lv-hint--error')).toBeNull();
    expect(hidden(f, 'lead_risk_flags').value).toBe('disposable');
  });

  it('(5c) enforce + too_fast is only a flag, not a block', async () => {
    const f = webflowForm();
    boot({ mode: 'enforce' });
    fill(f);
    const wf = webflowHandler(f);
    routes['/v1/validate'] = () =>
      res(validateResult({ decision: 'reject', reject_reason: 'too_fast', flags: ['token_too_fast'] }));

    f.requestSubmit(submitBtn(f));
    await settle();

    expect(wf).toHaveBeenCalledTimes(1);
  });

  it('(6) honeypot + enforce -> fake success, no /v1/validate, no Webflow handler', async () => {
    const f = webflowForm();
    boot({ mode: 'enforce' });
    fill(f);
    const wf = webflowHandler(f);
    hidden(f, 'company_url_confirm').value = 'http://spam.example';

    f.requestSubmit(submitBtn(f));
    await settle();

    expect(wf).not.toHaveBeenCalled();
    expect(callsTo('/v1/validate')).toHaveLength(0);
    expect(f.style.display).toBe('none');
    const done = document.querySelector('.w-form-done') as HTMLElement;
    expect(done.style.display).toBe('block');
    // .w-form-fail is deliberately NOT touched (Webflow toggles it itself)
    expect((document.querySelector('.w-form-fail') as HTMLElement).style.display).toBe('');
  });

  it('(6b) denied sender (ip/contact/repeat) + enforce -> fake success, no Webflow handler', async () => {
    for (const reason of ['ip_denied', 'contact_denied', 'repeat_denied']) {
      document.body.innerHTML = '';
      const f = webflowForm();
      boot({ mode: 'enforce' });
      fill(f);
      const wf = webflowHandler(f);
      routes['/v1/validate'] = () => res(validateResult({ decision: 'reject', reject_reason: reason, flags: [reason === 'repeat_denied' ? 'repeat_contact' : reason] }));
      f.requestSubmit(submitBtn(f));
      await settle();
      expect(wf).not.toHaveBeenCalled();
      expect(f.style.display).toBe('none');
      expect((document.querySelector('.w-form-done') as HTMLElement).style.display).toBe('block');
    }
  });

  it('(6c) geo_denied still does not block in the browser', async () => {
    const f = webflowForm();
    boot({ mode: 'enforce' });
    fill(f);
    const wf = webflowHandler(f);
    routes['/v1/validate'] = () => res(validateResult({ decision: 'reject', reject_reason: 'geo_denied', flags: ['geo_denied'] }));
    f.requestSubmit(submitBtn(f));
    await settle();
    expect(wf).toHaveBeenCalledTimes(1);
  });
});

// ------------------------------------------------------------------------ 7

describe('field UX', () => {
  it('(7) no typo suggestion: server suggestion is ignored, no hint, no button', async () => {
    const f = webflowForm();
    boot();
    const email = f.querySelector('#E-Mail') as HTMLInputElement;
    routes['/v1/email'] = () =>
      res({ verdict: 'unknown', flags: ['typo_suspected'], suggestion: 'k.mueller@gmail.com', provider: 'native', latency_ms: 3, decision_hint: 'accept_flagged', reject_reason: null });
    email.value = 'k.mueller@gmial.com';
    email.dispatchEvent(new Event('focusout', { bubbles: true }));
    await settle();
    expect(f.querySelector('.lv-hint--suggest')).toBeNull();
    expect(f.querySelector('.lv-hint button')).toBeNull();
    const hint = f.querySelector('.lv-hint') as HTMLElement | null;
    expect(hint ? hint.textContent : '').toBe('');
    expect(email.value).toBe('k.mueller@gmial.com');
  });

  it('(7b) invalid number -> soft hint, no aria-invalid, no block', async () => {
    const f = webflowForm();
    boot();
    const phone = f.querySelector('#Telefonnummer') as HTMLInputElement;
    routes['/v1/phone'] = () => res({ valid: false, country: 'DE', flags: ['invalid'] });

    phone.value = '0211 123';
    phone.dispatchEvent(new Event('focusout', { bubbles: true }));
    await settle();

    const hint = (phone as any)._lvh as HTMLElement;
    expect(hint.textContent).toContain('incomplete');
    expect(hint.className).toBe('lv-hint');
    expect(phone.getAttribute('aria-invalid')).toBe('false');
    expect(hidden(f, 'lead_risk_flags').value).toContain('invalid');
  });

  it('(7c) valid number -> check-mark hint, input is not rewritten', async () => {
    const f = webflowForm();
    boot();
    const phone = f.querySelector('#Telefonnummer') as HTMLInputElement;

    phone.value = '0211 12345678';
    phone.dispatchEvent(new Event('focusout', { bubbles: true }));
    await settle();

    expect(phone.value).toBe('0211 12345678'); // E.164 only in the hidden field
    expect(((phone as any)._lvh as HTMLElement).textContent).toBe('✓ 0211 12345678');
    expect(hidden(f, 'phone_e164').value).toBe('+4921112345678');
    // descriptive types do not belong in the risk flags
    expect(hidden(f, 'lead_risk_flags').value).toBe('');
  });

  it('(8) intl-tel-input: plugin number is sent as phone, hint sits after the .iti wrapper', async () => {
    const f = itiForm();
    (window as any).intlTelInputGlobals = { getInstance: () => ({ getNumber: () => '+4917123456789' }) };
    boot();

    const st = (window as any).leadValidate.getState(f);
    expect(st.F[0].i.id).toBe('email'); // type=email
    expect(st.F[1].i.id).toBe('Phone'); // normKey(name) = phone

    const phone = f.querySelector('#Phone') as HTMLInputElement;
    phone.value = '0171 23456789';
    phone.dispatchEvent(new Event('focusout', { bubbles: true }));
    await settle();

    const c = callsTo('/v1/phone')[0];
    expect(c.body.phone).toBe('+4917123456789');
    expect(c.body.phone_raw).toBe('0171 23456789');
    expect(c.body.country).toBe('DE');

    const hint = (phone as any)._lvh as HTMLElement;
    const iti = f.querySelector('.iti') as HTMLElement;
    expect(iti.contains(hint)).toBe(false); // never inside the iti wrapper
    expect(iti.nextSibling).toBe(hint);
  });

  it('(8b) without the plugin: dial code comes from the flag title', async () => {
    const f = itiForm();
    boot();
    const phone = f.querySelector('#Phone') as HTMLInputElement;
    phone.value = '171 23456789';
    phone.dispatchEvent(new Event('focusout', { bubbles: true }));
    await settle();

    expect(callsTo('/v1/phone')[0].body.phone).toBe('+4923456789');
  });
});

// ------------------------------------------------------------------------ 9

describe('dry run & jQuery', () => {
  it('(9) ?lv_dry=1: no preventDefault, no request, no block', async () => {
    window.history.replaceState({}, '', '/kontakt?lv_dry=1');
    const f = webflowForm();
    boot({ mode: 'enforce' });
    fill(f);
    hidden(f, 'company_url_confirm').value = 'bot'; // would otherwise hard-block

    const seen = vi.fn();
    f.addEventListener('submit', (e) => {
      seen(e.defaultPrevented);
      e.preventDefault();
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    f.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle();

    expect(seen).toHaveBeenCalledWith(false); // we did NOT call preventDefault
    expect(callsTo('/v1/validate')).toHaveLength(0);
    expect(f.style.display).not.toBe('none');
    expect(log).toHaveBeenCalled();
  });

  it('(10) jQuery trigger (multi-step lib) is intercepted and re-triggered afterwards', async () => {
    const events = new WeakMap<any, { submit: any[] }>();
    const $: any = (elm: any) => ({
      on(_t: string, h: any) {
        const b = events.get(elm) || { submit: [] };
        b.submit.push(h);
        events.set(elm, b);
      },
      off() {},
      trigger(t: string) {
        const e: any = {
          type: t,
          originalEvent: undefined,
          stopped: false,
          preventDefault() {},
          stopImmediatePropagation() {
            e.stopped = true;
          },
        };
        for (const h of (events.get(elm) || { submit: [] }).submit.slice()) {
          h(e);
          if (e.stopped) break;
        }
      },
    });
    $._data = (elm: any) => events.get(elm) || { submit: [] };
    (window as any).jQuery = $;

    const f = webflowForm();
    // Webflow binds its jQuery handler BEFORE us -> we have to move ourselves to the front.
    const wf = vi.fn();
    $(f).on('submit', wf);
    boot();
    fill(f);

    $(f).trigger('submit');

    expect(wf).not.toHaveBeenCalled(); // our handler ran first and stopped it
    await settle();
    expect(wf).toHaveBeenCalledTimes(1);
    expect(callsTo('/v1/validate')).toHaveLength(1);
    expect(hidden(f, 'email_verdict').value).toBe('valid');
  });

  it('(11) mode:off touches nothing', async () => {
    const f = webflowForm();
    boot({ mode: 'off' });
    expect(f.querySelector('[data-lv]')).toBeNull();
    const wf = webflowHandler(f);
    fill(f);
    f.requestSubmit(submitBtn(f));
    expect(wf).toHaveBeenCalledTimes(1);
    expect(callsTo('/v1/validate')).toHaveLength(0);
  });

  it('(12) server mode from /v1/token overrides data-mode', async () => {
    routes['/v1/token'] = () => res({ token: 't', ttl_s: 21600, mode: 'enforce' });
    webflowForm();
    const api = boot({ mode: 'observe' });
    await settle();
    expect(api.mode).toBe('enforce');
  });
});

// -------------------------------------------------------------------- 13-20

describe('rules, texts & country from /v1/token', () => {
  /** Current token response; older servers only return `{token, ttl_s, mode, strict, site}`. */
  const tok = (over: any = {}) => res({ token: 'v1.demo.abc.def.sig', ttl_s: 21600, site: 'demo', ...over });

  const rejectEmail = () =>
    validateResult({
      decision: 'reject',
      reject_reason: 'email_disposable',
      flags: ['disposable'],
      email: { verdict: 'undeliverable', flags: ['disposable'], provider: 'native', latency_ms: 2 },
      phone: null,
    });

  const badPhone = () => res({ valid: false, country: 'DE', flags: ['invalid'] });

  /** Two forms with different data-name -> a rule applies to only one of them. */
  function twoForms(): HTMLFormElement[] {
    document.body.innerHTML = `
    <div class="w-form">
      <form id="kontakt" name="kontakt" data-name="Kontakt">
        <input type="email" id="mail-a" name="E-Mail"><input type="submit" value="A">
      </form>
      <div class="w-form-done">Danke!</div>
    </div>
    <div class="w-form">
      <form id="news" name="news" data-name="Newsletter">
        <input type="email" id="mail-b" name="E-Mail"><input type="submit" value="B">
      </form>
      <div class="w-form-done">Danke!</div>
    </div>`;
    return [].slice.call(document.querySelectorAll('form'));
  }

  const blur = (el: Element) => el.dispatchEvent(new Event('focusout', { bubbles: true }));

  it('(13) enabled:false -> not bound at all, submit passes through untouched', async () => {
    routes['/v1/token'] = () => tok({ forms: { 'Download Form': { enabled: false } } });
    const f = webflowForm();
    const api = boot();
    await settle();

    expect(f.querySelector('[data-lv]')).toBeNull();
    expect(hidden(f, 'company_url_confirm')).toBeNull();
    for (const n of HIDDEN) expect(hidden(f, n), n).toBeNull();
    expect(api.getState(f)).toBeNull();

    fill(f);
    const wf = webflowHandler(f);
    blur(f.querySelector('#E-Mail') as Element);
    blur(f.querySelector('#Telefonnummer') as Element);
    f.requestSubmit(submitBtn(f));
    await settle();

    expect(wf).toHaveBeenCalledTimes(1); // no gate, no resubmit
    expect(callsTo('/v1/validate')).toHaveLength(0);
    expect(callsTo('/v1/email')).toHaveLength(0);
    expect(callsTo('/v1/phone')).toHaveLength(0);
    expect(f.querySelector('.lv-hint')).toBeNull();
  });

  it('(14) fields.phone:false -> phone untouched, email is still checked', async () => {
    routes['/v1/token'] = () => tok({ forms: { 'Download Form': { fields: { email: true, phone: false } } } });
    const f = webflowForm();
    const api = boot();
    await settle();
    fill(f);

    const phone = f.querySelector('#Telefonnummer') as HTMLInputElement;
    blur(phone);
    await settle();
    expect(callsTo('/v1/phone')).toHaveLength(0);
    expect((phone as any)._lvh).toBeFalsy(); // no hint element injected
    expect(f.querySelector('.lv-hint')).toBeNull();
    expect(phone.hasAttribute('aria-invalid')).toBe(false);
    expect(hidden(f, 'phone_e164').value).toBe('');

    phone.value = '0211 9';
    phone.dispatchEvent(new Event('input', { bubbles: true })); // debounced path
    await tick(700); // debounce is 600 ms
    expect((phone as any)._lvh).toBeFalsy();
    expect(callsTo('/v1/phone')).toHaveLength(0);

    blur(f.querySelector('#E-Mail') as Element);
    await settle();
    expect(callsTo('/v1/email')).toHaveLength(1);

    const wf = webflowHandler(f);
    f.requestSubmit(submitBtn(f));
    await settle();

    const b = callsTo('/v1/validate')[0].body;
    expect(b.email).toBe('k.mueller@firma.de');
    expect(b.phone).toBeUndefined(); // a disabled field is not sent
    expect(b.phone_raw).toBeUndefined();
    expect(wf).toHaveBeenCalledTimes(1);
    expect(api.getState(f).fields).toEqual({ email: true, phone: false });
  });

  it('(15) form mode:enforce overrides site observe — blocks only this form', async () => {
    routes['/v1/token'] = () => tok({ mode: 'observe', forms: { Newsletter: { mode: 'enforce' } } });
    routes['/v1/validate'] = () => res(rejectEmail());
    const [a, b] = twoForms();
    const api = boot({ mode: 'observe' });
    await settle();
    (a.querySelector('#mail-a') as HTMLInputElement).value = 'spam@wegwerf.de';
    (b.querySelector('#mail-b') as HTMLInputElement).value = 'spam@wegwerf.de';

    const wfA = webflowHandler(a);
    a.requestSubmit();
    await settle();
    expect(wfA).toHaveBeenCalledTimes(1); // observe: watch only
    expect(a.querySelector('.lv-hint--error')).toBeNull();

    const wfB = webflowHandler(b);
    b.requestSubmit();
    await settle();
    expect(wfB).not.toHaveBeenCalled(); // enforce per form rule
    expect((b.querySelector('.lv-hint--error') as HTMLElement).textContent).toBe(
      'Please enter a valid email address.'
    );

    expect(api.getState(a).mode).toBe('observe');
    expect(api.getState(b).mode).toBe('enforce');
  });

  it('(16) error texts come from the token (email + phone)', async () => {
    routes['/v1/token'] = () =>
      tok({ mode: 'enforce', strict: true, messages: { email: 'Bitte echte Mail.', phone: 'Bitte echte Nummer.' } });
    routes['/v1/validate'] = () => res(rejectEmail());
    routes['/v1/phone'] = badPhone;
    const f = webflowForm();
    boot({ mode: 'observe' });
    await settle();

    const phone = f.querySelector('#Telefonnummer') as HTMLInputElement;
    phone.value = '0211 123';
    blur(phone);
    await settle();
    expect(((phone as any)._lvh as HTMLElement).textContent).toBe('Bitte echte Nummer.');
    expect(((phone as any)._lvh as HTMLElement).className).toContain('lv-hint--error');

    fill(f, 'spam@wegwerf.de');
    const wf = webflowHandler(f);
    f.requestSubmit(submitBtn(f));
    await settle();

    expect(wf).not.toHaveBeenCalled();
    expect(((f.querySelector('#E-Mail') as any)._lvh as HTMLElement).textContent).toBe('Bitte echte Mail.');
  });

  it('(16b) without messages in the token the built-in texts remain', async () => {
    routes['/v1/token'] = () => tok({ mode: 'enforce', strict: true });
    routes['/v1/validate'] = () => res(rejectEmail());
    routes['/v1/phone'] = badPhone;
    const f = webflowForm();
    boot({ mode: 'observe' });
    await settle();

    const phone = f.querySelector('#Telefonnummer') as HTMLInputElement;
    phone.value = '0211 123';
    blur(phone);
    await settle();
    expect(((phone as any)._lvh as HTMLElement).textContent).toBe('Please enter a valid phone number.');

    fill(f, 'spam@wegwerf.de');
    f.requestSubmit(submitBtn(f));
    await settle();
    expect(((f.querySelector('#E-Mail') as any)._lvh as HTMLElement).textContent).toBe(
      'Please enter a valid email address.'
    );
  });

  it('(17) late token: rules apply afterwards, unbind removes injected elements', async () => {
    routes['/v1/token'] = () =>
      new Promise((r) => setTimeout(() => r(tok({ forms: { Kontakt: { enabled: false }, Newsletter: { mode: 'enforce' } } })), 30));
    const [a, b] = twoForms();
    const api = boot({ mode: 'observe' });

    // Before the token arrives both are bound (the token is async).
    expect(a.querySelector('[data-lv]')).toBeTruthy();
    expect(hidden(a, 'lv_vt')).toBeTruthy();
    expect(b.querySelector('[data-lv]')).toBeTruthy();
    expect(api.getState(a).mode).toBe('observe');

    // ... and already checked: the hint is attached to the field.
    const mail = a.querySelector('#mail-a') as HTMLInputElement;
    mail.value = 'k.mueller@firma.de';
    blur(mail);
    await settle();
    expect(callsTo('/v1/email')).toHaveLength(1);
    expect((mail as any)._lvh).toBeTruthy();

    await tick(60); // now the token arrives
    await settle();

    expect((mail as any)._lvh).toBeFalsy(); // unbind: hint removed
    expect(mail.hasAttribute('aria-describedby')).toBe(false);

    expect(a.querySelector('[data-lv]')).toBeNull(); // unbind: container removed
    expect(hidden(a, 'company_url_confirm')).toBeNull();
    expect(api.getState(a)).toBeNull();
    expect(b.querySelector('[data-lv]')).toBeTruthy();
    expect(api.getState(b).mode).toBe('enforce'); // rule applied afterwards

    const wfA = webflowHandler(a);
    (a.querySelector('#mail-a') as HTMLInputElement).value = 'spam@wegwerf.de';
    a.requestSubmit();
    await settle();
    expect(wfA).toHaveBeenCalledTimes(1);
    expect(callsTo('/v1/validate')).toHaveLength(0);
  });

  it('(17b) a form inserted later gets its rule immediately', async () => {
    routes['/v1/token'] = () => tok({ forms: { 'Spätes Formular': { enabled: false } } });
    webflowForm();
    const api = boot();
    await settle();

    const add = (name: string, id: string) => {
      const d = document.createElement('div');
      d.innerHTML = `<form id="${id}" data-name="${name}"><input type="email" name="E-Mail"><input type="submit"></form>`;
      document.body.appendChild(d);
      return d.querySelector('form') as HTMLFormElement;
    };
    const off = add('Spätes Formular', 'late-off');
    const on = add('Anderes Formular', 'late-on');

    await tick(150); // MutationObserver is debounced by 100 ms

    expect(off.querySelector('[data-lv]')).toBeNull();
    expect(api.getState(off)).toBeNull();
    expect(on.querySelector('[data-lv]')).toBeTruthy();
  });

  it('(18) /v1/email and /v1/phone include site + form', async () => {
    const f = webflowForm();
    boot();
    await settle();
    fill(f);
    blur(f.querySelector('#E-Mail') as Element);
    blur(f.querySelector('#Telefonnummer') as Element);
    await settle();

    expect(callsTo('/v1/email')[0].body).toEqual({
      email: 'k.mueller@firma.de',
      site: 'demo',
      form: 'Download Form',
    });
    expect(callsTo('/v1/phone')[0].body).toMatchObject({
      phone_raw: '0211 12345678',
      country: 'DE',
      site: 'demo',
      form: 'Download Form',
    });
  });

  it('(19) form key: data-name > name > id', async () => {
    routes['/v1/token'] = () =>
      tok({ forms: { Kontakt: { enabled: false }, 'nur-name': { enabled: false }, 'nur-id': { enabled: false } } });
    document.body.innerHTML = `
      <form id="a" name="anders" data-name="Kontakt"><input type="email" name="E-Mail"><input type="submit"></form>
      <form id="b" name="nur-name"><input type="email" name="E-Mail"><input type="submit"></form>
      <form id="nur-id"><input type="email" name="E-Mail"><input type="submit"></form>
      <form id="d" data-name="Frei"><input type="email" name="E-Mail"><input type="submit"></form>`;
    boot();
    await settle();

    const box = (sel: string) => (document.querySelector(sel) as HTMLFormElement).querySelector('[data-lv]');
    expect(box('#a')).toBeNull(); // data-name wins over name
    expect(box('#b')).toBeNull();
    expect(box('#nur-id')).toBeNull();
    expect(box('#d')).toBeTruthy(); // no rule -> bound normally
  });

  it('(20) country from the token overrides data-country; getState/rules expose the cascade', async () => {
    const forms = { 'Download Form': { strict: false, fields: { email: false, phone: true } } };
    routes['/v1/token'] = () => tok({ mode: 'enforce', strict: true, country: 'AT', forms: forms });
    routes['/v1/phone'] = badPhone;
    const f = webflowForm();
    const api = boot({ mode: 'observe', country: 'DE' });
    await settle();

    const st = api.getState(f);
    expect(st.mode).toBe('enforce'); // inherited from the site
    expect(st.strict).toBe(false); // form override
    expect(st.fields).toEqual({ email: false, phone: true });
    expect(api.rules).toEqual(forms);
    expect(api.strict).toBe(true); // site value stays visible unchanged

    fill(f);
    blur(f.querySelector('#E-Mail') as Element);
    blur(f.querySelector('#Telefonnummer') as Element);
    await settle();

    expect(callsTo('/v1/email')).toHaveLength(0); // fields.email:false
    expect(callsTo('/v1/phone')[0].body.country).toBe('AT');
    // strict:false on the form -> an invalid number stays a soft hint
    const hint = (f.querySelector('#Telefonnummer') as any)._lvh as HTMLElement;
    expect(hint.className).toBe('lv-hint');
    expect(hint.textContent).toContain('incomplete');

    expect(callsTo('/v1/validate')).toHaveLength(0); // field checks do not trigger /v1/validate
    const wf = webflowHandler(f);
    f.requestSubmit(submitBtn(f));
    await settle();
    expect(wf).toHaveBeenCalledTimes(1);
    expect(callsTo('/v1/validate')[0].body.email).toBeUndefined();
    expect(callsTo('/v1/validate')[0].body.country).toBe('AT');
  });
});
