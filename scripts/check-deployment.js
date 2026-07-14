const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-agent-units-'));
const render = spawnSync(process.execPath, ['deploy/render-systemd.js', '--output-dir', outputDir, '--project-root', process.cwd(), '--port', '8787'], { encoding: 'utf8' });
assert.equal(render.status, 0, render.stderr);
const web = fs.readFileSync(path.join(outputDir, 'voice-agent-web.service'), 'utf8');
const rvc = fs.readFileSync(path.join(outputDir, 'voice-agent-rvc.service'), 'utf8');
assert.match(web, /HOST=127\.0\.0\.1 PORT=8787/);
assert.match(web, /Restart=on-failure/);
assert.match(rvc, /RVC_HOST=127\.0\.0\.1 RVC_PORT=5055 RVC_DEVICE=cpu/);
assert.doesNotMatch(`${web}\n${rvc}`, /__PROJECT_ROOT__|__NODE_PATH__|__WEB_PORT__/);

const unsafeRoot = spawnSync(process.execPath, ['deploy/render-systemd.js', '--output-dir', outputDir, '--project-root', path.join(os.tmpdir(), 'voice agent')], { encoding: 'utf8' });
assert.notEqual(unsafeRoot.status, 0);
assert.match(unsafeRoot.stderr, /project root.*systemd-sensitive/i);

const listener = net.createServer();
listener.listen(0, '127.0.0.1', () => {
  const port = listener.address().port;
  const conflict = spawnSync(process.execPath, ['deploy/render-systemd.js', '--output-dir', outputDir, '--port', String(port), '--check-port'], { encoding: 'utf8' });
  listener.close();
  assert.notEqual(conflict.status, 0);
  assert.match(conflict.stderr, /already in use/);
  console.log('deployment checks passed');
});
