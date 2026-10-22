/* Subtitle parsing, serialising and remapping (classic script -> window.CUCI) */
(function () {
  const C = (window.CUCI = window.CUCI || {});

  const TIME_RE =
    /(\d{1,3}):(\d{2}):(\d{2})[.,](\d{1,3})\s*-->\s*(\d{1,3}):(\d{2}):(\d{2})[.,](\d{1,3})/;

  function toMs(h, m, s, ms) {
    return Number(h) * 3600000 + Number(m) * 60000 + Number(s) * 1000 + Number(String(ms).padEnd(3, '0').slice(0, 3));
  }

  C.parseSubtitles = function (text) {
    const raw = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    const isVtt = /^\s*WEBVTT/i.test(raw);
    const lines = raw.split('\n');
    const events = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const m = TIME_RE.exec(line);
      if (m) {
        const start = toMs(m[1], m[2], m[3], m[4]);
        const end = toMs(m[5], m[6], m[7], m[8]);
        const textLines = [];
        i++;
        while (i < lines.length && lines[i].trim() !== '') {
          const l = lines[i];
          if (TIME_RE.test(l)) break;
          if (!/^\d+$/.test(l.trim()) || textLines.length > 0) textLines.push(l);
          i++;
        }
        const body = textLines
          .join('\n')
          .replace(/<[^>]+>/g, '')
          .trim();
        if (body) events.push({ start, end, text: body });
      } else {
        i++;
      }
    }
    events.sort((a, b) => a.start - b.start || a.end - b.end);
    return { format: isVtt ? 'vtt' : 'srt', events };
  };

  const pad = (n, w = 2) => String(n).padStart(w, '0');

  C.formatTimestamp = function (ms, sep = ',') {
    ms = Math.max(0, Math.round(ms));
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const mil = ms % 1000;
    return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(mil, 3)}`;
  };

  /**
   * Subtitle text must never be able to terminate a cue: strip control chars and
   * collapse blank lines so a crafted value cannot inject extra SRT/VTT blocks.
   */
  function cleanBody(v) {
    return String(v == null ? '' : v)
      .replace(/\r\n?/g, '\n')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .replace(/\n{2,}/g, '\n')
      .replace(/-->/g, '\u2192')
      .trim();
  }
  C.cleanSubtitleBody = cleanBody;

  C.serializeSrt = function (events) {
    return (
      events
        .map((ev, idx) => {
          const start = Math.max(0, Math.round(ev.start));
          const end = Math.max(start + 1, Math.round(ev.end));
          const body = cleanBody(ev.text);
          if (!body) return null;
          return `${idx + 1}\n${C.formatTimestamp(start, ',')} --> ${C.formatTimestamp(end, ',')}\n${body}\n`;
        })
        .filter(Boolean)
        .join('\n') + '\n'
    );
  };

  C.serializeVtt = function (events) {
    let out = 'WEBVTT\n\n';
    for (const ev of events) {
      const body = cleanBody(ev.text);
      if (!body) continue;
      out += `${C.formatTimestamp(Math.max(0, ev.start), '.')} --> ${C.formatTimestamp(Math.max(0, ev.end), '.')}\n${body}\n\n`;
    }
    return out;
  };

  /**
   * Output start time of every kept range once earlier ranges have been joined.
   * ranges: [{start,end}] in source ms -> [outStart0, outStart1, ...]
   */
  C.rangeOutputOffsets = function (ranges) {
    const out = [];
    let acc = 0;
    for (const r of ranges) {
      out.push(acc);
      acc += Math.max(0, r.end - r.start);
    }
    return out;
  };

  /**
   * Map subtitle events from source time to output time.
   * @param {Array} events  events with {start,end,text} in source ms
   * @param {Array} ranges  kept ranges [{start,end}] in source ms (ordered)
   * @param {number} baseOffset  output offset for this clip's first kept frame
   * @param {number} globalOffset  manual sync offset in ms
   */
  C.remapEvents = function (events, ranges, baseOffset = 0, globalOffset = 0) {
    const out = [];
    const rangeOffsets = C.rangeOutputOffsets(ranges);
    for (const ev of events) {
      for (let i = 0; i < ranges.length; i++) {
        const r = ranges[i];
        const s = Math.max(ev.start, r.start);
        const e = Math.min(ev.end, r.end);
        if (e - s <= 0) continue;
        const start = baseOffset + rangeOffsets[i] + (s - r.start) + globalOffset;
        const end = baseOffset + rangeOffsets[i] + (e - r.start) + globalOffset;
        out.push({
          start,
          end,
          text: ev.text,
          srcStart: s,
          srcEnd: e,
          clipped: s > ev.start + 0.5 || e < ev.end - 0.5,
          dropped: false,
        });
      }
    }
    out.sort((a, b) => a.start - b.start || a.end - b.end);
    return out;
  };

  /** Subtitle events that fall entirely inside removed regions. */
  C.droppedEvents = function (events, ranges) {
    const dropped = [];
    for (const ev of events) {
      let keptAnywhere = false;
      for (const r of ranges) {
        if (Math.min(ev.end, r.end) - Math.max(ev.start, r.start) > 0) {
          keptAnywhere = true;
          break;
        }
      }
      if (!keptAnywhere) dropped.push(ev);
    }
    return dropped;
  };
})();
