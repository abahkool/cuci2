'use strict';

const { formatFor } = require('./formats');

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

/** Map the CRF-style 12..34 quality slider onto the 2..12 qscale range used
 *  by MPEG-4 part 2 / WMV2 (lower is better). */
function qscaleFromCrf(crf) {
  const q = Math.round(2 + ((Number(crf) || 20) - 12) * (10 / 22));
  return String(Math.max(2, Math.min(12, q)));
}

/** Encoder-side output arguments (codec, quality, audio) for a container. */
function buildEncoderArgs(req) {
  const fmt = formatFor(req.container);
  const args = [];
  const crf = Number(req.crf ?? 20);
  // Never pair a container with an encoder it cannot mux.
  const codec = fmt.video.includes(req.videoCodec) ? req.videoCodec : fmt.defaultVideo;
  args.push('-c:v', codec);
  if (codec === 'h264_nvenc' || codec === 'hevc_nvenc') {
    args.push('-preset', req.nvencPreset || 'p5', '-cq', String(crf), '-rc', 'vbr', '-b:v', '0');
  } else if (codec === 'libx265') {
    args.push('-preset', req.preset || 'medium', '-crf', String(crf), '-tag:v', 'hvc1');
  } else if (codec === 'libvpx-vp9') {
    // VP9 CRF mode needs -b:v 0; row-mt keeps multi-core encoding usable.
    args.push('-crf', String(crf), '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '3');
  } else if (codec === 'mpeg4' || codec === 'wmv2') {
    args.push('-q:v', qscaleFromCrf(crf));
  } else {
    args.push('-preset', req.preset || 'medium', '-crf', String(crf));
  }
  args.push('-pix_fmt', 'yuv420p');
  args.push('-c:a', fmt.audio, '-b:a', req.audioBitrate || '192k', '-ar', String(fmt.audioRate), '-ac', '2');
  return args;
}

module.exports = { even, parseRate, escapeFilterPath, buildFilterGraph, buildEncoderArgs, qscaleFromCrf };
