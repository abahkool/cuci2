'use strict';

/**
 * A seekable `media://` protocol handler.
 *
 * Chromium only allows seeking inside a media resource when the server
 * advertises `Accept-Ranges: bytes` and answers `Range:` requests with `206
 * Partial Content`. net.fetch() on a file:// URL does not do this, which made
 * the <video> element effectively unseekable. This handler implements ranges
 * directly so scrubbing / frame stepping works.
 */

const { protocol } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');

const MEDIA_SCHEME = 'media';

const MEDIA_PRIVILEGES = [
  {
    scheme: MEDIA_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      bypassCSP: true,
    },
  },
];

const MIME = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.ts': 'video/mp2t',
  '.m2ts': 'video/mp2t',
  '.ogv': 'video/ogg',
  '.flv': 'video/x-flv',
  '.wmv': 'video/x-ms-wmv',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.srt': 'text/plain; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8',
};

function mimeFor(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function filePathFromUrl(requestUrl) {
  // media://local/<encodeURIComponent(absolutePath)>
  const url = new URL(requestUrl);
  return decodeURIComponent(url.pathname.replace(/^\//, ''));
}

function handleMediaRequest(request) {
  let filePath;
  try {
    filePath = filePathFromUrl(request.url);
  } catch {
    return new Response('Bad request', { status: 400 });
  }

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return new Response('Not found', { status: 404 });
  }
  if (!stat.isFile()) return new Response('Not a file', { status: 404 });

  const total = stat.size;
  const headers = new Headers({
    'Content-Type': mimeFor(filePath),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
  });

  const rangeHeader = request.headers.get('range') || request.headers.get('Range');
  const match = rangeHeader && /bytes=(\d*)-(\d*)/.exec(rangeHeader);

  if (match) {
    let start = match[1] === '' ? NaN : parseInt(match[1], 10);
    let end = match[2] === '' ? NaN : parseInt(match[2], 10);

    // suffix range: "bytes=-500" -> last 500 bytes
    if (Number.isNaN(start) && !Number.isNaN(end)) {
      start = Math.max(0, total - end);
      end = total - 1;
    }
    if (Number.isNaN(start)) start = 0;
    if (Number.isNaN(end) || end >= total) end = total - 1;

    if (start >= total || start > end) {
      headers.set('Content-Range', `bytes */${total}`);
      return new Response(null, { status: 416, headers });
    }

    headers.set('Content-Range', `bytes ${start}-${end}/${total}`);
    headers.set('Content-Length', String(end - start + 1));
    const stream = fs.createReadStream(filePath, { start, end });
    return new Response(Readable.toWeb(stream), { status: 206, headers });
  }

  headers.set('Content-Length', String(total));
  const stream = fs.createReadStream(filePath);
  return new Response(Readable.toWeb(stream), { status: 200, headers });
}

function registerMediaProtocol() {
  protocol.handle(MEDIA_SCHEME, handleMediaRequest);
}

module.exports = { MEDIA_SCHEME, MEDIA_PRIVILEGES, registerMediaProtocol, mimeFor };
