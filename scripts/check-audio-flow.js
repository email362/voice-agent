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
assert.match(app, /try \{[\s\S]*event = JSON\.parse\(message\.data\);[\s\S]*\} catch \{[\s\S]*return;[\s\S]*\}/, 'app.js should ignore unexpected non-JSON text frames');
assert.match(app, /playbackNodes\.add\(node\)/, 'app.js should track playback nodes for cancellation');
assert.match(app, /const conversationSocket = new WebSocket\(/, 'app.js should capture the socket instance per conversation');
assert.match(app, /if \(conversationSocket !== socket\) return;/, 'app.js should ignore stale socket events');
assert.match(app, /let conversationHadError = false;/, 'app.js should track whether the socket saw an error event');
assert.match(app, /conversationSocket\.addEventListener\('close', \(\) => \{[\s\S]*if \(conversationSocket === expectedSocketClose\) \{[\s\S]*return;[\s\S]*stopConversation\(\{ closingSocket: conversationSocket, preserveStatus: conversationHadError, statusMessage: 'Disconnected\.' \}\);[\s\S]*\}\);/, 'app.js should clear clean disconnects while preserving error closes');
assert.match(app, /function stopConversation\(\{ closingSocket = socket, preserveStatus = false, statusMessage = 'Stopped\.' \} = \{\}\)/, 'app.js should let callers preserve the current status');
assert.match(app, /if \(!preserveStatus\) setStatus\(statusMessage\);/, 'app.js should only show Stopped\. for explicit stops');
assert.match(app, /let conversationGeneration = 0;/, 'app.js should track startup generations');
assert.match(app, /if \(generation !== conversationGeneration\) \{[\s\S]*return;/, 'app.js should abort startup when stop is requested during mic setup');
assert.match(app, /stopBtn\.addEventListener\('click', \(\) => stopConversation\(\)\);/, 'app.js should stop the conversation from the UI button');
assert.match(server, /const DEBUG_AUDIO = process\.env\.DEBUG_AUDIO === '1';/, 'server.js should expose opt-in audio diagnostics');
assert.match(server, /ok: Boolean\(DEEPGRAM_API_KEY\)/, 'server.js health should reflect proxy readiness');
assert.match(server, /clientAudioFrames \+= 1;/, 'server.js should count client audio frames');
assert.match(server, /Deepgram event/, 'server.js should log Deepgram event types when DEBUG_AUDIO=1');
assert.match(server, /discardAssistantAudioBuffer\(\);/, 'server.js should discard queued assistant audio on barge-in or disconnect');
assert.match(server, /const closeClientAfterAssistantAudio = \(\) => \{[\s\S]*if \(!deepgramClosed\) return;[\s\S]*if \(assistantAudioFlushQueue\.length\) return;[\s\S]*if \(assistantAudioChunks\.length\) \{[\s\S]*discardAssistantAudioBuffer\(\);[\s\S]*\}[\s\S]*if \(client\.readyState === WebSocket\.OPEN\) client\.close\(\);[\s\S]*\};/, 'server.js should defer browser close until pending assistant audio is handled');
assert.match(server, /deepgram\.on\('close', \(code, reason\) => \{[\s\S]*deepgramClosed = true;[\s\S]*closeClientAfterAssistantAudio\(\);[\s\S]*\}\);/, 'server.js should wait for buffered assistant audio before closing the browser socket');

console.log('audio-flow checks passed');
