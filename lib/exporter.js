'use strict';

/** Round up to the nearest even integer (H.264 requires even dimensions). */
function even(n) {
  const v = Math.round(Number(n) || 0);
  return v % 2 === 0 ? v : v + 1;
}

/** Parse an ffprobe rational frame-rate string ("30000/1001") into a number. */
function parseRate(rate) {
  if (!rate) return 0;
  const [a, b] = String(rate).split('/').map(Number);
  if (!b) return a || 0;
  return a / b;
}

/** Escape a path for use inside an ffmpeg filtergraph (subtitles=filename=...). */
function escapeFilterPath(p) {
  return String(p)
    .replace(/\\/g, '/')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

/**
 * Build a concat/normalise filtergraph that stitches the kept segments of one
 * or more source files into a single stream, optionally burning subtitles.
 */
function buildFilterGraph(req, uniquePaths, pathIndex) {
  const W = even(req.width);
  const H = even(req.height);
  const FPS = Number(req.fps) || 25;
  const vnorm = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${FPS.toFixed(6)},format=yuv420p`;
  const anorm = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo';
  const silenceIndex = uniquePaths.length;
  const parts = [];
  const pairs = [];

  req.segments.forEach((seg, i) => {
    const idx = pathIndex.get(seg.path);
    const st = (seg.start / 1000).toFixed(3);
    const en = (seg.end / 1000).toFixed(3);
    parts.push(`[${idx}:v]trim=start=${st}:end=${en},setpts=PTS-STARTPTS,${vnorm}[v${i}]`);
    if (seg.hasAudio) {
      parts.push(`[${idx}:a]atrim=start=${st}:end=${en},asetpts=PTS-STARTPTS,${anorm}[a${i}]`);
    } else {
      const dur = ((seg.end - seg.start) / 1000).toFixed(3);
      parts.push(`[${silenceIndex}:a]atrim=start=0:end=${dur},asetpts=PTS-STARTPTS,${anorm}[a${i}]`);
    }
    pairs.push(`[v${i}][a${i}]`);
  });

  parts.push(`${pairs.join('')}concat=n=${req.segments.length}:v=1:a=1[vc][ac]`);
  let vlabel = '[vc]';
  const alabel = '[ac]';
  if (req.burnSubtitles && req.subtitleSrtPath) {
    parts.push(`[vc]subtitles='${escapeFilterPath(req.subtitleSrtPath)}'[vb]`);
    vlabel = '[vb]';
  }
  return { graph: parts.join(';'), vlabel, alabel };
}

/** Encoder-side output arguments (codec, quality, audio). */
function buildEncoderArgs(req) {
  const args = [];
  const codec = req.videoCodec || 'libx264';
  args.push('-c:v', codec);
  if (codec === 'h264_nvenc' || codec === 'hevc_nvenc') {
    args.push('-preset', req.nvencPreset || 'p5', '-cq', String(req.crf ?? 20), '-rc', 'vbr', '-b:v', '0');
  } else if (codec === 'libx265') {
    args.push('-preset', req.preset || 'medium', '-crf', String(req.crf ?? 20), '-tag:v', 'hvc1');
  } else {
    args.push('-preset', req.preset || 'medium', '-crf', String(req.crf ?? 20));
  }
  args.push('-pix_fmt', 'yuv420p');
  args.push('-c:a', 'aac', '-b:a', req.audioBitrate || '192k', '-ar', '48000', '-ac', '2');
  return args;
}

module.exports = { even, parseRate, escapeFilterPath, buildFilterGraph, buildEncoderArgs };
