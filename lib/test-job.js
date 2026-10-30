'use strict';

/**
 * Delete-job trust-boundary tests.
 *
 *   node lib/test-job.js
 *
 * Job files, share codes and clipboard payloads are untrusted. These tests
 * prove the loader caps sizes, resists zip bombs and prototype pollution,
 * clamps numbers, whitelists enums, and neutralises subtitle text that could
 * otherwise inject extra cues into an exported .srt.
 */

const assert = require('node:assert');
const path = require('node:path');

global.window = {};
require(path.join(__dirname, '..', 'src', 'util.js'));
require(path.join(__dirname, '..', 'src', 'srt.js'));
require(path.join(__dirname, '..', 'src', 'job.js'));
const CU = global.window.CUCI;
const LIMITS = CU.JOB_LIMITS;

/* ── helpers: craft share codes by hand ───────────────────────── */
function b64url(u8) {
  let bin = '';
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function deflateRaw(u8) {
  const s = new Blob([u8]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
async function makeCode(text, mode = 'z') {
  const raw = new TextEncoder().encode(text);
  if (mode === 'p') return 'CUCI-1p.' + b64url(raw);
  return 'CUCI-1z.' + b64url(await deflateRaw(raw));
}

function baseJob() {
  return {
    app: 'CUCI',
    kind: 'delete-job',
    version: 1,
    created: new Date().toISOString(),
    description: 'Remove intro',
    subOffsetMs: -250,
    export: {
      container: 'mp4',
      videoCodec: 'libx264',
      crf: 20,
      preset: 'medium',
      resolution: 'source',
      fps: 'source',
      audioBitrate: '192k',
      burnSubtitles: false,
      writeSrt: true,
    },
    clips: [
      {
        name: 'source.mp4',
        size: 123,
        durationMs: 60000,
        fps: 30,
        width: 1920,
        height: 1080,
        hasAudio: true,
        deletes: [[1000, 2000]],
        subtitles: [{ name: 's.srt', format: 'srt', events: [[0, 900, 'Hello']] }],
      },
    ],
  };
}

(async () => {
  /* 1. normal round-trip ------------------------------------------------ */
  {
    const code = await CU.encodeShareCode(baseJob());
    const job = await CU.decodeShareCode(code);
    assert.strictEqual(job.app, 'CUCI');
    assert.strictEqual(job.description, 'Remove intro');
    assert.deepStrictEqual(job.clips[0].deletes, [[1000, 2000]]);
    assert.deepStrictEqual(job.clips[0].subtitles[0].events, [[0, 900, 'Hello']]);
    assert.strictEqual(job.subOffsetMs, -250);
    assert.strictEqual(job.export.container, 'mp4');
    console.log('round-trip     : PASS ✅');
  }

  /* 2b. legacy singular `subtitle` is still accepted ------------------- */
  {
    const legacy = baseJob();
    legacy.clips[0].subtitle = legacy.clips[0].subtitles[0];
    delete legacy.clips[0].subtitles;
    const j = CU.sanitizeJob(legacy);
    assert.strictEqual(j.clips[0].subtitles.length, 1);
    assert.strictEqual(j.clips[0].subtitles[0].name, 's.srt');
    console.log('legacy singular: PASS ✅');
  }

  /* 2b2. pre-rename `cuts` / `cut-job` still import ------------------- */
  {
    const legacy = baseJob();
    const c = legacy.clips[0];
    c.cuts = c.deletes;
    delete c.deletes;
    legacy.kind = 'cut-job';
    const j = CU.sanitizeJob(legacy);
    assert.deepStrictEqual(j.clips[0].deletes, [[1000, 2000]], 'legacy cuts key maps to deletes');
    assert.strictEqual(j.kind, 'delete-job', 'output always uses the new kind');
    console.log('legacy cuts    : PASS ✅');
  }

  /* 2c. multiple subtitle tracks --------------------------------------- */
  {
    const job = baseJob();
    job.clips[0].subtitles = [
      { name: 'en.srt', format: 'srt', events: [[0, 900, 'Hello']] },
      { name: 'id.srt', format: 'srt', events: [[0, 900, 'Halo'], [1000, 1800, 'Dunia']] },
    ];
    const code = await CU.encodeShareCode(job);
    const back = await CU.decodeShareCode(code);
    assert.strictEqual(back.clips[0].subtitles.length, 2, 'both tracks survive the share code');
    assert.strictEqual(back.clips[0].subtitles[1].name, 'id.srt');
    assert.strictEqual(back.clips[0].subtitles[1].events.length, 2);

    const tooMany = baseJob();
    tooMany.clips[0].subtitles = Array.from({ length: LIMITS.subtitlesPerClip + 5 }, (_, i) => ({
      name: 't' + i + '.srt',
      format: 'srt',
      events: [[0, 10, 'x']],
    }));
    assert.strictEqual(CU.sanitizeJob(tooMany).clips[0].subtitles.length, LIMITS.subtitlesPerClip);
    console.log('multi-track    : PASS ✅');
  }

  /* 1b. legacy CUCI2 share code + non-default export format ------------ */
  {
    const legacy = 'CUCI2-1p.' + b64url(new TextEncoder().encode(JSON.stringify(baseJob())));
    const job = await CU.decodeShareCode(legacy);
    assert.strictEqual(job.description, 'Remove intro');
    assert.strictEqual(job.export.container, 'mp4');

    const webm = baseJob();
    webm.export.container = 'webm';
    webm.export.videoCodec = 'libvpx-vp9';
    const back = CU.sanitizeJob(webm);
    assert.strictEqual(back.export.container, 'webm');
    assert.strictEqual(back.export.videoCodec, 'libvpx-vp9');

    const mismatch = baseJob();
    mismatch.export.container = 'webm';
    mismatch.export.videoCodec = 'libx264';
    assert.strictEqual(CU.sanitizeJob(mismatch).export.videoCodec, 'libvpx-vp9', 'codec must fit the container');
    console.log('legacy prefix  : PASS ✅');
    console.log('export format  : PASS ✅');
  }

  /* 2. JSON file body + plain share code -------------------------------- */
  {
    const fromJson = await CU.parseJobText(JSON.stringify(baseJob()));
    assert.strictEqual(fromJson.clips[0].name, 'source.mp4');
    const fromPlain = await CU.decodeShareCode(await makeCode(JSON.stringify(baseJob()), 'p'));
    assert.strictEqual(fromPlain.description, 'Remove intro');
    console.log('json + plain   : PASS ✅');
  }

  /* 3. prototype pollution --------------------------------------------- */
  {
    const poison = '{"app":"CUCI2","clips":[{"name":"a.mp4","deletes":[]}],"__proto__":{"pwned":true},"constructor":{"prototype":{"pwned2":true}}}';
    const job = await CU.parseJobText(poison);
    assert.strictEqual(job.app, 'CUCI');
    assert.strictEqual({}.pwned, undefined, 'Object.prototype must not be polluted');
    assert.strictEqual({}.pwned2, undefined);
    await CU.decodeShareCode(await makeCode(poison));
    assert.strictEqual({}.pwned, undefined, 'share-code path must not pollute either');
    console.log('proto pollution: PASS ✅');
  }

  /* 4. oversized code --------------------------------------------------- */
  {
    await assert.rejects(
      () => CU.decodeShareCode('CUCI2-1z.' + 'A'.repeat(LIMITS.codeChars + 16)),
      /too long/,
      'oversized code must be rejected',
    );
    const hugePlain = await makeCode(JSON.stringify({ app: 'CUCI2', clips: [] }) + 'x'.repeat(LIMITS.compressedBytes + 10), 'p');
    await assert.rejects(() => CU.decodeShareCode(hugePlain), /too large|too long/);
    console.log('size limits    : PASS ✅');
  }

  /* 5. zip bomb --------------------------------------------------------- */
  {
    const bomb = JSON.stringify({ app: 'CUCI2', clips: [{ name: 'a.mp4', deletes: [] }], pad: 'A'.repeat(LIMITS.jsonBytes + 1024 * 1024) });
    const code = await makeCode(bomb);
    assert.ok(code.length < LIMITS.codeChars, 'bomb code itself stays small');
    await assert.rejects(() => CU.decodeShareCode(code), /too much data|too large/);
    console.log('zip bomb       : PASS ✅');
  }

  /* 6. array caps ------------------------------------------------------- */
  {
    const manyDeletes = baseJob();
    manyDeletes.clips[0].deletes = Array.from({ length: LIMITS.deletesPerClip + 1000 }, (_, i) => [i * 10, i * 10 + 5]);
    assert.strictEqual(CU.sanitizeJob(manyDeletes).clips[0].deletes.length, LIMITS.deletesPerClip);

    const manyClips = baseJob();
    manyClips.clips = Array.from({ length: LIMITS.clips + 100 }, (_, i) => ({ name: 'c' + i + '.mp4', deletes: [] }));
    assert.strictEqual(CU.sanitizeJob(manyClips).clips.length, LIMITS.clips);

    const manyEvents = baseJob();
    manyEvents.clips[0].subtitles[0].events = Array.from({ length: LIMITS.subtitleEventsPerClip + 1000 }, (_, i) => [i * 10, i * 10 + 5, 'x']);
    assert.strictEqual(CU.sanitizeJob(manyEvents).clips[0].subtitles[0].events.length, LIMITS.subtitleEventsPerClip);
    console.log('array caps     : PASS ✅');
  }

  /* 7. numeric clamps and invalid values -------------------------------- */
  {
    const bad = baseJob();
    bad.clips[0].deletes = [[-5, 100], [200, 100], ['x', 'y'], [0, Infinity], [null, null]];
    bad.subOffsetMs = 1e15;
    bad.clips[0].width = -999;
    const j = CU.sanitizeJob(bad);
    assert.deepStrictEqual(j.clips[0].deletes, [[0, 100]], 'only the valid, clamped delete survives');
    assert.strictEqual(j.subOffsetMs, LIMITS.ms);
    assert.strictEqual(j.clips[0].width, 0);
    console.log('numeric clamp  : PASS ✅');
  }

  /* 8. text sanitisation ------------------------------------------------ */
  {
    const j = CU.sanitizeJob({
      ...baseJob(),
      description: 'a\u0000b\u001Fc',
      clips: [{ ...baseJob().clips[0], name: 'x\ny.mp4' }],
    });
    assert.strictEqual(j.description, 'abc');
    assert.strictEqual(j.clips[0].name, 'x y.mp4', 'names are single-line');
    assert.strictEqual(CU.sanitizeJob({ ...baseJob(), description: 'A'.repeat(500) }).description.length, LIMITS.descriptionChars);
    const longText = CU.sanitizeJob({ ...baseJob(), clips: [{ ...baseJob().clips[0], subtitles: [{ name: 's', format: 'srt', events: [[0, 10, 'B'.repeat(9000)]] }] }] });
    assert.strictEqual(longText.clips[0].subtitles[0].events[0][2].length, LIMITS.textChars);
    console.log('text sanitise  : PASS ✅');
  }

  /* 9. subtitle / SRT injection ---------------------------------------- */
  {
    const evil = 'hello\n\n99\n00:00:05,000 --> 00:00:06,000\nINJECTED';
    const clean = CU.sanitizeSubtitleText(evil);
    assert.ok(!clean.includes('\n\n'), 'blank lines collapsed');
    assert.ok(!clean.includes('-->'), 'timestamp arrow neutralised');

    const srt = CU.serializeSrt([{ start: 0, end: 1000, text: evil }]);
    const parsed = CU.parseSubtitles(srt);
    assert.strictEqual(parsed.events.length, 1, 'must not become two cues');
    assert.ok(!parsed.events[0].text.includes('-->'));

    // and through the job sanitizer, then serialize/parse again
    const j = CU.sanitizeJob({ ...baseJob(), clips: [{ ...baseJob().clips[0], subtitles: [{ name: 's', format: 'srt', events: [[0, 1000, evil]] }] }] });
    const re = CU.parseSubtitles(CU.serializeSrt(j.clips[0].subtitles[0].events.map((e) => ({ start: e[0], end: e[1], text: e[2] }))));
    assert.strictEqual(re.events.length, 1);
    console.log('srt injection  : PASS ✅');
  }

  /* 10. export enum whitelist ------------------------------------------ */
  {
    const j = CU.sanitizeJob({
      ...baseJob(),
      export: { container: 'evil', videoCodec: '../../x', crf: 999, preset: 'pwn', resolution: 'x', fps: 'y', audioBitrate: 'z', burnSubtitles: 'yes', writeSrt: 0 },
    });
    assert.strictEqual(j.export.container, 'mp4');
    assert.strictEqual(j.export.videoCodec, 'libx264');
    assert.strictEqual(j.export.crf, 51);
    assert.strictEqual(j.export.preset, 'medium');
    assert.strictEqual(j.export.resolution, 'source');
    assert.strictEqual(j.export.fps, 'source');
    assert.strictEqual(j.export.audioBitrate, '192k');
    assert.strictEqual(j.export.burnSubtitles, false, 'only a real boolean enables burning');
    assert.strictEqual(j.export.writeSrt, true);
    console.log('export whitelist: PASS ✅');
  }

  /* 11. structural rejects --------------------------------------------- */
  {
    await assert.rejects(() => CU.parseJobText('{}'), /Not a CUCI job/);
    await assert.rejects(() => CU.parseJobText('{"app":"CUCI2","clips":[]}'), /no valid clips|no clips/i);
    await assert.rejects(() => CU.decodeShareCode('CUCI-1x.abc'), /does not look like/);
    await assert.rejects(() => CU.decodeShareCode('not-a-code'), /does not look like/);
    console.log('rejects        : PASS ✅');
  }

  console.log('\nJOB TEST: PASS ✅');
})().catch((err) => {
  console.error('\nJOB TEST: FAIL ❌');
  console.error(err);
  process.exit(1);
});
