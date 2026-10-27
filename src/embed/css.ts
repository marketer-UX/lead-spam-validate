// A single <style id="lv-css">. `font:inherit` + em sizes so nothing
// breaks the Webflow layout. Deliberately does NOT reuse `.w-form-fail` —
// Webflow toggles that element itself and would hide our hints.
export const CSS =
  '.lv-hint{font:inherit;font-size:.85em;margin:.35em 0 0;color:#667}' +
  '.lv-hint--error{color:#c33}.lv-hint--ok{color:#186}' +
  '.lv-hint button{font:inherit;color:inherit;background:0;border:0;border-bottom:1px solid;padding:0;cursor:pointer}' +
  '.lv-checking{opacity:.65;cursor:progress}';
