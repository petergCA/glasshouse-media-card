/*!
 * Glasshouse Media Card v1.0.1
 * A premium now-playing card: artwork glow, live progress, transport, volume, speaker switching
 * and grouping. Part of the Glasshouse card suite. MIT License (c) 2026 Peter Gray.
 */
(() => {
  'use strict';

  const VERSION = '1.0.1';
  const TAG = 'glasshouse-media-card';

  const HOLD_MS = 500;
  const MOVE_TOLERANCE = 10;
  const TARGET_TTL = 6000; // how long a slider target is shown while waiting for the player
  const VOL_TOL = 0.015;

  // MediaPlayerEntityFeature bit flags
  const F = {
    PAUSE: 1, SEEK: 2, VOLUME_SET: 4, VOLUME_MUTE: 8, PREVIOUS_TRACK: 16, NEXT_TRACK: 32,
    TURN_ON: 128, TURN_OFF: 256, VOLUME_STEP: 1024, STOP: 4096, PLAY: 16384,
    SHUFFLE_SET: 32768, REPEAT_SET: 262144, GROUPING: 524288,
  };

  const ACTIVE_STATES = new Set(['playing', 'paused', 'buffering']);
  const REPEAT_NEXT = { off: 'all', all: 'one', one: 'off' };

  const domainOf = (id) => String(id).split('.')[0];
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const isNum = (v) => v !== null && v !== undefined && v !== '' && !Number.isNaN(Number(v));
  const has = (st, bit) => !!st && (Number(st.attributes.supported_features) & bit) === bit;
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

  function fmtTime(sec) {
    if (!isNum(sec) || sec < 0) return '0:00';
    sec = Math.floor(sec);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const ss = String(s).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  }

  /** Live playback position in seconds, interpolated from the last report while playing. */
  function livePosition(st, now) {
    if (!st) return 0;
    const a = st.attributes;
    let p = Number(a.media_position) || 0;
    if (st.state === 'playing' && a.media_position_updated_at) {
      const t = Date.parse(a.media_position_updated_at);
      if (!Number.isNaN(t)) p += Math.max(0, ((now === undefined ? Date.now() : now) - t) / 1000);
    }
    const d = Number(a.media_duration);
    return d > 0 ? clamp(p, 0, d) : Math.max(0, p);
  }

  /* --------------------------------------------------------- colour sampling */

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
    if (mx === mn) return [0, 0, l];
    const d = mx - mn;
    const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    let hh;
    if (mx === r) hh = (g - b) / d + (g < b ? 6 : 0);
    else if (mx === g) hh = (b - r) / d + 2;
    else hh = (r - g) / d + 4;
    return [hh * 60, s, l];
  }

  function hslToRgb(hh, s, l) {
    const k = (n) => (n + hh / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
  }

  /**
   * Dominant vivid colour of an RGBA pixel buffer: pixels are binned by hue, weighted by how
   * colourful they are; the heaviest bin is averaged and lifted to a tone that glows on dark glass.
   * Returns [r,g,b] or null when the image is essentially grey.
   */
  function dominantColor(data) {
    const bins = Array.from({ length: 12 }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
    let total = 0, n = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 128) continue;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const [hh, s, l] = rgbToHsl(r, g, b);
      n += 1;
      if (l < 0.08 || l > 0.94) continue;
      const w = s * s * (1 - Math.abs(l - 0.5));
      if (w < 0.02) continue;
      const bin = bins[Math.floor(hh / 30) % 12];
      bin.w += w; bin.r += r * w; bin.g += g * w; bin.b += b * w;
      total += w;
    }
    if (!n || total / n < 0.012) return null;
    const best = bins.reduce((x, y) => (y.w > x.w ? y : x));
    const [hh, s, l] = rgbToHsl(best.r / best.w, best.g / best.w, best.b / best.w);
    return hslToRgb(hh, clamp(s, 0.5, 0.88), clamp(l, 0.6, 0.7));
  }

  function sampleImage(img) {
    try {
      const c = document.createElement('canvas');
      c.width = 24; c.height = 24;
      const ctx = c.getContext && c.getContext('2d', { willReadFrequently: true });
      if (!ctx) return null;
      ctx.drawImage(img, 0, 0, 24, 24);
      return dominantColor(ctx.getImageData(0, 0, 24, 24).data); // throws when the canvas is tainted
    } catch (e) {
      return null;
    }
  }

  /* ----------------------------------------------------------------- styles */

  const STYLE = `
    :host {
      --gh-font: var(--glasshouse-font, -apple-system, "SF Pro Text", Inter, Roboto, system-ui, sans-serif);
      --gh-surface: var(--glasshouse-surface, rgba(255,255,255,0.045));
      --gh-surface-2: var(--glasshouse-surface-2, rgba(255,255,255,0.075));
      --gh-border: var(--glasshouse-border, rgba(255,255,255,0.09));
      --gh-blur: var(--glasshouse-blur, 18px);
      --gh-radius: var(--glasshouse-radius, 22px);
      --gh-radius-sm: var(--glasshouse-radius-sm, 14px);
      --gh-pad: var(--glasshouse-pad, 16px);
      --gh-gap: var(--glasshouse-gap, 10px);
      --gh-text: var(--glasshouse-text, #e9eef6);
      --gh-text-2: var(--glasshouse-text-2, #93a0b5);
      --gh-text-3: var(--glasshouse-text-3, #5d697d);
      --gh-ok: var(--glasshouse-ok, #3fb950);
      --gh-warn: var(--glasshouse-warn, #e3b341);
      --gh-alert: var(--glasshouse-alert, #ff5c5c);
      --gh-info: var(--glasshouse-info, #58a6ff);
      --gh-light: var(--glasshouse-light, #ffb547);
      --gh-fan: var(--glasshouse-fan, #4dd6e8);
      --gh-cover: var(--glasshouse-cover, #a3a8ff);
      --gh-switch: var(--glasshouse-switch, #7ee08a);
      --gh-heat: var(--glasshouse-heat, #ff7a59);
      --gh-cool: var(--glasshouse-cool, #58a6ff);
      --gh-media: var(--glasshouse-media, #c48cff);
      --gh-lock: var(--glasshouse-lock, #3fb950);
      --gh-security: var(--glasshouse-security, #ff5c5c);
      --gh-energy: var(--glasshouse-energy, #f6d365);
      --gh-water: var(--glasshouse-water, #4aa8ff);
      --gh-neutral: var(--glasshouse-neutral, #93a0b5);
      --gh-ease: 160ms ease;
      display: block;
    }
    * { box-sizing: border-box; }
    ha-card {
      --art: var(--gh-media);
      --gh-accent: var(--art);
      display: block;
      position: relative;
      container: gh-media / inline-size;
      background: var(--gh-surface);
      border: 1px solid var(--gh-border);
      border-radius: var(--gh-radius);
      -webkit-backdrop-filter: blur(var(--gh-blur)) saturate(140%);
      backdrop-filter: blur(var(--gh-blur)) saturate(140%);
      padding: var(--gh-pad);
      color: var(--gh-text);
      font-family: var(--gh-font);
      font-size: 13px;
      font-weight: 500;
      line-height: 1.3;
      -webkit-font-smoothing: antialiased;
      overflow: hidden;
      isolation: isolate;
    }
    button {
      font: inherit; color: inherit; background: none; border: 0; margin: 0; padding: 0;
      cursor: pointer; -webkit-tap-highlight-color: transparent;
    }
    button:focus { outline: none; }
    button:focus-visible, input:focus-visible { outline: 2px solid var(--gh-accent); outline-offset: 2px; }
    button:disabled { cursor: default; }
    ha-icon, ha-state-icon { display: inline-flex; --mdc-icon-size: 22px; }
    [hidden] { display: none !important; }

    /* ---------- artwork-derived backdrop ---------- */
    .bg { position: absolute; inset: 0; z-index: -1; pointer-events: none; overflow: hidden;
      border-radius: inherit; }
    .bg-img {
      position: absolute; inset: -30%; width: 160%; height: 160%; object-fit: cover;
      filter: blur(56px) saturate(1.7); opacity: 0; transform: translateZ(0);
      transition: opacity 600ms ease;
    }
    .bg-img.ready { opacity: 0.36; }
    .bg-glow {
      position: absolute; inset: 0;
      background:
        radial-gradient(120% 80% at 0% 0%, color-mix(in srgb, var(--art) 30%, transparent), transparent 62%),
        radial-gradient(90% 70% at 100% 100%, color-mix(in srgb, var(--art) 14%, transparent), transparent 70%),
        linear-gradient(180deg, rgba(8,11,18,0.10), rgba(8,11,18,0.42));
      transition: background 600ms ease;
    }
    ha-card.is-idle .bg-glow {
      background: radial-gradient(110% 120% at 0% 0%, color-mix(in srgb, var(--gh-media) 12%, transparent), transparent 60%);
    }

    /* ---------- now playing ---------- */
    .now {
      display: grid; grid-template-columns: minmax(0, 1fr); column-gap: 14px;
      grid-template-areas: "art" "top" "meta" "prog" "transport" "vol";
    }
    .art { grid-area: art; } .top { grid-area: top; } .meta { grid-area: meta; }
    .prog { grid-area: prog; } .transport { grid-area: transport; } .vol { grid-area: vol; }
    .main { display: contents; }
    .top, .meta, .prog, .transport, .vol { margin-top: 14px; }
    .top { margin-top: 16px; }
    .prog { margin-top: 10px; }
    ha-card.no-art .now {
      grid-template-columns: 64px minmax(0, 1fr);
      grid-template-areas: "top top" "art meta" "prog prog" "transport transport" "vol vol";
    }
    ha-card.no-art .top { margin-top: 0; }
    ha-card.no-art .art { margin-top: 12px; border-radius: 14px; align-self: center; }
    ha-card.no-art .meta { margin-top: 12px; align-self: center; }
    ha-card.no-art .art-ph ha-icon { --mdc-icon-size: 28px; }
    .art {
      position: relative; display: block; width: 100%; aspect-ratio: 1 / 1;
      border-radius: 18px; overflow: hidden;
      background: linear-gradient(145deg, color-mix(in srgb, var(--art) 38%, #151b29), #0d121c);
      box-shadow: 0 26px 60px -22px color-mix(in srgb, var(--art) 70%, transparent),
        0 10px 30px -12px rgba(0,0,0,0.6), inset 0 0 0 1px rgba(255,255,255,0.08);
      transform-origin: 50% 60%;
      transition: transform 360ms cubic-bezier(.2,.8,.2,1), box-shadow 360ms ease;
    }
    ha-card.is-paused .art { transform: scale(0.94);
      box-shadow: 0 16px 40px -22px color-mix(in srgb, var(--art) 45%, transparent),
        0 8px 24px -14px rgba(0,0,0,0.6), inset 0 0 0 1px rgba(255,255,255,0.08); }
    .art img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: 0;
      transition: opacity 400ms ease; }
    .art img.ready { opacity: 1; }
    .art-ph { position: absolute; inset: 0; display: grid; place-items: center;
      color: color-mix(in srgb, var(--art) 70%, white 10%); }
    .art-ph ha-icon { --mdc-icon-size: 72px; opacity: .8; }
    .art .sheen { position: absolute; inset: 0; pointer-events: none;
      background: linear-gradient(160deg, rgba(255,255,255,0.10), transparent 38%); }

    .top { display: flex; align-items: center; gap: 8px; min-height: 24px; }
    .who { display: inline-flex; align-items: center; gap: 7px; min-width: 0; flex: 1 1 auto;
      font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .09em; color: var(--gh-text-2); }
    .who span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .who ha-icon { --mdc-icon-size: 16px; color: var(--art); }
    .src {
      flex: 0 0 auto; max-width: 50%; display: inline-flex; align-items: center; gap: 5px;
      height: 24px; padding: 0 10px; border-radius: 999px;
      background: rgba(255,255,255,0.08); box-shadow: inset 0 0 0 1px rgba(255,255,255,0.08);
      font-size: 11px; font-weight: 600; color: var(--gh-text); letter-spacing: .02em;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .src::before { content: ""; flex: 0 0 auto; width: 6px; height: 6px; border-radius: 50%; background: var(--art);
      box-shadow: 0 0 8px var(--art); }

    .meta { min-width: 0; }
    .title { font-size: 20px; font-weight: 700; letter-spacing: -0.01em; line-height: 1.2;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .sub { margin-top: 4px; font-size: 14px; font-weight: 500; color: var(--gh-text-2);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sub b { font-weight: 600; color: color-mix(in srgb, var(--gh-text) 82%, var(--art)); }

    /* sliders (seek + volume) */
    input[type=range] {
      -webkit-appearance: none; appearance: none; display: block; width: 100%; margin: 0;
      background: transparent; height: 28px; cursor: pointer; --p: 0%; --track: 5px;
      touch-action: pan-y;
    }
    input[type=range]:disabled { cursor: default; }
    input[type=range]::-webkit-slider-runnable-track {
      height: var(--track); border-radius: 999px;
      background: linear-gradient(90deg, var(--fill, var(--art)) var(--p), rgba(255,255,255,0.14) var(--p));
      transition: height var(--gh-ease);
    }
    input[type=range]::-moz-range-track { height: var(--track); border-radius: 999px; background: rgba(255,255,255,0.14); }
    input[type=range]::-moz-range-progress { height: var(--track); border-radius: 999px; background: var(--fill, var(--art)); }
    input[type=range]::-webkit-slider-thumb {
      -webkit-appearance: none; width: 14px; height: 14px; border-radius: 50%; border: 0;
      margin-top: calc((var(--track) - 14px) / 2);
      background: #fff; box-shadow: 0 1px 6px rgba(0,0,0,0.45), 0 0 0 4px color-mix(in srgb, var(--art) 0%, transparent);
      transform: scale(0.72); transition: transform var(--gh-ease), box-shadow var(--gh-ease);
    }
    input[type=range]::-moz-range-thumb { width: 14px; height: 14px; border-radius: 50%; border: 0; background: #fff;
      box-shadow: 0 1px 6px rgba(0,0,0,0.45); }
    input[type=range]:hover, input[type=range]:active, input[type=range]:focus-visible { --track: 7px; }
    input[type=range]:hover::-webkit-slider-thumb, input[type=range]:active::-webkit-slider-thumb,
    input[type=range]:focus-visible::-webkit-slider-thumb {
      transform: scale(1); box-shadow: 0 1px 6px rgba(0,0,0,0.45), 0 0 0 5px color-mix(in srgb, var(--art) 28%, transparent);
    }
    input[type=range]:disabled::-webkit-slider-thumb { opacity: 0; }
    input[type=range]:focus-visible { outline-offset: 0; border-radius: 8px; }

    .prog { display: flex; flex-direction: column; gap: 0; }
    .times { display: flex; justify-content: space-between; align-items: center; margin-top: -2px;
      font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; color: var(--gh-text-2); letter-spacing: .02em; }
    .live { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 700; letter-spacing: .09em;
      color: var(--gh-text-2); text-transform: uppercase; min-height: 28px; }
    .live::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--gh-alert);
      box-shadow: 0 0 8px var(--gh-alert); }

    .transport { display: flex; align-items: center; justify-content: space-between; gap: 4px; }
    .tbtn {
      position: relative; width: 48px; height: 48px; border-radius: 50%; display: grid; place-items: center;
      color: var(--gh-text); transition: background var(--gh-ease), color var(--gh-ease), transform 120ms ease, opacity var(--gh-ease);
    }
    .tbtn ha-icon { --mdc-icon-size: 32px; }
    .tbtn.sm { width: 44px; height: 44px; color: var(--gh-text-2); }
    .tbtn.sm ha-icon { --mdc-icon-size: 21px; }
    .tbtn.sm[aria-pressed="true"] { color: var(--art); }
    .tbtn.sm[aria-pressed="true"]::after { content: ""; position: absolute; bottom: 5px; left: 50%; width: 4px; height: 4px;
      margin-left: -2px; border-radius: 50%; background: var(--art); box-shadow: 0 0 6px var(--art); }
    .tbtn:hover:not(:disabled) { background: rgba(255,255,255,0.07); }
    .tbtn:active:not(:disabled) { transform: scale(0.92); }
    .tbtn.na { visibility: hidden; }
    .play {
      width: 68px; height: 68px; border-radius: 50%; display: grid; place-items: center; flex: 0 0 auto;
      background: var(--art); color: #0b0f18;
      box-shadow: 0 12px 30px -10px var(--art), 0 0 0 1px rgba(255,255,255,0.16) inset, 0 0 26px -8px var(--art);
      transition: transform 120ms ease, box-shadow var(--gh-ease);
    }
    .play ha-icon { --mdc-icon-size: 36px; }
    .play:hover { box-shadow: 0 14px 34px -10px var(--art), 0 0 0 1px rgba(255,255,255,0.22) inset, 0 0 34px -6px var(--art); }
    .play:active { transform: scale(0.94); }
    .play.na { visibility: hidden; }

    .vol { display: flex; align-items: center; gap: 6px; }
    .vol .mute { width: 44px; height: 44px; flex: 0 0 auto; border-radius: 50%; display: grid; place-items: center;
      color: var(--gh-text-2); transition: color var(--gh-ease), background var(--gh-ease); margin-left: -8px; }
    .vol .mute ha-icon { --mdc-icon-size: 20px; }
    .vol .mute:hover:not(:disabled) { background: rgba(255,255,255,0.07); color: var(--gh-text); }
    .vol .mute[aria-pressed="true"] { color: var(--gh-alert); }
    .vol .mute:disabled { opacity: .5; }
    .vol input { flex: 1 1 auto; --fill: rgba(255,255,255,0.86); }
    .vol.muted input { --fill: rgba(255,255,255,0.3); }
    .vol .vv { flex: 0 0 auto; width: 32px; text-align: right; font-size: 11px; font-weight: 600;
      color: var(--gh-text-2); font-variant-numeric: tabular-nums; }
    .vstep { width: 44px; height: 44px; border-radius: 50%; display: grid; place-items: center; color: var(--gh-text-2); }
    .vstep:hover { background: rgba(255,255,255,0.07); color: var(--gh-text); }
    .vstep ha-icon { --mdc-icon-size: 20px; }

    /* ---------- idle ---------- */
    .idle { display: flex; align-items: center; gap: 14px; min-height: 64px; }
    .idle-ic {
      flex: 0 0 auto; width: 56px; height: 56px; border-radius: 16px; display: grid; place-items: center;
      background: var(--gh-surface-2); color: var(--gh-text-2);
      box-shadow: inset 0 0 0 1px rgba(255,255,255,0.06);
    }
    .idle-ic ha-icon { --mdc-icon-size: 26px; }
    .idle-txt { flex: 1 1 auto; min-width: 0; }
    .idle-txt .t { font-size: 16px; font-weight: 650; letter-spacing: -0.005em; }
    .idle-txt .s { margin-top: 3px; color: var(--gh-text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .pwr {
      flex: 0 0 auto; display: inline-flex; align-items: center; gap: 6px; height: 44px; padding: 0 16px 0 12px;
      border-radius: 999px; background: var(--gh-surface-2); color: var(--gh-text);
      box-shadow: inset 0 0 0 1px var(--gh-border); font-weight: 600;
      transition: background var(--gh-ease), box-shadow var(--gh-ease), color var(--gh-ease);
    }
    .pwr ha-icon { --mdc-icon-size: 20px; color: var(--gh-media); }
    .pwr:hover { background: color-mix(in srgb, var(--gh-media) 16%, transparent);
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--gh-media) 45%, transparent), 0 0 18px -6px var(--gh-media); }

    /* ---------- speaker chips + grouping ---------- */
    .section { margin-top: 16px; }
    .section-h { display: flex; align-items: center; gap: 8px; margin: 0 2px 8px; font-size: 11px; font-weight: 600;
      text-transform: uppercase; letter-spacing: .09em; color: var(--gh-text-2); }
    .section-h .n { color: var(--gh-text-3); }
    .chips { display: flex; gap: 8px; overflow-x: auto; scrollbar-width: none; margin: -4px -2px; padding: 4px 2px;
      -webkit-mask-image: linear-gradient(90deg, #000 calc(100% - 18px), transparent);
      mask-image: linear-gradient(90deg, #000 calc(100% - 18px), transparent); }
    .chips::-webkit-scrollbar { display: none; }
    .chip {
      --a: var(--gh-media);
      flex: 0 0 auto; position: relative; display: inline-flex; align-items: center; gap: 8px;
      height: 44px; max-width: 200px; padding: 0 14px 0 6px; border-radius: 999px;
      background: var(--gh-surface-2); box-shadow: inset 0 0 0 1px var(--gh-border);
      color: var(--gh-text); transition: background var(--gh-ease), box-shadow var(--gh-ease), color var(--gh-ease);
    }
    .chip:hover { background: rgba(255,255,255,0.1); }
    .chip .ci { flex: 0 0 auto; width: 32px; height: 32px; border-radius: 50%; display: grid; place-items: center;
      background: rgba(255,255,255,0.06); color: var(--gh-text-2); transition: background var(--gh-ease), color var(--gh-ease); }
    .chip .ci ha-icon, .chip .ci ha-state-icon { --mdc-icon-size: 20px; }
    .chip .nm { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 600; }
    .chip.playing .ci { color: var(--a); background: color-mix(in srgb, var(--a) 16%, transparent); }
    .chip[aria-pressed="true"] {
      --a: var(--art);
      background: color-mix(in srgb, var(--a) 16%, transparent);
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--a) 45%, transparent), 0 0 18px -6px var(--a);
    }
    .chip[aria-pressed="true"] .ci { color: var(--a); background: color-mix(in srgb, var(--a) 20%, transparent); }
    .chip.unavail { opacity: .45; }
    .chip .badge { position: absolute; top: 2px; left: 28px; width: 14px; height: 14px; border-radius: 50%;
      display: grid; place-items: center; background: #1b2232; color: var(--gh-warn); }
    .chip .badge ha-icon { --mdc-icon-size: 14px; }
    .chip .lnk { flex: 0 0 auto; color: var(--gh-text-2); margin-left: -2px; }
    .chip .lnk ha-icon { --mdc-icon-size: 14px; }

    .eq { flex: 0 0 auto; display: inline-flex; align-items: flex-end; gap: 2px; width: 13px; height: 12px; color: var(--a); }
    .eq i { display: block; width: 3px; height: 30%; border-radius: 1.5px; background: currentColor; }
    .eq.on i { height: 60%; animation: gh-eq 1s ease-in-out infinite alternate; }
    .eq.on i:nth-child(2) { height: 100%; }
    .eq.on i:nth-child(3) { height: 40%; }
    .eq.on i:nth-child(2) { animation-duration: .74s; animation-delay: -.4s; }
    .eq.on i:nth-child(3) { animation-duration: 1.18s; animation-delay: -.7s; }
    @keyframes gh-eq { 0% { height: 22%; } 45% { height: 100%; } 100% { height: 48%; } }

    .groups { display: flex; flex-wrap: wrap; gap: 8px; }
    .gtog {
      display: inline-flex; align-items: center; gap: 7px; height: 40px; max-width: 100%; padding: 0 14px 0 10px;
      border-radius: 999px; background: transparent; box-shadow: inset 0 0 0 1px var(--gh-border);
      color: var(--gh-text-2); font-weight: 600;
      transition: background var(--gh-ease), box-shadow var(--gh-ease), color var(--gh-ease);
    }
    .gtog span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .gtog ha-icon { --mdc-icon-size: 18px; }
    .gtog:hover { background: rgba(255,255,255,0.06); color: var(--gh-text); }
    .gtog[aria-pressed="true"] {
      color: var(--gh-text); background: color-mix(in srgb, var(--art) 14%, transparent);
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--art) 42%, transparent);
    }
    .gtog[aria-pressed="true"] ha-icon { color: var(--art); }
    .gtog:disabled { opacity: .45; }

    /* ---------- wide layout: art left, controls right ---------- */
    @container gh-media (min-width: 640px) {
      .now, ha-card.no-art .now { grid-template-columns: minmax(220px, 38%) minmax(0, 1fr); grid-template-areas: "art main";
        column-gap: 26px; align-items: center; }
      ha-card.no-art .now { grid-template-columns: 120px minmax(0, 1fr); align-items: start; }
      ha-card.no-art .art { margin-top: 0; border-radius: 18px; }
      ha-card.no-art .art-ph ha-icon { --mdc-icon-size: 44px; }
      .art { align-self: start; }
      .main { grid-area: main; display: flex; flex-direction: column; min-width: 0; gap: 16px; padding: 2px 4px 0 0; }
      .main > * { margin-top: 0 !important; }
      .title { font-size: 26px; }
      .sub { font-size: 15px; }
      .transport { justify-content: flex-start; gap: 14px; }
      .vol { max-width: 420px; }
      .idle { min-height: 72px; }
    }
    @container gh-media (min-width: 900px) {
      .now { grid-template-columns: 300px minmax(0, 1fr); column-gap: 34px; }
      .title { font-size: 30px; }
    }
    @container gh-media (max-width: 340px) {
      .play { width: 60px; height: 60px; }
      .tbtn { width: 44px; height: 44px; }
      .tbtn ha-icon { --mdc-icon-size: 28px; }
      .title { font-size: 18px; }
    }

    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { transition: none !important; animation: none !important; }
      ha-card.is-paused .art { transform: none; }
    }
  `;

  /* ---------------------------------------------------------------- helpers */

  function h(tag, attrs, children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'style') el.style.cssText = v;
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    if (children) for (const c of [].concat(children)) if (c) el.append(c);
    return el;
  }

  const icon = (name) => h('ha-icon', { icon: name });
  const setText = (el, t) => { if (el.textContent !== t) el.textContent = t; };
  const setAttr = (el, k, v) => { if (el.getAttribute(k) !== v) el.setAttribute(k, v); };

  /* ------------------------------------------------------------------ card */

  class GlasshouseMediaCard extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
      this._seen = new Map();
      this._chips = new Map();
      this._gtogs = new Map();
      this._active = null;
      this._userPicked = false;
      this._volDrag = false;
      this._volTarget = null; // { eid, v, until }
      this._seekDrag = false;
      this._seekTarget = null; // { eid, pos, base, until }
      this._artUrl = null;
      this._raf = 0;
      this._visible = true;
      this._built = false;
      this._onVis = () => this._syncTicker();
    }

    static getStubConfig(hass) {
      const ids = Object.keys((hass && hass.states) || {}).filter((id) => domainOf(id) === 'media_player').slice(0, 3);
      return { players: (ids.length ? ids : ['media_player.example']).map((entity) => ({ entity })) };
    }

    setConfig(config) {
      if (!config || typeof config !== 'object') throw new Error('glasshouse-media-card: invalid configuration');
      let list = config.players;
      if (list === undefined && config.entity) list = [config.entity];
      if (!Array.isArray(list) || !list.length) {
        throw new Error('glasshouse-media-card: "players" must be a non-empty list of media_player entities');
      }
      const players = list.map((p, i) => {
        const o = typeof p === 'string' ? { entity: p } : { ...p };
        if (!o.entity || typeof o.entity !== 'string' || domainOf(o.entity) !== 'media_player' || !o.entity.includes('.')) {
          throw new Error(`glasshouse-media-card: players[${i}] needs a media_player "entity"`);
        }
        return o;
      });
      const def = config.default === undefined ? 'auto' : config.default;
      if (def !== 'auto' && !players.some((p) => p.entity === def)) {
        throw new Error('glasshouse-media-card: "default" must be "auto" or one of the configured players');
      }
      for (const k of ['show_volume', 'show_group']) {
        if (config[k] !== undefined && typeof config[k] !== 'boolean') {
          throw new Error(`glasshouse-media-card: "${k}" must be true or false`);
        }
      }
      this._config = {
        ...config, players, default: def,
        show_volume: config.show_volume !== false, show_group: config.show_group !== false,
      };
      this._built = false;
      this._seen.clear();
      this._active = null;
      this._userPicked = false;
      this._volTarget = null;
      this._seekTarget = null;
      if (this._hass) this.hass = this._hass;
    }

    set hass(hass) {
      this._hass = hass;
      if (!this._config || !hass) return;
      const first = !this._built;
      if (first) this._build();
      if (!this._active) this._active = this._initialActive();
      const ids = this._watchIds();
      let changed = first;
      for (const id of ids) {
        const st = hass.states[id];
        if (!this._seen.has(id) || this._seen.get(id) !== st) { this._seen.set(id, st); changed = true; }
      }
      if (!changed) return;
      this._maybeAutoSwitch();
      this._update();
    }

    get hass() { return this._hass; }

    getCardSize() {
      const st = this._stateOf(this._active);
      return this._hasMedia(st) ? 9 : 3;
    }

    getGridOptions() {
      return { columns: 12, min_columns: 6, rows: 'auto' };
    }

    connectedCallback() {
      document.addEventListener('visibilitychange', this._onVis);
      if (typeof IntersectionObserver === 'function' && !this._io) {
        this._io = new IntersectionObserver((entries) => {
          this._visible = entries.some((e) => e.isIntersecting);
          this._syncTicker();
        });
        this._io.observe(this);
      }
      this._syncTicker();
    }

    disconnectedCallback() {
      document.removeEventListener('visibilitychange', this._onVis);
      if (this._io) { this._io.disconnect(); this._io = null; }
      this._stopTicker();
    }

    /* ------------------------------------------------------------ state */

    _stateOf(id) { return id && this._hass ? this._hass.states[id] : undefined; }

    _watchIds() {
      const ids = new Set(this._config.players.map((p) => p.entity));
      const st = this._stateOf(this._active);
      if (st && Array.isArray(st.attributes.group_members)) st.attributes.group_members.forEach((g) => ids.add(g));
      return [...ids];
    }

    _hasMedia(st) {
      if (!st) return false;
      if (ACTIVE_STATES.has(st.state)) return true;
      return ['on', 'idle'].includes(st.state) && !!st.attributes.media_title;
    }

    _initialActive() {
      if (this._config.default !== 'auto') return this._config.default;
      return this._mostRecentPlaying() || this._config.players[0].entity;
    }

    _mostRecentPlaying() {
      let best = null, bestT = -Infinity;
      for (const p of this._config.players) {
        const st = this._stateOf(p.entity);
        if (!st || st.state !== 'playing') continue;
        const t = Date.parse(st.last_changed) || 0;
        if (t > bestT) { bestT = t; best = p.entity; }
      }
      return best;
    }

    /** In auto mode, move to a player that starts playing while the active one has nothing, until the user picks. */
    _maybeAutoSwitch() {
      if (this._userPicked || this._config.default !== 'auto') return;
      const cur = this._stateOf(this._active);
      if (this._hasMedia(cur)) return; // never jump away from something paused or playing
      const next = this._mostRecentPlaying();
      if (next && next !== this._active) this._setActive(next, false);
    }

    _setActive(eid, byUser) {
      if (byUser) this._userPicked = true;
      if (eid === this._active) return;
      this._active = eid;
      this._volTarget = null;
      this._seekTarget = null;
      this._volDrag = false;
      this._seekDrag = false;
      for (const id of this._watchIds()) if (!this._seen.has(id)) this._seen.set(id, this._stateOf(id));
      this._update();
    }

    _playerConf(eid) { return this._config.players.find((p) => p.entity === eid) || { entity: eid }; }

    _nameOf(eid) {
      const c = this._playerConf(eid);
      if (c.name) return c.name;
      const st = this._stateOf(eid);
      return (st && st.attributes.friendly_name) || eid.split('.')[1].replace(/_/g, ' ');
    }

    _call(service, data) {
      if (!this._hass) return undefined;
      const p = this._hass.callService('media_player', service, data);
      if (p && typeof p.catch === 'function') p.catch(() => {});
      return p;
    }

    _haptic(kind) {
      this.dispatchEvent(new CustomEvent('haptic', { detail: kind || 'light', bubbles: true, composed: true }));
    }

    _moreInfo(eid) {
      this.dispatchEvent(new CustomEvent('hass-more-info', { detail: { entityId: eid }, bubbles: true, composed: true }));
    }

    _artUrlFor(st) {
      const pic = st && (st.attributes.entity_picture || st.attributes.entity_picture_local);
      if (!pic) return null;
      if (/^(https?:|data:|blob:)/i.test(pic)) return pic;
      if (this._hass && typeof this._hass.hassUrl === 'function') return this._hass.hassUrl(pic);
      return pic;
    }

    /* ------------------------------------------------------------- build */

    /** Tap = primary, hold (500 ms) = secondary (more-info). Keyboard activation = primary. */
    _press(el, onTap, onHold) {
      let timer = 0, held = false, x0 = 0, y0 = 0;
      const cancel = () => { clearTimeout(timer); timer = 0; };
      el.addEventListener('pointerdown', (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        held = false; x0 = e.clientX; y0 = e.clientY;
        cancel();
        timer = setTimeout(() => { timer = 0; held = true; onHold(); }, HOLD_MS);
      });
      el.addEventListener('pointermove', (e) => {
        if (timer && Math.hypot(e.clientX - x0, e.clientY - y0) > MOVE_TOLERANCE) cancel();
      });
      for (const t of ['pointerup', 'pointercancel', 'pointerleave']) el.addEventListener(t, cancel);
      el.addEventListener('contextmenu', (e) => { e.preventDefault(); });
      el.addEventListener('click', (e) => {
        if (held) { held = false; e.preventDefault(); return; }
        onTap();
      });
    }

    _build() {
      const root = this.shadowRoot;
      root.innerHTML = '';
      root.append(h('style', { text: STYLE }));
      const $ = {};
      this._$ = $;

      $.bgImg = h('img', { class: 'bg-img', alt: '', 'aria-hidden': 'true' });
      $.bg = h('div', { class: 'bg' }, [$.bgImg, h('div', { class: 'bg-glow' })]);

      // artwork
      $.artImg = h('img', { alt: '' });
      $.artPh = h('div', { class: 'art-ph' }, icon('mdi:music-note'));
      $.art = h('button', { class: 'art', 'aria-label': 'Play or pause' }, [$.artPh, $.artImg, h('div', { class: 'sheen' })]);
      this._press($.art, () => this._playPause(), () => this._moreInfo(this._active));
      $.artImg.addEventListener('load', () => this._onArtLoad());
      $.artImg.addEventListener('error', () => { $.artImg.classList.remove('ready'); $.artPh.hidden = false; });
      $.bgImg.addEventListener('load', () => $.bgImg.classList.add('ready'));

      // header line
      $.whoIc = icon('mdi:speaker');
      $.whoName = h('span');
      $.src = h('span', { class: 'src' });
      $.who = h('button', { class: 'who', 'aria-label': 'More info' }, [$.whoIc, $.whoName]);
      $.who.addEventListener('click', () => this._moreInfo(this._active));
      $.top = h('div', { class: 'top' }, [$.who, $.src]);

      $.title = h('div', { class: 'title' });
      $.sub = h('div', { class: 'sub' });
      $.meta = h('div', { class: 'meta' }, [$.title, $.sub]);

      // progress
      $.seek = h('input', { type: 'range', min: '0', max: '100', step: '1', 'aria-label': 'Seek' });
      $.el = h('span', { class: 'el' });
      $.dur = h('span', { class: 'dur' });
      $.times = h('div', { class: 'times' }, [$.el, $.dur]);
      $.live = h('div', { class: 'live', text: 'Live' });
      $.prog = h('div', { class: 'prog' }, [$.seek, $.times, $.live]);
      $.seek.addEventListener('input', () => {
        this._seekDrag = true;
        this._paintSeek(Number($.seek.value));
      });
      $.seek.addEventListener('change', () => this._commitSeek(Number($.seek.value)));

      // transport
      const tb = (cls, label, ic) => h('button', { class: cls, 'aria-label': label }, icon(ic));
      $.shuffle = tb('tbtn sm', 'Shuffle', 'mdi:shuffle-variant');
      $.prev = tb('tbtn', 'Previous', 'mdi:skip-previous');
      $.play = tb('play', 'Play', 'mdi:play');
      $.next = tb('tbtn', 'Next', 'mdi:skip-next');
      $.repeat = tb('tbtn sm', 'Repeat', 'mdi:repeat-off');
      $.transport = h('div', { class: 'transport' }, [$.shuffle, $.prev, $.play, $.next, $.repeat]);
      $.play.addEventListener('click', () => this._playPause());
      $.prev.addEventListener('click', () => { this._call('media_previous_track', { entity_id: this._active }); this._haptic('light'); });
      $.next.addEventListener('click', () => { this._call('media_next_track', { entity_id: this._active }); this._haptic('light'); });
      $.shuffle.addEventListener('click', () => {
        const st = this._stateOf(this._active);
        this._call('shuffle_set', { entity_id: this._active, shuffle: !(st && st.attributes.shuffle) });
        this._haptic('light');
      });
      $.repeat.addEventListener('click', () => {
        const st = this._stateOf(this._active);
        const cur = (st && st.attributes.repeat) || 'off';
        this._call('repeat_set', { entity_id: this._active, repeat: REPEAT_NEXT[cur] || 'off' });
        this._haptic('light');
      });

      // volume
      $.mute = h('button', { class: 'mute', 'aria-label': 'Mute' }, icon('mdi:volume-high'));
      $.vol = h('input', { type: 'range', min: '0', max: '100', step: '1', 'aria-label': 'Volume' });
      $.vv = h('span', { class: 'vv' });
      $.vdown = h('button', { class: 'vstep', 'aria-label': 'Volume down' }, icon('mdi:volume-minus'));
      $.vup = h('button', { class: 'vstep', 'aria-label': 'Volume up' }, icon('mdi:volume-plus'));
      $.volRow = h('div', { class: 'vol' }, [$.mute, $.vol, $.vv, $.vdown, $.vup]);
      $.mute.addEventListener('click', () => {
        const st = this._stateOf(this._active);
        this._call('volume_mute', { entity_id: this._active, is_volume_muted: !(st && st.attributes.is_volume_muted) });
        this._haptic('light');
      });
      $.vol.addEventListener('input', () => { this._volDrag = true; this._paintVol(Number($.vol.value)); });
      $.vol.addEventListener('change', () => this._commitVol(Number($.vol.value)));
      $.vdown.addEventListener('click', () => this._call('volume_down', { entity_id: this._active }));
      $.vup.addEventListener('click', () => this._call('volume_up', { entity_id: this._active }));

      $.main = h('div', { class: 'main' }, [$.top, $.meta, $.prog, $.transport, $.volRow]);
      $.now = h('div', { class: 'now' }, [$.art, $.main]);

      // idle
      $.idleIc = icon('mdi:speaker');
      $.idleT = h('div', { class: 't', text: 'Nothing playing' });
      $.idleS = h('div', { class: 's' });
      $.pwr = h('button', { class: 'pwr', 'aria-label': 'Turn on' }, [icon('mdi:power'), h('span', { text: 'Turn on' })]);
      $.pwr.addEventListener('click', () => { this._call('turn_on', { entity_id: this._active }); this._haptic('light'); });
      $.idleBox = h('button', { class: 'idle-ic', 'aria-label': 'More info' }, $.idleIc);
      $.idleBox.addEventListener('click', () => this._moreInfo(this._active));
      $.idle = h('div', { class: 'idle' }, [$.idleBox, h('div', { class: 'idle-txt' }, [$.idleT, $.idleS]), $.pwr]);

      // speakers + group
      // ha-scrollbar: hass-swipe-navigation leaves horizontally scrollable .ha-scrollbar elements alone
      $.chips = h('div', { class: 'chips ha-scrollbar', role: 'group', 'aria-label': 'Speakers' });
      $.spkN = h('span', { class: 'n' });
      $.speakers = h('div', { class: 'section' }, [h('div', { class: 'section-h' }, [h('span', { text: 'Speakers' }), $.spkN]), $.chips]);
      $.groups = h('div', { class: 'groups', role: 'group', 'aria-label': 'Group speakers' });
      $.grpH = h('span', { text: 'Group' });
      $.group = h('div', { class: 'section' }, [h('div', { class: 'section-h' }, [$.grpH]), $.groups]);

      $.card = h('ha-card', {}, [$.bg, $.now, $.idle, $.speakers, $.group]);
      root.append($.card);

      this._chips.clear();
      this._gtogs.clear();
      for (const p of this._config.players) this._chips.set(p.entity, this._makeChip(p));
      $.chips.append(...this._chips.values());
      this._built = true;
    }

    _makeChip(p) {
      const eid = p.entity;
      let ic;
      if (p.icon) ic = icon(p.icon);
      else { ic = h('ha-state-icon'); }
      const eq = h('span', { class: 'eq', 'aria-hidden': 'true' }, [h('i'), h('i'), h('i')]);
      const nm = h('span', { class: 'nm' });
      const lnk = h('span', { class: 'lnk', hidden: true, 'aria-hidden': 'true' }, icon('mdi:link-variant'));
      const badge = h('span', { class: 'badge', hidden: true }, icon('mdi:alert-circle-outline'));
      const chip = h('button', { class: 'chip', 'data-entity': eid, 'aria-pressed': 'false' },
        [h('span', { class: 'ci' }, ic), badge, nm, lnk, eq]);
      chip._parts = { ic, eq, nm, lnk, badge };
      this._press(chip, () => { this._setActive(eid, true); this._haptic('light'); }, () => this._moreInfo(eid));
      return chip;
    }

    /* ------------------------------------------------------------ update */

    _update() {
      if (!this._built || !this._hass) return;
      const $ = this._$;
      const c = this._config;
      const eid = this._active;
      const st = this._stateOf(eid);
      const a = (st && st.attributes) || {};
      const media = this._hasMedia(st);
      const playing = !!st && st.state === 'playing';
      const unavailable = !st || st.state === 'unavailable';

      $.card.classList.toggle('is-idle', !media);
      $.card.classList.toggle('is-paused', media && !playing);
      $.card.classList.toggle('no-art', media && !this._artUrlFor(st));
      $.now.hidden = !media;
      $.idle.hidden = media;

      // artwork + colour
      const url = media ? this._artUrlFor(st) : null;
      if (url !== this._artUrl) {
        this._artUrl = url;
        $.artImg.classList.remove('ready');
        $.bgImg.classList.remove('ready');
        if (url) {
          $.artImg.src = url;
          $.bgImg.src = url;
          $.artPh.hidden = true;
          this._sampleColor(url);
        } else {
          $.artImg.removeAttribute('src');
          $.bgImg.removeAttribute('src');
          $.artPh.hidden = false;
          this._setArtColor(null);
        }
      }

      const name = this._nameOf(eid);
      if (media) {
        setText($.whoName, name);
        $.whoIc.setAttribute('icon', playing ? 'mdi:volume-high' : 'mdi:pause');
        const source = a.app_name || a.source || '';
        setText($.src, source);
        $.src.hidden = !source;
        setText($.title, a.media_title || 'Unknown title');
        const lead = a.media_artist || a.media_album_artist || a.media_series_title || a.media_channel || '';
        const tail = a.media_album_name || (a.media_season && a.media_episode ? `S${a.media_season} · E${a.media_episode}` : '');
        $.sub.textContent = '';
        if (lead) $.sub.append(h('b', { text: lead }));
        if (lead && tail) $.sub.append(document.createTextNode(' · '));
        if (tail) $.sub.append(document.createTextNode(tail));
        if (!lead && !tail) $.sub.textContent = cap(st.state);
        setAttr($.art, 'aria-label', `${playing ? 'Pause' : 'Play'} ${a.media_title || ''}`.trim());

        // progress
        const dur = Number(a.media_duration);
        const hasDur = dur > 0;
        $.seek.hidden = !hasDur;
        $.times.hidden = !hasDur;
        $.live.hidden = hasDur || !playing;
        $.prog.hidden = !hasDur && !playing;
        $.seek.disabled = !has(st, F.SEEK);
        if (hasDur) setAttr($.seek, 'max', String(Math.round(dur)));
        setText($.dur, fmtTime(dur));
        if (this._seekTarget && (this._seekTarget.eid !== eid
          || a.media_position_updated_at !== this._seekTarget.base || Date.now() > this._seekTarget.until)) this._seekTarget = null;
        this._tick();

        // transport
        const canPause = has(st, F.PAUSE), canPlay = has(st, F.PLAY) || canPause, canStop = has(st, F.STOP);
        const showPlay = playing ? canPause || canStop : canPlay;
        $.play.classList.toggle('na', !showPlay);
        $.play.disabled = !showPlay;
        const pIcon = playing ? (canPause ? 'mdi:pause' : 'mdi:stop') : 'mdi:play';
        $.play.firstChild.setAttribute('icon', pIcon);
        setAttr($.play, 'aria-label', playing ? (canPause ? 'Pause' : 'Stop') : 'Play');
        this._gate($.prev, has(st, F.PREVIOUS_TRACK));
        this._gate($.next, has(st, F.NEXT_TRACK));
        this._gate($.shuffle, has(st, F.SHUFFLE_SET));
        this._gate($.repeat, has(st, F.REPEAT_SET));
        setAttr($.shuffle, 'aria-pressed', String(!!a.shuffle));
        $.shuffle.firstChild.setAttribute('icon', a.shuffle ? 'mdi:shuffle-variant' : 'mdi:shuffle-disabled');
        const rep = a.repeat || 'off';
        setAttr($.repeat, 'aria-pressed', String(rep !== 'off'));
        $.repeat.firstChild.setAttribute('icon', rep === 'one' ? 'mdi:repeat-once' : rep === 'all' ? 'mdi:repeat' : 'mdi:repeat-off');
        setAttr($.repeat, 'aria-label', `Repeat: ${rep}`);

        // volume
        const canSet = has(st, F.VOLUME_SET) && isNum(a.volume_level);
        const canMute = has(st, F.VOLUME_MUTE);
        const canStep = !canSet && has(st, F.VOLUME_STEP);
        $.volRow.hidden = !c.show_volume || !(canSet || canMute || canStep);
        $.vol.hidden = !canSet;
        $.vv.hidden = !canSet;
        $.vdown.hidden = !canStep;
        $.vup.hidden = !canStep;
        $.mute.disabled = !canMute;
        const muted = !!a.is_volume_muted;
        setAttr($.mute, 'aria-pressed', String(muted));
        setAttr($.mute, 'aria-label', muted ? 'Unmute' : 'Mute');
        $.volRow.classList.toggle('muted', muted);
        if (canSet && !this._volDrag) {
          let v = Number(a.volume_level);
          const t = this._volTarget;
          if (t && t.eid === eid && Date.now() < t.until && Math.abs(v - t.v) > VOL_TOL) v = t.v;
          else this._volTarget = null;
          $.vol.value = String(Math.round(v * 100));
          this._paintVol(Math.round(v * 100));
        } else if (!canSet) {
          this._paintVolIcon(muted ? 0 : 50);
        }
      } else {
        $.idleIc.setAttribute('icon', this._playerConf(eid).icon || 'mdi:speaker');
        const off = !st || ['off', 'standby'].includes(st.state);
        const stateText = !st ? 'Not found' : unavailable ? 'Unavailable' : off ? 'Off' : cap(st.state);
        setText($.idleT, unavailable ? 'Speaker unavailable' : 'Nothing playing');
        setText($.idleS, `${name} · ${stateText}`);
        $.pwr.hidden = !(off && st && has(st, F.TURN_ON));
      }

      this._updateChips();
      this._updateGroup();
      this._syncTicker();
    }

    _gate(btn, ok) {
      btn.classList.toggle('na', !ok);
      btn.disabled = !ok;
      if (ok) btn.removeAttribute('aria-hidden'); else btn.setAttribute('aria-hidden', 'true');
    }

    _updateChips() {
      const $ = this._$;
      const act = this._stateOf(this._active);
      const members = (act && Array.isArray(act.attributes.group_members)) ? act.attributes.group_members : [];
      let playingN = 0;
      for (const [eid, chip] of this._chips) {
        const st = this._stateOf(eid);
        const p = chip._parts;
        const playing = !!st && st.state === 'playing';
        if (playing) playingN += 1;
        setText(p.nm, this._nameOf(eid));
        if (p.ic.tagName === 'HA-STATE-ICON') { p.ic.hass = this._hass; p.ic.stateObj = st; }
        chip.classList.toggle('playing', playing);
        chip.classList.toggle('unavail', !st || st.state === 'unavailable');
        p.badge.hidden = !(!st || st.state === 'unavailable');
        p.eq.classList.toggle('on', playing);
        p.eq.hidden = !playing && !(st && st.state === 'paused');
        p.lnk.hidden = !(eid !== this._active && members.includes(eid) && members.length > 1);
        setAttr(chip, 'aria-pressed', String(eid === this._active));
        const stText = !st ? 'not found' : st.state;
        setAttr(chip, 'aria-label', `${this._nameOf(eid)}, ${stText}`);
      }
      setText($.spkN, playingN ? `${playingN} playing` : '');
      $.speakers.hidden = this._config.players.length < 2;
    }

    _updateGroup() {
      const $ = this._$;
      const eid = this._active;
      const st = this._stateOf(eid);
      const members = st && Array.isArray(st.attributes.group_members) ? st.attributes.group_members : null;
      const show = this._config.show_group && !!members && this._hasMedia(st);
      $.group.hidden = !show;
      if (!show) return;
      const candidates = [];
      for (const p of this._config.players) if (p.entity !== eid) candidates.push(p.entity);
      for (const m of members) if (m !== eid && !candidates.includes(m)) candidates.push(m);
      // drop toggles no longer relevant
      for (const [id, el] of this._gtogs) if (!candidates.includes(id)) { el.remove(); this._gtogs.delete(id); }
      candidates.forEach((id, i) => {
        let el = this._gtogs.get(id);
        if (!el) {
          el = h('button', { class: 'gtog', 'data-entity': id, 'aria-pressed': 'false' }, [icon('mdi:plus'), h('span')]);
          el.addEventListener('click', () => this._toggleGroup(id));
          this._gtogs.set(id, el);
        }
        if ($.groups.children[i] !== el) $.groups.insertBefore(el, $.groups.children[i] || null);
        const joined = members.includes(id);
        const other = this._stateOf(id);
        el.disabled = !other || other.state === 'unavailable';
        setAttr(el, 'aria-pressed', String(joined));
        el.firstChild.setAttribute('icon', joined ? 'mdi:check-circle' : 'mdi:plus-circle-outline');
        setText(el.lastChild, this._nameOf(id));
        setAttr(el, 'aria-label', `${joined ? 'Remove' : 'Add'} ${this._nameOf(id)} ${joined ? 'from' : 'to'} the group`);
      });
      const n = members.filter((m) => m !== eid).length;
      setText($.grpH, n ? `Group · ${n + 1} speakers` : 'Group');
      $.group.hidden = !candidates.length;
    }

    /* ----------------------------------------------------------- actions */

    _playPause() {
      const st = this._stateOf(this._active);
      if (!st || !this._hasMedia(st)) return;
      const playing = st.state === 'playing';
      if (playing && !has(st, F.PAUSE) && has(st, F.STOP)) this._call('media_stop', { entity_id: this._active });
      else this._call('media_play_pause', { entity_id: this._active });
      this._haptic('light');
    }

    _toggleGroup(id) {
      const st = this._stateOf(this._active);
      const members = (st && st.attributes.group_members) || [];
      if (members.includes(id)) this._call('unjoin', { entity_id: id });
      else this._call('join', { entity_id: this._active, group_members: [id] });
      this._haptic('light');
    }

    _commitSeek(pos) {
      this._seekDrag = false;
      const st = this._stateOf(this._active);
      if (!st || !has(st, F.SEEK)) return;
      this._seekTarget = {
        eid: this._active, pos, base: st.attributes.media_position_updated_at,
        at: Date.now(), until: Date.now() + TARGET_TTL,
      };
      this._call('media_seek', { entity_id: this._active, seek_position: pos });
      this._tick();
    }

    _commitVol(v) {
      this._volDrag = false;
      const level = Math.round(clamp(v, 0, 100)) / 100;
      this._volTarget = { eid: this._active, v: level, until: Date.now() + TARGET_TTL };
      this._call('volume_set', { entity_id: this._active, volume_level: level });
      this._paintVol(Math.round(level * 100));
    }

    _paintVol(v) {
      const $ = this._$;
      $.vol.style.setProperty('--p', `${v}%`);
      setText($.vv, String(v));
      this._paintVolIcon(v);
    }

    _paintVolIcon(v) {
      const $ = this._$;
      const st = this._stateOf(this._active);
      const muted = !!(st && st.attributes.is_volume_muted);
      const ic = muted || v === 0 ? 'mdi:volume-off' : v < 34 ? 'mdi:volume-low' : v < 67 ? 'mdi:volume-medium' : 'mdi:volume-high';
      $.mute.firstChild.setAttribute('icon', ic);
    }

    _paintSeek(pos) {
      const $ = this._$;
      const max = Number($.seek.max) || 1;
      $.seek.style.setProperty('--p', `${clamp((pos / max) * 100, 0, 100)}%`);
      setText($.el, fmtTime(pos));
      setAttr($.seek, 'aria-valuetext', `${fmtTime(pos)} of ${fmtTime(max)}`);
    }

    /** Current position of the active player (seconds), honouring a pending seek. */
    _position(now) {
      const st = this._stateOf(this._active);
      if (!st) return 0;
      const t = now === undefined ? Date.now() : now;
      const s = this._seekTarget;
      if (s && s.eid === this._active) {
        const d = Number(st.attributes.media_duration);
        const p = s.pos + (st.state === 'playing' ? (t - s.at) / 1000 : 0);
        return d > 0 ? clamp(p, 0, d) : p;
      }
      return livePosition(st, t);
    }

    _tick() {
      if (!this._built || this._seekDrag) return;
      const st = this._stateOf(this._active);
      if (!st || !(Number(st.attributes.media_duration) > 0)) return;
      const pos = this._position();
      this._$.seek.value = String(Math.floor(pos));
      this._paintSeek(pos);
    }

    /* ------------------------------------------------- progress ticker */

    _shouldTick() {
      const st = this._stateOf(this._active);
      const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
      return !!(this.isConnected && this._visible && !hidden && st && st.state === 'playing'
        && Number(st.attributes.media_duration) > 0);
    }

    _syncTicker() {
      if (this._shouldTick()) this._startTicker();
      else this._stopTicker();
    }

    _startTicker() {
      if (this._raf) return;
      const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (f) => setTimeout(f, 250);
      let last = 0;
      const loop = (ts) => {
        if (!this._shouldTick()) { this._raf = 0; return; }
        // repaint ~4x a second: smooth enough for the bar, cheap on battery
        if (!last || (ts || Date.now()) - last > 240) { last = ts || Date.now(); this._tick(); }
        this._raf = raf(loop);
      };
      this._raf = raf(loop);
    }

    _stopTicker() {
      if (!this._raf) return;
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this._raf);
      clearTimeout(this._raf);
      this._raf = 0;
    }

    /* --------------------------------------------------- art colour */

    _onArtLoad() {
      const $ = this._$;
      $.artImg.classList.add('ready');
      $.artPh.hidden = true;
    }

    _sampleColor(url) {
      const isSameOrigin = (() => {
        if (/^(data:|blob:)/i.test(url)) return true;
        try { return new URL(url, location.href).origin === location.origin; } catch (e) { return false; }
      })();
      const img = new Image();
      if (!isSameOrigin) img.crossOrigin = 'anonymous'; // works only if the server sends CORS headers
      img.decoding = 'async';
      img.onload = () => { if (this._artUrl === url) this._setArtColor(sampleImage(img)); };
      img.onerror = () => { if (this._artUrl === url) this._setArtColor(null); };
      img.src = url;
    }

    _setArtColor(rgb) {
      const card = this._$.card;
      if (rgb) card.style.setProperty('--art', `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`);
      else card.style.removeProperty('--art');
      this._artColor = rgb;
    }
  }

  GlasshouseMediaCard._internals = { livePosition, dominantColor, fmtTime, F };

  if (!customElements.get(TAG)) {
    customElements.define(TAG, GlasshouseMediaCard);
    window.customCards = window.customCards || [];
    window.customCards.push({
      type: TAG,
      name: 'Glasshouse Media Card',
      description: 'A premium now-playing card with artwork glow, live progress, volume, speaker switching and grouping.',
      preview: true,
      documentationURL: 'https://github.com/petergCA/glasshouse-media-card',
    });
    console.info(
      `%c GLASSHOUSE-MEDIA-CARD %c v${VERSION} `,
      'color:#0a0f18;background:#c48cff;font-weight:700;border-radius:4px 0 0 4px;padding:2px 4px',
      'color:#e9eef6;background:#1b2333;font-weight:600;border-radius:0 4px 4px 0;padding:2px 4px',
    );
  }
})();
