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

const installerSandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-agent-installer-'));
const fakeBin = path.join(installerSandbox, 'bin');
const systemctlSentinel = path.join(installerSandbox, 'systemctl-called');
const userConfig = path.join(installerSandbox, 'xdg');
fs.mkdirSync(fakeBin);
fs.writeFileSync(path.join(fakeBin, 'systemctl'), '#!/bin/sh\n: > "$SYSTEMCTL_SENTINEL"\n', { mode: 0o755 });
const installerEnv = {
  ...process.env,
  PATH: `${fakeBin}:${process.env.PATH}`,
  SYSTEMCTL_SENTINEL: systemctlSentinel,
  XDG_CONFIG_HOME: userConfig,
};
const emptyRenderDir = spawnSync('deploy/install-user-services.sh', ['--render-dir', ''], { encoding: 'utf8', env: installerEnv });
assert.notEqual(emptyRenderDir.status, 0);
assert.match(emptyRenderDir.stderr, /--render-dir requires a non-empty value/);
assert.equal(fs.existsSync(userConfig), false, 'empty --render-dir must not mutate the user config directory');
assert.equal(fs.existsSync(systemctlSentinel), false, 'empty --render-dir must not invoke systemctl');

const installerOutput = path.join(installerSandbox, 'rendered');
const renderOnly = spawnSync('deploy/install-user-services.sh', ['--render-dir', installerOutput], { encoding: 'utf8', env: installerEnv });
assert.equal(renderOnly.status, 0, renderOnly.stderr);
assert.equal(fs.existsSync(path.join(installerOutput, 'voice-agent-web.service')), true);
assert.equal(fs.existsSync(path.join(installerOutput, 'voice-agent-rvc.service')), true);
assert.equal(fs.existsSync(userConfig), false, 'render-only mode must not mutate the user config directory');
assert.equal(fs.existsSync(systemctlSentinel), false, 'render-only mode must not invoke systemctl');

const listener = net.createServer();
listener.listen(0, '127.0.0.1', () => {
  const port = listener.address().port;
  const conflict = spawnSync(process.execPath, ['deploy/render-systemd.js', '--output-dir', outputDir, '--port', String(port), '--check-port'], { encoding: 'utf8' });
  listener.close();
  assert.notEqual(conflict.status, 0);
  assert.match(conflict.stderr, /already in use/);
  console.log('deployment checks passed');
});
