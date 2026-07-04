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
assert.match(app, /playbackNodes\.add\(node\)/, 'app.js should track playback nodes for cancellation');
assert.match(server, /const DEBUG_AUDIO = process\.env\.DEBUG_AUDIO === '1';/, 'server.js should expose opt-in audio diagnostics');
assert.match(server, /clientAudioFrames \+= 1;/, 'server.js should count client audio frames');
assert.match(server, /Deepgram event/, 'server.js should log Deepgram event types when DEBUG_AUDIO=1');

console.log('audio-flow checks passed');
