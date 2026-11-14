/* Mock Home Assistant `hass` for the Glasshouse media card harness and node tests.
 * Generic demo data only. callService mutates the mock state (a new state object per change,
 * like HA) and hands a fresh hass object to every subscriber. Grouped players mirror the leader.
 * Artwork defaults to generated SVG data URLs; the browser harness swaps in canvas-painted covers. */
(function (root) {
  'use strict';

  const F = {
    PAUSE: 1, SEEK: 2, VOLUME_SET: 4, VOLUME_MUTE: 8, PREVIOUS_TRACK: 16, NEXT_TRACK: 32,
    TURN_ON: 128, TURN_OFF: 256, PLAY_MEDIA: 512, VOLUME_STEP: 1024, SELECT_SOURCE: 2048, STOP: 4096,
    PLAY: 16384, SHUFFLE_SET: 32768, REPEAT_SET: 262144, GROUPING: 524288,
  };
  const FULL = F.PAUSE | F.SEEK | F.VOLUME_SET | F.VOLUME_MUTE | F.PREVIOUS_TRACK | F.NEXT_TRACK | F.TURN_ON
    | F.TURN_OFF | F.PLAY_MEDIA | F.VOLUME_STEP | F.SELECT_SOURCE | F.STOP | F.PLAY | F.SHUFFLE_SET
    | F.REPEAT_SET | F.GROUPING;
  const TV = F.PAUSE | F.PLAY | F.VOLUME_STEP | F.VOLUME_MUTE | F.TURN_ON | F.TURN_OFF | F.SELECT_SOURCE;

  function svgArt(a, b, c, shape) {
    const shapes = {
      sun: `<circle cx="150" cy="170" r="70" fill="${c}" opacity=".92"/><rect y="200" width="300" height="100" fill="${b}" opacity=".55"/>`,
      rings: `<circle cx="150" cy="150" r="110" fill="none" stroke="${c}" stroke-width="14" opacity=".8"/><circle cx="150" cy="150" r="64" fill="none" stroke="${c}" stroke-width="10" opacity=".6"/><circle cx="150" cy="150" r="22" fill="${c}"/>`,
      waves: `<path d="M0 180 Q75 130 150 180 T300 180 V300 H0Z" fill="${c}" opacity=".7"/><path d="M0 220 Q75 170 150 220 T300 220 V300 H0Z" fill="${b}" opacity=".8"/>`,
    };
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="300" height="300" fill="url(#g)"/>${shapes[shape] || ''}</svg>`;
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  const ART = {
    sunset: svgArt('#ff8a3d', '#7a1f6b', '#ffd36b', 'sun'),
    ocean: svgArt('#0b3d6e', '#1fb5c9', '#9ff3ff', 'waves'),
    forest: svgArt('#183a2a', '#5fbf73', '#e9ffb0', 'rings'),
    dusk: svgArt('#2a1858', '#d24d8f', '#ffc2e2', 'sun'),
  };

  const TRACKS = [
    { media_title: 'Golden Hour Drive', media_artist: 'Northern Static', media_album_name: 'Coastline FM', media_duration: 248, art: 'sunset' },
    { media_title: 'Undertow', media_artist: 'The Paper Moons', media_album_name: 'Tidal Lines', media_duration: 213, art: 'ocean' },
    { media_title: 'Evergreen', media_artist: 'Wild Orchard', media_album_name: 'Rings of Moss', media_duration: 301, art: 'forest' },
    { media_title: 'Neon Pulse', media_artist: 'Velvet Arcade', media_album_name: 'After Midnight', media_duration: 196, art: 'dusk' },
  ];

  function iso(msAgo) { return new Date(Date.now() - msAgo).toISOString(); }

  function s(entity_id, state, attributes, changedAgo) {
    const t = iso(changedAgo || 3600e3);
    return { entity_id, state, attributes: attributes || {}, last_changed: t, last_updated: t, context: { id: 'x' } };
  }

  function trackAttrs(i, art) {
    const t = TRACKS[((i % TRACKS.length) + TRACKS.length) % TRACKS.length];
    return {
      media_title: t.media_title, media_artist: t.media_artist, media_album_name: t.media_album_name,
      media_duration: t.media_duration, media_content_type: 'music', entity_picture: art[t.art], track_index: i,
    };
  }

  function demoStates(art) {
    art = art || ART;
    const lr = ['media_player.living_room', 'media_player.kitchen'];
    const list = [
      s('media_player.living_room', 'playing', {
        friendly_name: 'Living Room', supported_features: FULL, volume_level: 0.42, is_volume_muted: false,
        shuffle: true, repeat: 'all', app_name: 'Music', source: 'Music', group_members: lr,
        ...trackAttrs(0, art), media_position: 61, media_position_updated_at: iso(4000),
      }, 60e3),
      s('media_player.kitchen', 'playing', {
        friendly_name: 'Kitchen', supported_features: FULL, volume_level: 0.3, is_volume_muted: false,
        shuffle: true, repeat: 'all', app_name: 'Music', source: 'Music', group_members: lr,
        ...trackAttrs(0, art), media_position: 61, media_position_updated_at: iso(4000),
      }, 120e3),
      s('media_player.office', 'paused', {
        friendly_name: 'Office', supported_features: FULL, volume_level: 0.25, is_volume_muted: false,
        shuffle: false, repeat: 'off', app_name: 'AirPlay', group_members: ['media_player.office'],
        ...trackAttrs(1, art), media_position: 142, media_position_updated_at: iso(600e3),
      }, 600e3),
      s('media_player.bedroom', 'off', {
        friendly_name: 'Bedroom', supported_features: FULL, group_members: ['media_player.bedroom'],
      }, 7200e3),
      s('media_player.patio', 'idle', {
        friendly_name: 'Patio', supported_features: FULL, volume_level: 0.5, is_volume_muted: false,
        group_members: ['media_player.patio'],
      }, 7200e3),
      s('media_player.den_tv', 'playing', {
        friendly_name: 'Den TV', supported_features: TV, is_volume_muted: false, app_name: 'TV',
        media_title: 'The Long Coast', media_series_title: 'Harbour Lights', media_season: 2, media_episode: 4,
        media_content_type: 'tvshow', media_duration: 2820, media_position: 1310, media_position_updated_at: iso(2000),
        entity_picture: art.dusk,
      }, 1800e3),
      s('media_player.radio', 'playing', {
        friendly_name: 'Garage Radio', supported_features: F.PAUSE | F.PLAY | F.STOP | F.VOLUME_SET | F.VOLUME_MUTE,
        volume_level: 0.6, is_volume_muted: true, app_name: 'Radio', media_title: 'Morning Jazz',
        media_artist: 'City Radio 88.1', media_content_type: 'music',
      }, 5400e3),
      s('media_player.porch', 'unavailable', { friendly_name: 'Porch', supported_features: FULL }, 9000e3),
    ];
    const states = {};
    for (const x of list) states[x.entity_id] = x;
    return states;
  }

  function createHass(initialStates, opts) {
    const subscribers = new Set();
    const calls = [];
    const art = (opts && opts.art) || ART;
    let states = initialStates || demoStates(art);
    const delay = opts && opts.delay;

    function put(id, mutate) {
      const prev = states[id];
      if (!prev) return;
      const next = { ...prev, attributes: { ...prev.attributes }, last_updated: new Date().toISOString() };
      const before = prev.state;
      mutate(next, next.attributes);
      if (next.state !== before) next.last_changed = next.last_updated;
      states = { ...states, [id]: next };
    }

    function publish() {
      const hass = makeHass();
      api.current = hass;
      subscribers.forEach((fn) => fn(hass));
    }

    const MEDIA_KEYS = ['media_title', 'media_artist', 'media_album_name', 'media_duration', 'media_content_type',
      'entity_picture', 'track_index', 'media_position', 'media_position_updated_at', 'shuffle', 'repeat', 'app_name', 'source'];

    function leaderOf(id) {
      const g = states[id] && states[id].attributes.group_members;
      return Array.isArray(g) && g.length ? g[0] : id;
    }

    function mirror(leader) {
      const L = states[leader];
      const g = L.attributes.group_members || [leader];
      for (const m of g) {
        if (m === leader) continue;
        put(m, (st, a) => {
          st.state = L.state;
          for (const k of MEDIA_KEYS) { if (L.attributes[k] === undefined) delete a[k]; else a[k] = L.attributes[k]; }
          a.group_members = g.slice();
        });
      }
    }

    function snapshot(a, st) {
      if (st.state === 'playing' && a.media_position_updated_at) {
        const p = (Number(a.media_position) || 0) + (Date.now() - Date.parse(a.media_position_updated_at)) / 1000;
        a.media_position = Math.min(Number(a.media_duration) || Infinity, Math.round(p));
      }
      a.media_position_updated_at = new Date().toISOString();
    }

    function apply(service, data) {
      const id = data.entity_id;
      if (service === 'join') {
        const leader = leaderOf(id);
        const g = (states[leader].attributes.group_members || [leader]).slice();
        for (const m of data.group_members || []) {
          if (!g.includes(m)) {
            const old = leaderOf(m);
            if (old !== m || (states[m].attributes.group_members || []).length > 1) unjoin(m);
            g.push(m);
          }
        }
        put(leader, (st, a) => { a.group_members = g; });
        mirror(leader);
        return;
      }
      if (service === 'unjoin') { unjoin(id); return; }
      const leader = ['volume_set', 'volume_mute', 'turn_on', 'turn_off', 'volume_up', 'volume_down'].includes(service) ? id : leaderOf(id);
      put(leader, (st, a) => {
        switch (service) {
          case 'media_play_pause':
            snapshot(a, st); st.state = st.state === 'playing' ? 'paused' : 'playing'; break;
          case 'media_play': snapshot(a, st); st.state = 'playing'; break;
          case 'media_pause': snapshot(a, st); st.state = 'paused'; break;
          case 'media_stop': st.state = 'idle'; for (const k of MEDIA_KEYS) delete a[k]; break;
          case 'media_next_track':
          case 'media_previous_track': {
            const i = (a.track_index || 0) + (service === 'media_next_track' ? 1 : -1);
            Object.assign(a, trackAttrs(i, art), { media_position: 0, media_position_updated_at: new Date().toISOString() });
            st.state = 'playing';
            break;
          }
          case 'media_seek': a.media_position = data.seek_position; a.media_position_updated_at = new Date().toISOString(); break;
          case 'volume_set': a.volume_level = data.volume_level; break;
          case 'volume_mute': a.is_volume_muted = data.is_volume_muted; break;
          case 'volume_up': a.volume_level = Math.min(1, (a.volume_level || 0) + 0.05); break;
          case 'volume_down': a.volume_level = Math.max(0, (a.volume_level || 0) - 0.05); break;
          case 'shuffle_set': a.shuffle = data.shuffle; break;
          case 'repeat_set': a.repeat = data.repeat; break;
          case 'turn_on': st.state = 'idle'; a.volume_level = a.volume_level || 0.3; a.is_volume_muted = false; break;
          case 'turn_off': st.state = 'off'; break;
          default: break;
        }
      });
      if (leader === leaderOf(leader)) mirror(leader);
    }

    function unjoin(id) {
      const leader = leaderOf(id);
      const g = (states[leader].attributes.group_members || [leader]).filter((m) => m !== id);
      if (leader === id) {
        // the leader leaves: the next member leads the rest
        if (g.length) {
          const nl = g[0];
          put(nl, (st, a) => { a.group_members = g; });
          mirror(nl);
        }
      } else {
        put(leader, (st, a) => { a.group_members = g; });
        mirror(leader);
      }
      put(id, (st, a) => {
        a.group_members = [id];
        if (leader !== id) { st.state = 'idle'; for (const k of MEDIA_KEYS) delete a[k]; }
      });
    }

    function makeHass() {
      return {
        states,
        user: { name: 'Demo' },
        language: 'en',
        hassUrl(path) { return path; },
        callService(domain, service, data) {
          calls.push({ domain, service, data: JSON.parse(JSON.stringify(data || {})) });
          const run = () => { if (domain === 'media_player') { apply(service, data || {}); publish(); } };
          if (delay) setTimeout(run, delay); else run();
          return Promise.resolve();
        },
      };
    }

    const api = {
      calls,
      current: makeHass(),
      subscribe(fn) { subscribers.add(fn); fn(api.current); return () => subscribers.delete(fn); },
      setState(id, state, attrs) { put(id, (st, a) => { if (state) st.state = state; Object.assign(a, attrs || {}); }); publish(); },
    };
    return api;
  }

  root.GHMock = { demoStates, createHass, ART, TRACKS, F, svgArt };
})(typeof window !== 'undefined' ? window : globalThis);
