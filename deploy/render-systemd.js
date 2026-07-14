#!/usr/bin/env node

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const options = {
    projectRoot: process.cwd(),
    port: 8787,
    checkPort: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--check-port') {
      options.checkPort = true;
      continue;
    }
    if (!['--output-dir', '--project-root', '--port'].includes(flag)) {
      fail(`unknown option: ${flag}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      fail(`missing value for ${flag}`);
    }
    index += 1;
    if (flag === '--output-dir') options.outputDir = value;
    if (flag === '--project-root') options.projectRoot = value;
    if (flag === '--port') options.port = Number(value);
  }

  if (!options.outputDir) fail('--output-dir is required');
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    fail('--port must be an integer from 1 to 65535');
  }

  options.outputDir = path.resolve(options.outputDir);
  options.projectRoot = path.resolve(options.projectRoot);
  return options;
}

function validateUnitPath(label, value) {
  if (!/^[A-Za-z0-9_./-]+$/.test(value)) {
    fail(`${label} contains unsupported systemd-sensitive characters: ${value}`);
  }
}

function validateExecutable(label, executable) {
  try {
    fs.accessSync(executable, fs.constants.X_OK);
  } catch {
    fail(`${label} executable not found or not executable: ${executable}`);
  }
}

function assertPortAvailable(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        reject(new Error(`127.0.0.1:${port} is already in use`));
        return;
      }
      reject(error);
    });
    server.listen(port, '127.0.0.1', () => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });
}

function renderTemplate(template, replacements) {
  let rendered = template;
  for (const [token, value] of Object.entries(replacements)) {
    rendered = rendered.replaceAll(token, value);
  }
  const unreplaced = rendered.match(/__[A-Z_]+__/);
  if (unreplaced) fail(`unreplaced template token: ${unreplaced[0]}`);
  return rendered;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const nodePath = path.resolve(process.execPath);
  const pythonPath = path.join(options.projectRoot, 'rvc-service', '.venv', 'bin', 'python');

  validateUnitPath('project root', options.projectRoot);
  validateUnitPath('Node executable path', nodePath);
  validateExecutable('Node', nodePath);
  validateExecutable('RVC Python', pythonPath);
  if (options.checkPort) await assertPortAvailable(options.port);

  const replacements = {
    __PROJECT_ROOT__: options.projectRoot,
    __NODE_PATH__: nodePath,
    __WEB_PORT__: String(options.port),
  };
  const templates = ['voice-agent-web.service', 'voice-agent-rvc.service'];
  fs.mkdirSync(options.outputDir, { recursive: true });
  for (const unitName of templates) {
    const templatePath = path.join(__dirname, 'systemd', `${unitName}.in`);
    const unitPath = path.join(options.outputDir, unitName);
    const rendered = renderTemplate(fs.readFileSync(templatePath, 'utf8'), replacements);
    fs.writeFileSync(unitPath, rendered, { mode: 0o644 });
    fs.chmodSync(unitPath, 0o644);
  }
}

main().catch((error) => {
  console.error(`render-systemd: ${error.message}`);
  process.exitCode = 1;
});
