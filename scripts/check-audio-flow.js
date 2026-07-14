const assert = require('node:assert/strict');
const fs = require('node:fs');

const read = (path) => fs.readFileSync(path, 'utf8');

const html = read('public/index.html');
const css = read('public/styles.css');
const app = read('public/app.js');
const server = read('server.js');

assert.match(html, /id=\"micIndicator\"/, 'index.html should render a mic status indicator');
assert.match(html, /id=\"micLabel\"/, 'index.html should render mic label text');
assert.match(css, /\.mic-indicator/, 'styles.css should style the mic indicator');
assert.match(css, /data-state=\"streaming\"/, 'styles.css should include a streaming mic state');
assert.match(app, /let canStreamMic = false;/, 'app.js should track whether mic frames may be streamed');
assert.match(app, /if \(!canStreamMic \|\| socket\?\.readyState !== WebSocket\.OPEN\) return;/, 'app.js should gate mic frames until settings apply');
assert.match(app, /event\.type === 'SettingsApplied'[\s\S]*canStreamMic = true;[\s\S]*setMicState\('live', 'Mic live'\)/, 'app.js should enable mic streaming and show Mic live after SettingsApplied');
assert.match(app, /setMicState\('streaming', `Mic streaming \(\$\{outboundAudioFrames\} frames\)`\)/, 'app.js should show Mic streaming once frames are sent');
assert.match(app, /event\.type === 'UserStartedSpeaking'[\s\S]*stopPlayback\(\)/, 'app.js should stop queued playback when Deepgram hears the user');
assert.doesNotMatch(app, /assistantPlaybackSuppressed/, 'app.js should not suppress the next assistant turn while waiting for AgentAudioDone');
assert.match(app, /try \{[\s\S]*event = JSON\.parse\(message\.data\);[\s\S]*\} catch \{[\s\S]*return;[\s\S]*\}/, 'app.js should ignore unexpected non-JSON text frames');
assert.match(app, /playbackNodes\.add\(node\)/, 'app.js should track playback nodes for cancellation');
assert.match(app, /const conversationSocket = new WebSocket\(/, 'app.js should capture the socket instance per conversation');
assert.match(app, /const isActiveSocket = \(\) => lifecycle\.isActiveGeneration\(generation\) && conversationSocket === socket;/, 'app.js should ignore stale socket events');
assert.match(app, /conversationSocket\.addEventListener\('close', \(\) => \{[\s\S]*if \(!isActiveSocket\(\)\)[\s\S]*lifecycle\.scheduleRetry\(generation\);[\s\S]*\}\);/, 'app.js should retry only active socket closures');
assert.match(app, /function recoverConnection\(generation, conversationSocket\) \{[\s\S]*canStreamMic = false;[\s\S]*stopPlayback\(\);[\s\S]*lifecycle\.scheduleRetry\(generation\);[\s\S]*\}/, 'app.js should gate mic audio and stop playback while reconnecting');
const recoveryBody = app.match(/function recoverConnection\(generation, conversationSocket\) \{([\s\S]*?)\n\}/)?.[1] || '';
assert.doesNotMatch(recoveryBody, /track\.stop\(\)|audioContext\?\.close\(\)/, 'app.js should preserve browser audio resources while reconnecting');
assert.match(app, /let browserStartupGeneration = 0;/, 'app.js should track startup generations');
assert.match(app, /if \(startupGeneration !== browserStartupGeneration\) \{[\s\S]*return;/, 'app.js should abort startup when stop is requested during mic setup');
assert.match(app, /function stopConversation\(\) \{[\s\S]*lifecycle\.stop\(\);[\s\S]*releaseBrowserResources\(\);[\s\S]*\}/, 'app.js should stop the lifecycle and release browser resources from the UI');
assert.match(app, /stopBtn\.addEventListener\('click', \(\) => stopConversation\(\)\);/, 'app.js should stop the conversation from the UI button');
assert.match(server, /const DEBUG_AUDIO = process\.env\.DEBUG_AUDIO === '1';/, 'server.js should expose opt-in audio diagnostics');
assert.match(server, /buildServiceHealth\(\{[\s\S]*hasDeepgramKey: Boolean\(DEEPGRAM_API_KEY\)/, 'server.js health should reflect proxy readiness');
assert.match(server, /timeoutMs: RVC_HEALTH_TIMEOUT_MS/, 'server.js health should bound the RVC dependency probe');
assert.match(server, /const HOST = process\.env\.HOST \|\| '0\.0\.0\.0';/, 'server.js should support an explicit listen host');
assert.match(server, /app\.listen\(\{ port: PORT, host: HOST \}\)\.catch/, 'server.js should listen on the configured host and handle startup failures');
assert.match(server, /clientAudioFrames \+= 1;/, 'server.js should count client audio frames');
assert.match(server, /function measurePcm16Level\(buffer\)/, 'server.js should measure incoming PCM levels for input diagnostics');
assert.match(server, /clientAudioPeak = Math\.max\(clientAudioPeak, level\.peak\);/, 'server.js should track peak mic level while forwarding audio');
assert.match(server, /clientAudioRms: Number\(clientAudioRms\.toFixed\(4\)\)/, 'server.js should log RMS mic level with audio progress');
assert.match(server, /Deepgram event/, 'server.js should log Deepgram event types when DEBUG_AUDIO=1');
assert.match(server, /discardAssistantAudioBuffer\(\);/, 'server.js should discard queued assistant audio on barge-in or disconnect');
assert.doesNotMatch(server, /assistantAudioSuppressed/, 'server.js should not suppress the next assistant turn while waiting for AgentAudioDone');
assert.match(server, /if \(shouldBufferAssistantAudio\(\)\) \{/, 'server.js should keep buffering assistant audio for RVC after barge-in cancellation');
assert.match(server, /const closeClientAfterAssistantAudio = \(\) => \{[\s\S]*if \(!deepgramClosed\) return;[\s\S]*if \(assistantAudioFlushQueue\.length\) return;[\s\S]*if \(assistantAudioChunks\.length\) \{[\s\S]*discardAssistantAudioBuffer\(\);[\s\S]*\}[\s\S]*if \(client\.readyState === WebSocket\.OPEN\) client\.close\(\);[\s\S]*\};/, 'server.js should defer browser close until pending assistant audio is handled');
assert.match(server, /deepgram\.on\('close', \(code, reason\) => \{[\s\S]*deepgramClosed = true;[\s\S]*closeClientAfterAssistantAudio\(\);[\s\S]*\}\);/, 'server.js should wait for buffered assistant audio before closing the browser socket');

console.log('audio-flow checks passed');
