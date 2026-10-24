'use strict';

/**
 * Export format presets — the single source of truth for what ffmpeg is asked
 * to mux. `src/app.js` mirrors this table (no bundler, classic scripts), so keep
 * the two lists in sync.
 *
 * video       : encoders offered in the UI for this container
 * defaultVideo: used when the requested encoder is not valid for the container
 * audio       : audio encoder that the container actually supports
 * audioRate   : preferred sample rate (WMA/MP3 are happiest at 44.1 kHz)
 * muxer       : value for `-f`
 * faststart   : add `-movflags +faststart` (mp4/mov only)
 */
const FORMATS = {
  mp4: {
    label: 'MP4',
    ext: 'mp4',
    muxer: 'mp4',
    video: ['libx264', 'h264_nvenc', 'libx265', 'hevc_nvenc'],
    defaultVideo: 'libx264',
    audio: 'aac',
    audioRate: 48000,
    faststart: true,
  },
  mov: {
    label: 'MOV',
    ext: 'mov',
    muxer: 'mov',
    video: ['libx264', 'h264_nvenc', 'libx265', 'hevc_nvenc'],
    defaultVideo: 'libx264',
    audio: 'aac',
    audioRate: 48000,
    faststart: true,
  },
  mkv: {
    label: 'MKV',
    ext: 'mkv',
    muxer: 'matroska',
    video: ['libx264', 'h264_nvenc', 'libx265', 'hevc_nvenc'],
    defaultVideo: 'libx264',
    audio: 'aac',
    audioRate: 48000,
    faststart: false,
  },
  webm: {
    label: 'WebM',
    ext: 'webm',
    muxer: 'webm',
    video: ['libvpx-vp9'],
    defaultVideo: 'libvpx-vp9',
    audio: 'libopus',
    audioRate: 48000,
    faststart: false,
  },
  avi: {
    label: 'AVI',
    ext: 'avi',
    muxer: 'avi',
    video: ['mpeg4'],
    defaultVideo: 'mpeg4',
    audio: 'libmp3lame',
    audioRate: 44100,
    faststart: false,
  },
  wmv: {
    label: 'WMV',
    ext: 'wmv',
    muxer: 'asf',
    video: ['wmv2'],
    defaultVideo: 'wmv2',
    audio: 'wmav2',
    audioRate: 44100,
    faststart: false,
  },
  flv: {
    label: 'FLV',
    ext: 'flv',
    muxer: 'flv',
    video: ['libx264'],
    defaultVideo: 'libx264',
    audio: 'aac',
    audioRate: 44100,
    faststart: false,
  },
  ts: {
    label: 'MPEG-TS',
    ext: 'ts',
    muxer: 'mpegts',
    video: ['libx264'],
    defaultVideo: 'libx264',
    audio: 'aac',
    audioRate: 48000,
    faststart: false,
  },
};

const FORMAT_NAMES = Object.keys(FORMATS);

/** Look up a format; unknown names fall back to MP4 (never trust job files). */
function formatFor(name) {
  return Object.prototype.hasOwnProperty.call(FORMATS, name) ? FORMATS[name] : FORMATS.mp4;
}

module.exports = { FORMATS, FORMAT_NAMES, formatFor };
