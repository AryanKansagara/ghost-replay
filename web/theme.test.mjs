import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createThemeController, resolveTheme } from './helpers.mjs';

function fixture(initial = null, dark = false) {
  let stored = initial, system = dark, state;
  const writes = [];
  const controller = createThemeController({ readPreference: () => stored,
    writePreference: value => { stored = value; writes.push(value); }, systemDark: () => system,
    apply: value => { state = value; } });
  return { controller, writes, state: () => state, stored: () => stored,
    system(value) { system = value; controller.systemChanged(); },
    external(value) { stored = value; controller.refresh(); } };
}
test('default appearance follows system; malformed persisted choices never override it', () => {
  for (const dark of [false, true]) for (const stored of [null, undefined, 'invalid', '', '{}']) {
    const f = fixture(stored, dark);
    assert.equal(f.state().theme, dark ? 'dark' : 'light');
    assert.equal(f.state().preference, null); assert.deepEqual(f.writes, []);
  }
});
test('explicit toggle persists and is restored independently of a changed system', () => {
  const first = fixture(null, true); first.controller.toggle();
  assert.equal(first.state().theme, 'light'); assert.equal(first.stored(), 'light');
  assert.deepEqual(first.writes, ['light']);
  const restored = fixture(first.stored(), true);
  assert.equal(restored.state().theme, 'light'); restored.system(false);
  assert.equal(restored.state().preference, 'light');
  restored.controller.toggle(); assert.equal(restored.stored(), 'dark');
});
test('system changes apply only in Auto mode; reset removes the stored override', () => {
  const f = fixture(null, false); f.system(true); assert.equal(f.state().theme, 'dark');
  f.controller.toggle(); f.system(true); assert.equal(f.state().theme, 'light');
  f.controller.useSystem(); assert.equal(f.stored(), null); assert.equal(f.state().theme, 'dark');
  f.system(false); assert.equal(f.state().theme, 'light');
});
test('blocked browser storage never breaks theme controls or the experiment', () => {
  let state;
  const c = createThemeController({ readPreference() { throw new Error('blocked'); },
    writePreference() { throw new Error('blocked'); }, systemDark: () => false,
    apply: value => { state = value; } });
  assert.equal(state.theme, 'light'); assert.equal(state.storageAvailable, false);
  c.toggle(); assert.equal(state.theme, 'dark'); assert.equal(state.storageAvailable, false);
  c.useSystem(); assert.equal(state.theme, 'light'); assert.equal(state.preference, null);
});
test('cross-tab preference changes and clears can refresh the active appearance', () => {
  const f = fixture('dark', false); f.external('light'); assert.equal(f.state().theme, 'light');
  f.external(null); assert.equal(f.state().preference, null); assert.equal(f.state().theme, 'light');
});
function luminance(hex) {
  const raw = hex.replace('#', '');
  const rgb = (raw.length === 3 ? [...raw].map(c => c+c).join('') : raw).match(/../g).map(v => parseInt(v,16)/255);
  return rgb.map(v => v <= .04045 ? v/12.92 : ((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
}
function contrast(a,b) { const [hi,lo]=[luminance(a),luminance(b)].sort((a,b)=>b-a);return (hi+.05)/(lo+.05); }
test('both palettes meet normal-text contrast for primary, muted, status and action roles', () => {
  const css=readFileSync(new URL('./styles.css', import.meta.url),'utf8');
  const palette = declaration => Object.fromEntries([...declaration.matchAll(/--([a-z-]+):\s*(#[a-f0-9]{3,6})/gi)].map(m=>[m[1],m[2]]));
  const dark=palette(css.match(/^:root\{([^}]+)\}/)[1]);dark.faint='#98a2b0';
  const light=palette(css.match(/html\[data-theme="light"\]\{([^}]+)\}/)[1]);
  for(const [name,p] of [['dark',dark],['light',light]]) {
    for(const [text,bg] of [['text','bg'],['text','panel'],['muted','panel'],['faint','panel'],['red','red-bg'],['green','green-bg'],['lime','lime-dark']]) {
      assert.ok(contrast(p[text],p[bg])>=4.5,`${name} ${text}/${bg}: ${contrast(p[text],p[bg])}`);
    }
  }
  assert.ok(contrast('#1b2b12','#d2ef8b')>=4.5);
});
test('theme UI uses native buttons, explicit system reset and external CSP-safe scripts', () => {
  const html=readFileSync(new URL('./index.html', import.meta.url),'utf8');
  assert.match(html, /id="theme-toggle"[^>]*type="button"/);
  assert.match(html, /id="theme-system"[^>]*aria-pressed="true"/);
  assert.match(html, /id="theme-status"[^>]*aria-live="polite"/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/);
  const app=readFileSync(new URL('./app.js', import.meta.url),'utf8');
  assert.match(app, /colorPreference\.addEventListener\('change'/);
  assert.match(app, /window\.addEventListener\('storage'/);
  assert.doesNotMatch(app, /\.innerHTML\s*=/);
  assert.equal(resolveTheme('dark', false), 'dark');
});
