/* CUCI delete-job codec + trust boundary (classic script -> window.CUCI)
 *
 * Job files and share codes are UNTRUSTED input. This module is the only place
 * that turns them into data the app will act on. It:
 *   - caps input sizes (code length, compressed bytes, decompressed JSON)
 *   - inflates with a hard output limit (zip-bomb guard)
 *   - parses JSON with a reviver that drops __proto__/constructor/prototype
 *   - validates and coerces every field, clamps numbers, whitelists enums
 *   - strips control characters and collapses blank lines in text
 *   - caps array lengths and totals
 * No eval/Function/dynamic import is used anywhere on this path.
 */
(function () {
  const C = (window.CUCI = window.CUCI || {});

  const LIMITS = {
    codeChars: 1_000_000, // share-code text length
    compressedBytes: 1_000_000, // base64-decoded payload
    jsonBytes: 4 * 1024 * 1024, // decompressed payload / .json file
    clips: 200,
    deletesPerClip: 5_000,
    totalDeletes: 50_000,
    subtitlesPerClip: 20,
    subtitleEventsPerClip: 100_000,
    totalSubtitleEvents: 500_000,
    textChars: 2_000,
    nameChars: 255,
    descriptionChars: 200,
    ms: 1_000_000_000, // ~11.5 days, plenty for any clip
  };

  const CONTAINERS = ['mp4', 'mov', 'mkv', 'webm', 'avi', 'wmv', 'flv', 'ts'];
  const VIDEO_CODECS = ['libx264', 'libx265', 'h264_nvenc', 'hevc_nvenc', 'libvpx-vp9', 'mpeg4', 'wmv2'];
  // Which encoder is legal for which container (mirrors lib/formats.js).
  const CODECS_BY_CONTAINER = {
    mp4: ['libx264', 'libx265', 'h264_nvenc', 'hevc_nvenc'],
    mov: ['libx264', 'libx265', 'h264_nvenc', 'hevc_nvenc'],
    mkv: ['libx264', 'libx265', 'h264_nvenc', 'hevc_nvenc'],
    webm: ['libvpx-vp9'],
    avi: ['mpeg4'],
    wmv: ['wmv2'],
    flv: ['libx264'],
    ts: ['libx264'],
  };
  const PRESETS = ['ultrafast', 'veryfast', 'faster', 'medium', 'slow', 'slower'];
  const RESOLUTIONS = ['source', '2160', '1440', '1080', '720', '480'];
  const FPS = ['source', '60', '30', '24'];
  const BITRATES = ['128k', '192k', '256k', '320k'];

  const SHARE_PREFIX = 'CUCI-1';

  /** Translate when the renderer dictionaries are loaded, else English. */
  const msg = (key, fallback) => {
    const i18n = window.CUCI && window.CUCI.i18n;
    const value = i18n ? i18n.t(key) : '';
    return value && value !== key ? value : fallback;
  };

  /* ── primitives ──────────────────────────────────────────────── */
  function isObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  function num(v, def = 0, min = -Infinity, max = Infinity) {
    const n = Number(v);
    if (!Number.isFinite(n)) return def;
    return Math.min(max, Math.max(min, n));
  }

  function stripControl(s) {
    return String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  }

  /** General text: normalise newlines, strip control chars, cap length. */
  function text(v, max) {
    return stripControl(String(v == null ? '' : v).replace(/\r\n?/g, '\n')).slice(0, max);
  }

  /** Single-line text (names): also collapse newlines. */
  function oneLine(v, max) {
    return text(v, max).replace(/\n+/g, ' ').trim();
  }

  /**
   * Subtitle text. Blank lines are collapsed so a value can never terminate an
   * SRT block and inject extra cues when the synced .srt is written or burned.
   */
  function sanitizeSubtitleText(v, max = LIMITS.textChars) {
    return text(v, max)
      .replace(/\n{2,}/g, '\n')
      // A literal '-->' inside body text could be mistaken for a timestamp line
      // by subtitle parsers and inject extra cues into an exported .srt.
      .replace(/-->/g, '\u2192')
      .trim();
  }

  /** JSON.parse that refuses prototype-polluting keys. */
  function safeJsonParse(str) {
    return JSON.parse(str, (key, value) =>
      key === '__proto__' || key === 'constructor' || key === 'prototype' ? undefined : value,
    );
  }

  /* ── share-code transport ────────────────────────────────────── */
  function bytesToBase64url(bytes) {
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function base64urlToBytes(str) {
    let s = str.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function deflateRawBytes(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /** Inflate with a hard output cap so a crafted code cannot exhaust memory. */
  async function inflateRawBytes(bytes, maxBytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const reader = stream.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        throw new Error(msg('errShareExpands', 'Share code expands to too much data.'));
      }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }

  /* ── compact schema ──────────────────────────────────────────── */
  function toCompact(job) {
    const e = job.export || {};
    return {
      a: 'CUCI',
      v: job.version || 1,
      t: job.created,
      D: job.description || undefined,
      o: job.subOffsetMs || undefined,
      e: job.export
        ? [e.container, e.videoCodec, e.crf, e.preset, e.resolution, e.fps, e.audioBitrate, e.burnSubtitles ? 1 : 0, e.writeSrt === false ? 0 : 1]
        : undefined,
      c: job.clips.map((c) => {
        const o = { n: c.name, z: c.size || undefined, d: c.durationMs, f: c.fps, w: c.width, h: c.height, A: c.hasAudio ? 1 : 0, x: c.deletes };
        const tracks = (c.subtitles || []).filter((t) => t.events && t.events.length);
        if (tracks.length === 1) {
          // Legacy-compatible single-track shape.
          o.u = { n: tracks[0].name, f: tracks[0].format, v: tracks[0].events };
        } else if (tracks.length > 1) {
          o.u = tracks.map((t) => ({ n: t.name, f: t.format, v: t.events }));
        }
        return o;
      }),
    };
  }

  function fromCompact(k) {
    if (!isObject(k)) throw new Error(msg('errShareFormat', 'Share code has an unexpected format.'));
    // 'CUCI2' is the pre-rename app id — old share codes still decode.
    if (!['CUCI', 'CUCI2'].includes(k.a) && !['CUCI', 'CUCI2'].includes(k.app)) throw new Error(msg('errShareFormat', 'Share code has an unexpected format.'));
    if (Array.isArray(k.clips)) return k; // already the verbose form

    const e = Array.isArray(k.e) ? k.e : null;
    return {
      app: 'CUCI',
      kind: 'delete-job',
      version: k.v,
      created: k.t,
      description: k.D != null ? k.D : k.description,
      subOffsetMs: k.o,
      export: e
        ? {
            container: e[0],
            videoCodec: e[1],
            crf: e[2],
            preset: e[3],
            resolution: e[4],
            fps: e[5],
            audioBitrate: e[6],
            burnSubtitles: !!e[7],
            writeSrt: e[8] !== 0,
          }
        : undefined,
      clips: (Array.isArray(k.c) ? k.c : []).map((c) => {
        if (!isObject(c)) return null;
        return {
          name: c.n,
          size: c.z,
          durationMs: c.d,
          fps: c.f,
          width: c.w,
          height: c.h,
          hasAudio: !!c.A,
          deletes: c.x,
          subtitles: Array.isArray(c.u)
          ? c.u.filter(isObject).map((u) => ({ name: u.n, format: u.f, events: u.v }))
          : isObject(c.u)
            ? [{ name: c.u.n, format: c.u.f, events: c.u.v }]
            : [],
        };
      }).filter(Boolean),
    };
  }

  /* ── validation ──────────────────────────────────────────────── */
  function sanitizeExport(e) {
    if (!isObject(e)) return undefined;
    const pick = (v, list, def) => (list.includes(String(v)) ? String(v) : def);
    const container = pick(e.container, CONTAINERS, 'mp4');
    const codecs = CODECS_BY_CONTAINER[container] || CODECS_BY_CONTAINER.mp4;
    return {
      container,
      videoCodec: pick(e.videoCodec, codecs, codecs[0]),
      crf: Math.round(num(e.crf, 20, 0, 51)),
      preset: pick(e.preset, PRESETS, 'medium'),
      resolution: pick(e.resolution, RESOLUTIONS, 'source'),
      fps: pick(e.fps, FPS, 'source'),
      audioBitrate: pick(e.audioBitrate, BITRATES, '192k'),
      burnSubtitles: e.burnSubtitles === true,
      writeSrt: e.writeSrt !== false,
    };
  }

  /**
   * Turn untrusted input into a job the app can safely act on.
   * Throws on anything that is not structurally a CUCI job; otherwise returns
   * a fresh object containing only known, validated fields.
   */
  function sanitizeJob(raw) {
    if (!isObject(raw)) throw new Error(msg('errNotCuciJob', 'Not a CUCI job.'));
    // Accept the pre-rename 'CUCI2' id so old job files keep working.
    if (raw.app !== 'CUCI' && raw.app !== 'CUCI2') throw new Error(msg('errNotCuciJob', 'Not a CUCI job.'));
    if (!Array.isArray(raw.clips)) throw new Error(msg('errJobNoClips', 'Job has no clips.'));

    let deleteTotal = 0;
    let eventTotal = 0;
    const clips = [];

    for (const c of raw.clips.slice(0, LIMITS.clips)) {
      if (!isObject(c)) continue;

      // deletes: arrays of [start, end] in ms; the pre-rename `cuts` key is still accepted
      const deletes = [];
      const rawDeletes = Array.isArray(c.deletes) ? c.deletes : Array.isArray(c.cuts) ? c.cuts : [];
      if (rawDeletes.length) {
        for (const pair of rawDeletes.slice(0, LIMITS.deletesPerClip)) {
          if (!Array.isArray(pair) || pair.length < 2) continue;
          const s = num(pair[0], NaN, 0, LIMITS.ms);
          const e = num(pair[1], NaN, 0, LIMITS.ms);
          if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue;
          deletes.push([Math.round(s * 1000) / 1000, Math.round(e * 1000) / 1000]);
        }
      }
      if (deleteTotal + deletes.length > LIMITS.totalDeletes) deletes.length = Math.max(0, LIMITS.totalDeletes - deleteTotal);
      deleteTotal += deletes.length;

      // subtitles: plural array; the legacy singular `subtitle` is still accepted
      const rawTracks = Array.isArray(c.subtitles) ? c.subtitles : isObject(c.subtitle) ? [c.subtitle] : [];
      const subtitles = [];
      for (const t of rawTracks.slice(0, LIMITS.subtitlesPerClip)) {
        if (!isObject(t) || !Array.isArray(t.events)) continue;
        const events = [];
        for (const ev of t.events.slice(0, LIMITS.subtitleEventsPerClip)) {
          if (!Array.isArray(ev) || ev.length < 2) continue;
          const s = num(ev[0], NaN, 0, LIMITS.ms);
          const e = num(ev[1], NaN, 0, LIMITS.ms);
          const body = sanitizeSubtitleText(ev[2]);
          if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s || !body) continue;
          events.push([Math.round(s * 1000) / 1000, Math.round(e * 1000) / 1000, body]);
        }
        if (eventTotal + events.length > LIMITS.totalSubtitleEvents) {
          events.length = Math.max(0, LIMITS.totalSubtitleEvents - eventTotal);
        }
        eventTotal += events.length;
        if (events.length) {
          subtitles.push({
            name: oneLine(t.name, LIMITS.nameChars) || 'subtitles',
            format: t.format === 'vtt' ? 'vtt' : 'srt',
            events,
          });
        }
      }

      clips.push({
        name: oneLine(c.name, LIMITS.nameChars),
        size: Math.round(num(c.size, 0, 0, Number.MAX_SAFE_INTEGER)),
        durationMs: Math.round(num(c.durationMs, 0, 0, LIMITS.ms)),
        fps: num(c.fps, 0, 0, 1000),
        width: Math.round(num(c.width, 0, 0, 100_000)),
        height: Math.round(num(c.height, 0, 0, 100_000)),
        hasAudio: c.hasAudio === true,
        deletes,
        subtitles,
      });
    }

    if (!clips.length) throw new Error(msg('errJobNoValidClips', 'Job contains no valid clips.'));

    return {
      app: 'CUCI',
      kind: 'delete-job',
      version: Math.round(num(raw.version, 1, 0, 1000)),
      created: text(raw.created, 64),
      description: text(raw.description, LIMITS.descriptionChars),
      subOffsetMs: Math.round(num(raw.subOffsetMs, 0, -LIMITS.ms, LIMITS.ms)),
      export: sanitizeExport(raw.export),
      clips,
    };
  }

  /* ── public API ──────────────────────────────────────────────── */
  /** job -> compact, paste-friendly code: CUCI-1z.<base64url(deflate(json))> */
  C.encodeShareCode = async function (rawJob) {
    const job = sanitizeJob(rawJob);
    const raw = new TextEncoder().encode(JSON.stringify(toCompact(job)));
    try {
      return `${SHARE_PREFIX}z.${bytesToBase64url(await deflateRawBytes(raw))}`;
    } catch {
      return `${SHARE_PREFIX}p.${bytesToBase64url(raw)}`;
    }
  };

  C.decodeShareCode = async function (text) {
    const code = String(text == null ? '' : text).trim().replace(/\s+/g, '');
    if (!code) throw new Error(msg('errShareEmpty', 'Empty share code.'));
    if (code.length > LIMITS.codeChars) throw new Error(msg('errShareTooLong', 'Share code is too long.'));

    // New codes are CUCI-1…; CUCI2-1… is the legacy prefix.
    const m = /^(?:CUCI|CUCI2)-1([zp])\.([A-Za-z0-9_-]+)$/.exec(code);
    if (!m) throw new Error(msg('errNotShareCode', 'This does not look like a CUCI share code.'));

    const bytes = base64urlToBytes(m[2]);
    if (bytes.length > LIMITS.compressedBytes) throw new Error(msg('errShareTooLarge', 'Share code is too large.'));

    const raw = m[1] === 'z' ? await inflateRawBytes(bytes, LIMITS.jsonBytes) : bytes;
    if (raw.length > LIMITS.jsonBytes) throw new Error(msg('errShareTooLarge', 'Share code is too large.'));

    const parsed = safeJsonParse(new TextDecoder().decode(raw));
    return sanitizeJob(fromCompact(parsed));
  };

  /** Accept either a JSON job file body or a share code. Always sanitized. */
  C.parseJobText = async function (input) {
    const raw = String(input == null ? '' : input).replace(/^\uFEFF/, '').trim();
    if (!raw) throw new Error(msg('errJobEmpty', 'Empty job.'));
    if (raw.startsWith('{')) {
      if (raw.length > LIMITS.jsonBytes) throw new Error(msg('errJobFileTooLarge', 'Job file is too large.'));
      return sanitizeJob(safeJsonParse(raw));
    }
    return C.decodeShareCode(raw);
  };

  C.sanitizeJob = sanitizeJob;
  C.sanitizeSubtitleText = sanitizeSubtitleText;
  C.safeJsonParse = safeJsonParse;
  C.JOB_LIMITS = LIMITS;
})();
