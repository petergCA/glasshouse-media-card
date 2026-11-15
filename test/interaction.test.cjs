/* Interaction tests for glasshouse-media-card, run with node + jsdom (not a repo dependency):
 *   mkdir /tmp/ghtest && cd /tmp/ghtest && npm i jsdom
 *   node /path/to/repo/test/interaction.test.cjs
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require(require.resolve('jsdom', { paths: [process.cwd(), __dirname] }));

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed += 1; console.log('  ✓', msg); }
  else { failed += 1; console.log('  ✗', msg); }
}
function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)})`); }
function near(a, b, tol, msg) { ok(Math.abs(a - b) <= tol, `${msg} (got ${a}, want ${b}±${tol})`); }

const P = {
  lr: { entity: 'media_player.living_room', name: 'Living Room', icon: 'mdi:sofa' },
  kitchen: { entity: 'media_player.kitchen', name: 'Kitchen' },
  office: { entity: 'media_player.office', name: 'Office' },
  bedroom: { entity: 'media_player.bedroom', name: 'Bedroom' },
  patio: { entity: 'media_player.patio', name: 'Patio' },
  tv: { entity: 'media_player.den_tv' },
  radio: { entity: 'media_player.radio', name: 'Garage' },
};

function setup(config, opts) {
  const vc = new VirtualConsole(); // swallow jsdom "not implemented" noise (canvas, etc.)
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  w.eval(`
    if (!window.PointerEvent) {
      window.PointerEvent = class PointerEvent extends MouseEvent {
        constructor(t, i) { super(t, i); this.pointerType = (i && i.pointerType) || 'mouse'; }
      };
    }
    customElements.define('ha-card', class extends HTMLElement {});
    customElements.define('ha-icon', class extends HTMLElement {});
    customElements.define('ha-state-icon', class extends HTMLElement {});
  `);
  w.eval(read('test/mock-hass.js'));
  w.eval(read('glasshouse-media-card.js'));
  const mock = w.GHMock.createHass(undefined, opts);
  const card = w.document.createElement('glasshouse-media-card');
  card.setConfig(config || { players: [P.lr, P.kitchen, P.office, P.bedroom, P.patio] });
  w.document.body.append(card);
  mock.subscribe((hass) => { card.hass = hass; });
  const events = [];
  card.addEventListener('hass-more-info', (e) => events.push(['more-info', e.detail.entityId]));
  card.addEventListener('haptic', (e) => events.push(['haptic', e.detail]));
  const $ = (sel) => card.shadowRoot.querySelector(sel);
  const $$ = (sel) => [...card.shadowRoot.querySelectorAll(sel)];
  const chip = (id) => $(`.chip[data-entity="${id}"]`);
  const gtog = (id) => $(`.gtog[data-entity="${id}"]`);
  const ptr = (el, type) => el.dispatchEvent(new w.PointerEvent(type, { bubbles: true, clientX: 5, clientY: 5, button: 0 }));
  const click = (el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  const tap = (el) => { ptr(el, 'pointerdown'); ptr(el, 'pointerup'); click(el); };
  const fire = (el, type) => el.dispatchEvent(new w.Event(type, { bubbles: true }));
  const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
  return { w, mock, card, events, $, $$, chip, gtog, ptr, click, tap, fire, iso };
}

(async () => {
  console.log('render');
  {
    const { $, $$, card, chip } = setup();
    eq($$('.chip').length, 5, 'one speaker chip per configured player');
    eq($('.title').textContent, 'Golden Hour Drive', 'auto picks the most recently changed playing player');
    eq($('.sub').textContent, 'Northern Static · Coastline FM', 'artist · album');
    eq($('.src').textContent, 'Music', 'source / app chip');
    eq($('.who span').textContent, 'Living Room', 'active player name from config');
    eq(chip('media_player.living_room').getAttribute('aria-pressed'), 'true', 'active chip pressed');
    ok(chip('media_player.kitchen').querySelector('.eq').classList.contains('on'), 'equaliser animates on a playing chip');
    ok(!chip('media_player.bedroom').querySelector('.eq').classList.contains('on'), 'no equaliser on an off chip');
    ok($('.now').hidden === false && $('.idle').hidden === true, 'now-playing view shown');
    ok($('.art img').getAttribute('src').startsWith('data:image/svg+xml'), 'artwork src set');
    eq(card.getGridOptions(), { columns: 12, min_columns: 6, rows: 'auto' }, 'getGridOptions');
    eq($('.dur').textContent, '4:08', 'duration formatted');
  }

  console.log('progress interpolation');
  {
    const { livePosition } = (() => { const { w } = setup(); return w.customElements.get('glasshouse-media-card')._internals; })();
    const base = Date.parse('2026-01-01T00:00:00Z');
    const st = (state, pos, agoS, dur) => ({ state, attributes: { media_position: pos, media_duration: dur,
      media_position_updated_at: new Date(base - agoS * 1000).toISOString() } });
    near(livePosition(st('playing', 30, 10, 200), base), 40, 0.001, 'playing: position + elapsed');
    near(livePosition(st('paused', 30, 10, 200), base), 30, 0.001, 'paused: position frozen');
    near(livePosition(st('playing', 195, 60, 200), base), 200, 0.001, 'clamped to duration');

    const { mock, $, iso } = setup();
    mock.setState('media_player.living_room', 'playing', { media_position: 100, media_position_updated_at: iso(10000), media_duration: 300 });
    near(Number($('.prog input').value), 110, 1, 'card slider shows interpolated position');
    eq($('.el').textContent, '1:50', 'elapsed label interpolated');
    const v0 = Number($('.prog input').value);
    await sleep(1300);
    ok(Number($('.prog input').value) >= v0 + 1, 'ticker advances the bar while playing');
    mock.setState('media_player.living_room', 'paused', { media_position: 120, media_position_updated_at: iso(50000) });
    eq($('.prog input').value, '120', 'paused shows the reported position');
    await sleep(600);
    eq($('.prog input').value, '120', 'paused does not advance');
  }

  console.log('feature-bit gating');
  {
    const { $ } = setup({ players: [P.tv] });
    ok($('[aria-label="Previous"]').disabled && $('[aria-label="Next"]').disabled, 'TV without track bits: prev/next disabled');
    ok($('[aria-label="Shuffle"]').disabled && $('.tbtn.sm:last-child').disabled, 'no shuffle/repeat bits: toggles disabled');
    ok($('.prog input').disabled, 'no SEEK bit: progress not seekable');
    ok($('.vol input').hidden, 'no VOLUME_SET: slider hidden');
    ok(!$('[aria-label="Volume up"]').hidden, 'VOLUME_STEP: step buttons shown');
    ok($('.section').hidden, 'single player: no speaker chips');
    eq($('.sub').textContent, 'Harbour Lights · S2 · E4', 'series subtitle');
  }
  {
    const { $ } = setup({ players: [P.radio] });
    ok(!$('.live').hidden && $('.prog input').hidden, 'live stream: LIVE badge, no seek bar');
    eq($('.play').getAttribute('aria-label'), 'Pause', 'play/pause label');
    ok($('.mute').getAttribute('aria-pressed') === 'true', 'muted state reflected');
  }
  {
    const { $ } = setup({ players: [P.office] });
    ok(!$('[aria-label="Previous"]').disabled && !$('[aria-label="Shuffle"]').disabled && !$('.prog input').disabled,
      'full-featured player: everything enabled');
    eq($('.play').getAttribute('aria-label'), 'Play', 'paused -> play button');
  }
  {
    const { $ } = setup({ players: [P.lr], show_volume: false });
    ok($('.vol').hidden, 'show_volume: false hides volume');
  }

  console.log('player switching');
  {
    const { $, chip, tap, ptr, events, mock, card } = setup();
    tap(chip('media_player.office'));
    eq($('.title').textContent, 'Undertow', 'tapping a chip switches the active player');
    eq(chip('media_player.office').getAttribute('aria-pressed'), 'true', 'new chip pressed');
    eq(chip('media_player.living_room').getAttribute('aria-pressed'), 'false', 'old chip released');
    ok(events.some((e) => e[0] === 'haptic'), 'haptic on switch');
    mock.setState('media_player.patio', 'playing', { media_title: 'Something else', media_duration: 100, media_position: 0,
      media_position_updated_at: new Date().toISOString() });
    eq($('.title').textContent, 'Undertow', 'a user choice sticks when another player starts');
    ptr(chip('media_player.patio'), 'pointerdown'); await new Promise((r) => setTimeout(r, 560)); ptr(chip('media_player.patio'), 'pointerup');
    chip('media_player.patio').dispatchEvent(new card.ownerDocument.defaultView.MouseEvent('click', { bubbles: true }));
    eq(events.filter((e) => e[0] === 'more-info').at(-1), ['more-info', 'media_player.patio'], 'hold opens more-info');
    eq($('.title').textContent, 'Undertow', 'hold does not switch');
    tap(chip('media_player.bedroom'));
    ok(!$('.idle').hidden && $('.now').hidden, 'switching to an off player shows the idle view');
  }
  {
    const { $, mock } = setup({ players: [P.bedroom, P.patio, P.office] });
    eq($('.idle .s').textContent, 'Bedroom · Off', 'auto: nothing playing -> first player');
    mock.setState('media_player.patio', 'playing', { media_title: 'Fresh Start', media_duration: 100, media_position: 0,
      media_position_updated_at: new Date().toISOString() });
    eq($('.title').textContent, 'Fresh Start', 'auto follows a player that starts playing');
    mock.setState('media_player.office', 'playing', { media_position_updated_at: new Date().toISOString() });
    eq($('.title').textContent, 'Fresh Start', 'auto never jumps away from a player with media');
  }
  {
    const { $ } = setup({ players: [P.lr, P.office], default: 'media_player.office' });
    eq($('.title').textContent, 'Undertow', 'explicit default player');
  }

  console.log('volume on release');
  {
    const { $, mock, fire } = setup({ players: [P.lr] }, { delay: 300 });
    const vol = $('.vol input');
    eq(vol.value, '42', 'slider shows the reported volume');
    vol.value = '70'; fire(vol, 'input');
    eq(mock.calls.length, 0, 'no service call while dragging');
    eq($('.vv').textContent, '70', 'local value shown while dragging');
    mock.setState('media_player.living_room', null, { media_title: 'Golden Hour Drive (Live)' });
    eq(vol.value, '70', 'incoming update does not move the slider mid-drag');
    fire(vol, 'change');
    eq(mock.calls.at(-1), { domain: 'media_player', service: 'volume_set', data: { entity_id: 'media_player.living_room', volume_level: 0.7 } },
      'volume_set on release');
    mock.setState('media_player.living_room', null, { media_title: 'Golden Hour Drive' });
    eq(vol.value, '70', 'target held until the player reports it');
    await sleep(400);
    eq(mock.current.states['media_player.living_room'].attributes.volume_level, 0.7, 'mock applied volume');
    eq(vol.value, '70', 'slider settles on the reported value');
    $('.mute').click();
    eq(mock.calls.at(-1).service, 'volume_mute', 'mute button');
    eq(mock.calls.at(-1).data.is_volume_muted, true, 'mute toggles to true');
  }

  console.log('transport + seek');
  {
    const { $, mock, fire } = setup({ players: [P.lr] });
    $('.play').click();
    eq(mock.calls.at(-1), { domain: 'media_player', service: 'media_play_pause', data: { entity_id: 'media_player.living_room' } }, 'play/pause');
    eq($('.play').getAttribute('aria-label'), 'Play', 'reflects paused state');
    $('[aria-label="Next"]').click();
    eq(mock.calls.at(-1).service, 'media_next_track', 'next');
    eq($('.title').textContent, 'Undertow', 'next track shown');
    $('[aria-label="Previous"]').click();
    eq(mock.calls.at(-1).service, 'media_previous_track', 'previous');
    $('[aria-label="Shuffle"]').click();
    eq(mock.calls.at(-1).data, { entity_id: 'media_player.living_room', shuffle: false }, 'shuffle toggles off');
    $('.tbtn.sm:last-child').click();
    eq(mock.calls.at(-1).data, { entity_id: 'media_player.living_room', repeat: 'one' }, 'repeat all -> one');
    const seek = $('.prog input');
    seek.value = '200'; fire(seek, 'input');
    eq(mock.calls.at(-1).service, 'repeat_set', 'no seek while dragging');
    fire(seek, 'change');
    eq(mock.calls.at(-1), { domain: 'media_player', service: 'media_seek', data: { entity_id: 'media_player.living_room', seek_position: 200 } }, 'seek on release');
    eq(seek.value, '200', 'bar at the new position');
  }

  console.log('grouping');
  {
    const { $, $$, mock, gtog, chip } = setup();
    ok(!$('.section + .section').hidden, 'group section shown when group_members exists');
    eq($$('.gtog').length, 4, 'a toggle per other speaker');
    eq(gtog('media_player.kitchen').getAttribute('aria-pressed'), 'true', 'grouped speaker is pressed');
    ok(!chip('media_player.kitchen').querySelector('.lnk').hidden, 'link badge on grouped chip');
    gtog('media_player.office').click();
    eq(mock.calls.at(-1), { domain: 'media_player', service: 'join',
      data: { entity_id: 'media_player.living_room', group_members: ['media_player.office'] } }, 'join');
    eq(gtog('media_player.office').getAttribute('aria-pressed'), 'true', 'office joined');
    eq($('.section-h span').textContent, 'Speakers', 'speakers header');
    ok(/3 speakers/.test($$('.section-h')[1].textContent), 'group header counts speakers');
    gtog('media_player.kitchen').click();
    eq(mock.calls.at(-1), { domain: 'media_player', service: 'unjoin', data: { entity_id: 'media_player.kitchen' } }, 'unjoin');
    eq(gtog('media_player.kitchen').getAttribute('aria-pressed'), 'false', 'kitchen left');
  }
  {
    const { $ } = setup({ players: [P.lr, P.kitchen], show_group: false });
    ok($('.section + .section').hidden, 'show_group: false hides grouping');
  }

  console.log('idle / off');
  {
    const { $, mock } = setup({ players: [P.bedroom, P.patio] });
    ok(!$('.idle').hidden, 'idle view');
    eq($('.idle .t').textContent, 'Nothing playing', 'nothing playing title');
    eq($('.idle .s').textContent, 'Bedroom · Off', 'player and state');
    ok(!$('.pwr').hidden, 'turn on offered for an off player with TURN_ON');
    ok(!$('.section').hidden, 'speaker chips still usable');
    $('.pwr').click();
    eq(mock.calls.at(-1), { domain: 'media_player', service: 'turn_on', data: { entity_id: 'media_player.bedroom' } }, 'turn_on');
    ok($('.pwr').hidden, 'turn on hidden once idle');
  }

  console.log('diffing, art url, colour, config');
  {
    const { card, mock } = setup();
    let n = 0; const orig = card._update.bind(card); card._update = () => { n += 1; orig(); };
    card.hass = mock.current;
    eq(n, 0, 'same state objects -> no re-render');
    card.hass = { ...mock.current };
    eq(n, 0, 'new hass object, same states -> no re-render');
    mock.setState('media_player.office', null, { volume_level: 0.3 });
    eq(n, 1, 'watched player change -> one update');
  }
  {
    const { w } = setup();
    const states = w.GHMock.demoStates();
    states['media_player.living_room'].attributes.entity_picture = '/api/media_player_proxy/media_player.living_room?token=x';
    const mock = w.GHMock.createHass(states);
    const card = w.document.createElement('glasshouse-media-card');
    card.setConfig({ players: [P.lr] });
    w.document.body.append(card);
    card.hass = { ...mock.current, hassUrl: (p) => 'http://ha.local:8123' + p };
    eq(card.shadowRoot.querySelector('.art img').getAttribute('src'),
      'http://ha.local:8123/api/media_player_proxy/media_player.living_room?token=x', 'relative art prefixed with hassUrl()');
  }
  {
    const { w } = setup();
    const states = w.GHMock.demoStates();
    states['media_player.living_room'].attributes.source = 'TV';
    const mock = w.GHMock.createHass(states);
    const card = w.document.createElement('glasshouse-media-card');
    card.setConfig({ players: [P.lr], ignore_sources: ['TV'] });
    w.document.body.append(card);
    card.hass = { ...mock.current };
    ok(!card._hasMedia(states['media_player.living_room']) && card._mostRecentPlaying() === null, 'ignore_sources: a soundbar on its TV input is not music');
  }
  {
    const { w } = setup();
    const { dominantColor } = w.customElements.get('glasshouse-media-card')._internals;
    const px = (rgb, n) => { const a = []; for (let i = 0; i < n; i++) a.push(...rgb, 255); return a; };
    const c = dominantColor([...px([230, 110, 30], 300), ...px([20, 20, 30], 200)]);
    ok(c && c[0] > c[1] && c[1] > c[2], `orange art -> orange accent (${c})`);
    eq(dominantColor(px([128, 128, 128], 400)), null, 'grey art -> fallback');
    const { card } = setup();
    eq(card.shadowRoot.querySelector('ha-card').style.getPropertyValue('--art'), '', 'no sample in jsdom -> theme accent');
  }
  {
    const { w } = setup();
    const c = w.document.createElement('glasshouse-media-card');
    const throws = (cfg) => { try { c.setConfig(cfg); return false; } catch (e) { return /glasshouse-media-card/.test(e.message); } };
    ok(throws({}), 'missing players throws');
    ok(throws({ players: ['light.x'] }), 'non media_player throws');
    ok(throws({ players: ['media_player.a'], default: 'media_player.b' }), 'default must be a configured player');
    ok(throws({ players: ['media_player.a'], show_volume: 'yes' }), 'boolean options validated');
    ok(!throws({ players: ['media_player.a'] }), 'string players accepted');
    ok(!throws({ entity: 'media_player.a' }), 'single entity shorthand accepted');
    eq(w.customElements.get('glasshouse-media-card').getStubConfig({ states: { 'media_player.x': {} } }),
      { players: [{ entity: 'media_player.x' }] }, 'stub config');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
