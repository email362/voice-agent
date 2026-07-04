const assert = require('node:assert/strict');
const fs = require('node:fs');

(async () => {
  const rvc = require('../rvc-audio');
  assert.equal(typeof rvc.pcm16ToWav, 'function', 'rvc-audio should export pcm16ToWav');
  assert.equal(typeof rvc.convertPcmWithRvc, 'function', 'rvc-audio should export convertPcmWithRvc');

  const pcm = Buffer.from([0, 0, 255, 127, 0, 128]);
  const wav = rvc.pcm16ToWav(pcm, { sampleRate: 24000, channels: 1, bitsPerSample: 16 });
  assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(wav.subarray(8, 12).toString('ascii'), 'WAVE');
  assert.equal(wav.readUInt32LE(24), 24000);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.deepEqual(wav.subarray(44), pcm);

  const converted = Buffer.from('RIFFconvertedWAVE');
  let sawFetch = false;
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    sawFetch = true;
    assert.equal(url, 'http://127.0.0.1:5055/convert?pitch=0&index_rate=0.5&f0_method=rmvpe');
    assert.equal(options.method, 'POST');
    assert.ok(options.body, 'convert request should include multipart body');
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => converted.buffer.slice(converted.byteOffset, converted.byteOffset + converted.byteLength),
    };
  };
  const result = await rvc.convertPcmWithRvc(pcm, { serviceUrl: 'http://127.0.0.1:5055' });
  global.fetch = originalFetch;
  assert.equal(sawFetch, true);
  assert.deepEqual(result, converted);

  const app = fs.readFileSync('public/app.js', 'utf8');
  assert.match(app, /function isWavAudio\(/, 'browser should detect WAV payloads');
  assert.match(app, /decodeAudioData/, 'browser should decode WAV payloads');
  assert.match(app, /playAudio\(message\.data\)/, 'message handler should route binary audio through format-aware playback');

  const server = fs.readFileSync('server.js', 'utf8');
  assert.match(server, /RVC_SERVICE_URL/, 'server should read RVC_SERVICE_URL');
  assert.match(server, /AgentAudioDone/, 'server should flush buffered assistant audio on AgentAudioDone');
  assert.match(server, /convertPcmWithRvc/, 'server should call RVC conversion helper');

  console.log('rvc integration checks passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
