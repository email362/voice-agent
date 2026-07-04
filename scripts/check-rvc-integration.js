const assert = require('node:assert/strict');
const fs = require('node:fs');

(async () => {
  const rvc = require('../rvc-audio');
  assert.equal(typeof rvc.pcm16ToWav, 'function', 'rvc-audio should export pcm16ToWav');
  assert.equal(typeof rvc.convertPcmWithRvc, 'function', 'rvc-audio should export convertPcmWithRvc');
  const rvcSource = fs.readFileSync('rvc-audio.js', 'utf8');
  assert.match(rvcSource, /signal\.addEventListener\('abort', abortController, \{ once: true \}\)/, 'RVC helper should bridge caller cancellation to fetch');

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
  assert.match(app, /queuePlayback\(message\.data, playbackToken\)/, 'message handler should route binary audio through serialized, format-aware playback');

  const server = fs.readFileSync('server.js', 'utf8');
  assert.match(server, /RVC_SERVICE_URL/, 'server should read RVC_SERVICE_URL');
  assert.match(server, /process\.env\.RVC_SERVICE_URL \?\? 'http:\/\/127\.0\.0\.1:5055'/, 'server should preserve an empty RVC_SERVICE_URL to disable conversion');
  assert.match(server, /AgentAudioDone/, 'server should flush buffered assistant audio on AgentAudioDone');
  assert.match(server, /let assistantAudioFlushRunning = false;/, 'server should manage assistant audio flushes with a drain loop');
  assert.match(server, /const drainAssistantAudioFlushQueue = async \(\) => \{/, 'server should drain assistant audio flushes through an explicit queue');
  assert.match(server, /assistantAudioFlushQueue\.push\(flush\);/, 'server should queue assistant audio flush snapshots');
  assert.match(server, /void processAssistantAudioFlush\(flush\);/, 'server should start each assistant flush independently');
  assert.match(server, /convertPcmWithRvc/, 'server should call RVC conversion helper');
  assert.match(server, /signal: conversionController\.signal/, 'server should pass a cancellation signal into RVC conversion');
  assert.match(server, /abortAssistantAudioConversion\(\);/, 'server should abort in-flight conversion when audio is discarded');
  assert.match(server, /if \(conversionController\.signal\.aborted\) \{[\s\S]*finalizeAssistantAudioFlush\(flush\);[\s\S]*return;[\s\S]*\}/, 'server should release queued assistant audio when an in-flight conversion is aborted');
  assert.match(server, /rvcDisabledForSession = true;[\s\S]*finalizeAssistantAudioFlush\(flush\);/, 'server should mark the current assistant buffer for fallback when RVC fails');
  assert.match(server, /flush\.generation !== assistantAudioGeneration[\s\S]*sendOriginalAssistantAudio\(flush\.chunks\)/, 'server should skip stale fallback audio after generation changes');

  const engine = fs.readFileSync('rvc-service/app/rvc_engine.py', 'utf8');
  assert.match(engine, /await asyncio\.to_thread\(self\._initialize_backend\)/, 'RVC backend initialization should run off the event loop');
  assert.match(engine, /async with self\._backend_init_lock:/, 'RVC backend initialization should be serialized');
  assert.match(engine, /await self\._conversion_lock\.acquire\(\)/, 'RVC conversions should hold the engine lock across cancellation cleanup');
  assert.match(engine, /release_lock = True/, 'RVC conversions should track deferred lock release');
  assert.doesNotMatch(engine, /index_path = str\(self\.model_files\.index_path\) if self\.model_files\.index_path else ''/, 'RVC backend should not force an empty index path');

  const browser = fs.readFileSync('public/app.js', 'utf8');
  assert.match(browser, /let playbackGeneration = 0;/, 'browser should track playback generation');
  assert.match(browser, /decodeAudioData[\s\S]*if \(generation !== playbackGeneration\) return;[\s\S]*scheduleAudioBuffer\(decoded, generation\)/, 'browser should ignore decoded WAVs after barge-in');

  const main = fs.readFileSync('rvc-service/app/main.py', 'utf8');
  assert.match(main, /class ConvertUploadLimitMiddleware/, 'RVC convert endpoint should limit request bodies before multipart parsing');
  assert.match(main, /app\.add_middleware\(ConvertUploadLimitMiddleware, max_request_bytes=settings\.max_convert_upload_bytes \+ 1024 \* 1024\)/, 'RVC convert endpoint should apply the body limit middleware');
  assert.match(main, /if await request\.is_disconnected\(\):/, 'RVC convert endpoint should check for client disconnects before conversion');
  assert.match(main, /cancelled=disconnect_cancelled\.is_set/, 'RVC convert endpoint should pass disconnect state into conversion');
  assert.match(main, /backend_ready = bool\(engine and await engine\.ensure_ready\(\)\)/, 'RVC health should initialize the backend before reporting readiness');
  assert.match(main, /"ok": model_files is not None and backend_ready,/, 'RVC health should fail when the backend cannot be initialized');
  assert.match(main, /max_convert_upload_bytes/, 'RVC convert endpoint should still enforce an upload size cap');

  console.log('rvc integration checks passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
