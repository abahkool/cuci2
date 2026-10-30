'use strict';

/**
 * End-to-end sanity check for the export pipeline.
 * Generates two sample clips (one without audio), deletes/joins them with the
 * exact filtergraph CUCI uses, and verifies the resulting duration.
 *
 *   node lib/selftest.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildFilterGraph, buildEncoderArgs } = require('./exporter');
const { FORMATS } = require('./formats');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

function sh(bin, args) {
  const r = spawnSync(bin, args, { encoding: 'utf8', windowsHide: true });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${bin} failed:\n${r.stderr}`);
  return r.stdout;
}

function durationOf(file) {
  const out = sh(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
  return Number(out.trim());
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuci-test-'));
const a = path.join(dir, 'a.mp4');
const b = path.join(dir, 'b.mp4');
const out = path.join(dir, 'joined.mp4');
const srt = path.join(dir, 'sub.srt');

console.log('temp dir :', dir);

sh(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', a]);
sh(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=24:duration=4', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-an', b]);
fs.writeFileSync(srt, '1\n00:00:00,500 --> 00:00:02,250\nDelete me maybe\n\n2\n00:00:03,000 --> 00:00:05,000\nSecond line\n');

// Keep: a[0.0-1.5] + a[3.0-5.0] + b[1.0-3.5]  → expected 1.5 + 2.0 + 2.5 = 6.0s
const segments = [
  { path: a, start: 0, end: 1500, hasAudio: true },
  { path: a, start: 3000, end: 5000, hasAudio: true },
  { path: b, start: 1000, end: 3500, hasAudio: false },
];

const uniquePaths = [];
const pathIndex = new Map();
for (const s of segments) {
  if (!pathIndex.has(s.path)) {
    pathIndex.set(s.path, uniquePaths.length);
    uniquePaths.push(s.path);
  }
}

const req = {
  width: 854,
  height: 480,
  fps: 30,
  videoCodec: 'libx264',
  crf: 28,
  preset: 'ultrafast',
  audioBitrate: '128k',
  burnSubtitles: true,
  subtitleSrtPath: srt,
  segments,
};

const { graph, vlabel, alabel } = buildFilterGraph(req, uniquePaths, pathIndex);
console.log('\nfiltergraph:\n', graph, '\n');

const args = ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-y'];
for (const p of uniquePaths) args.push('-i', p);
if (segments.some((s) => !s.hasAudio)) args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
args.push('-filter_complex', graph, '-map', vlabel, '-map', alabel);
args.push(...buildEncoderArgs(req));
args.push('-movflags', '+faststart', '-f', 'mp4', out);

sh(FFMPEG, args);

const dur = durationOf(out);
const size = fs.statSync(out).size;
const streams = sh(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_type,width,height', '-of', 'csv=p=0', out]).trim();

console.log('output duration :', dur.toFixed(3), 's  (expected ~6.000)');
console.log('output size     :', size, 'bytes');
console.log('streams         :\n' + streams);

const mp4Ok = Math.abs(dur - 6.0) < 0.35 && /video/.test(streams) && /audio/.test(streams);
console.log('mp4 format      :', mp4Ok ? 'PASS ✅' : 'FAIL ❌');

/* Every offered format must actually mux. */
console.log('\n== formats ==');
const fmtResults = [];
for (const [name, fmt] of Object.entries(FORMATS)) {
  const file = path.join(dir, 'format.' + fmt.ext);
  const r = { ...req, container: name, videoCodec: fmt.defaultVideo, burnSubtitles: false };
  const args2 = ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-y'];
  for (const p of uniquePaths) args2.push('-i', p);
  if (segments.some((s) => !s.hasAudio)) args2.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
  const g2 = buildFilterGraph(r, uniquePaths, pathIndex);
  args2.push('-filter_complex', g2.graph, '-map', g2.vlabel, '-map', g2.alabel);
  args2.push(...buildEncoderArgs(r));
  if (fmt.faststart) args2.push('-movflags', '+faststart');
  args2.push('-f', fmt.muxer, file);
  let entry = { name, ok: false };
  try {
    sh(FFMPEG, args2);
    const d = durationOf(file);
    const st = sh(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file]);
    entry = {
      name,
      ok: Math.abs(d - 6.0) < 0.35 && /video/.test(st) && /audio/.test(st),
      dur: d,
      bytes: fs.statSync(file).size,
    };
  } catch (err) {
    entry.error = String(err.message || err).split('\n').slice(-2).join(' ');
  }
  fmtResults.push(entry);
  console.log(
    `  ${name.padEnd(5)}:`,
    entry.ok ? `PASS ✅ (${entry.dur.toFixed(2)}s, ${entry.bytes} B)` : `FAIL ❌ ${entry.error || ''}`,
  );
}

const ok = mp4Ok && fmtResults.every((r) => r.ok);
console.log('\nRESULT:', ok ? 'PASS ✅' : 'FAIL ❌');
process.exit(ok ? 0 : 1);
