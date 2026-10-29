'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { setTimeout: wait } = require('node:timers/promises');
const { spawnSync } = require('node:child_process');

function findExecutable(name, env = process.env) {
  const searchPath = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] || '';
  const names = process.platform === 'win32' && !path.extname(name) ? [name + '.exe', name + '.com'] : [name];
  const candidates = path.isAbsolute(name) ? [name]
    : searchPath.split(path.delimiter).filter(Boolean).flatMap(directory => names.map(file => path.resolve(directory, file)));
  return candidates.find(file => {
    try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); }
    catch { return false; }
  });
}

function execute(command, args, options) {
  const result = spawnSync(command, args, { cwd: options.cwd, env: options.env,
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', encoding: 'utf8' });
  if (result.error) throw new Error(`Cannot start ${command}: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${path.basename(command)} ${args[0]} failed (${result.signal || result.status})${result.stderr ? ': ' + result.stderr.trim() : ''}`);
  }
  return result.stdout?.trim() || '';
}

async function sha256(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const [flag, value] = args[i].split('=');
    const key = { '--arch': 'arch', '-Arch': 'arch', '--platform': 'platform' }[flag];
    if (!key) throw new Error(`Unknown build argument: ${args[i]}. Use --arch amd64|arm64 or --platform windows|darwin.`);
    options[key] = value ?? args[++i];
    if (!options[key]) throw new Error(`Missing value for ${flag}`);
  }
  return options;
}

function plist(version) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>CC Go</string>
  <key>CFBundleDisplayName</key><string>CC Go</string>
  <key>CFBundleIdentifier</key><string>local.claude-vsix-go</string>
  <key>CFBundleExecutable</key><string>cc-go</string>
  <key>CFBundleIconFile</key><string>icon.icns</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${version.split(/[+-]/)[0]}</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
`;
}

function directoryBytes(directory) {
  let total = 0;
  for (const name of fs.readdirSync(directory)) {
    const file = path.join(directory, name), stat = fs.lstatSync(file);
    if (stat.isDirectory()) total += directoryBytes(file);
    else if (stat.isFile()) total += stat.size;
  }
  return total;
}

// Stage all outputs first. If publishing fails, restore the previous artifacts
// rather than leaving a new binary paired with an old checksum.
function publish(entries) {
  const moved = [];
  try {
    for (const [source, destination] of entries) {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const backup = destination + '.previous-' + crypto.randomUUID();
      const item = { destination, backup, previous: fs.existsSync(destination), installed: false };
      if (item.previous) fs.renameSync(destination, backup);
      moved.push(item);
      fs.renameSync(source, destination);
      item.installed = true;
    }
  } catch (error) {
    for (const item of moved.reverse()) {
      if (item.installed) fs.rmSync(item.destination, { recursive: true, force: true });
      if (item.previous) fs.renameSync(item.backup, item.destination);
    }
    throw error;
  }
  for (const item of moved) if (item.previous) fs.rmSync(item.backup, { recursive: true, force: true });
}

async function build(options = {}) {
  const root = options.root || path.resolve(__dirname, '..');
  const platform = options.platform || (process.platform === 'win32' ? 'windows' : process.platform);
  const arch = options.arch || (platform === 'windows' ? 'amd64' : 'arm64');
  const env = { ...(options.env || process.env), CGO_ENABLED: '0' };
  // Run the resource generator on the host, not as a cross-compiled executable.
  for (const key of Object.keys(env)) if (/^GO(OS|ARCH)$/i.test(key)) delete env[key];
  const run = options.execute || execute, resolve = options.findExecutable || findExecutable;
  const log = options.log || console.log;
  if (!['windows', 'darwin'].includes(platform)) throw new Error(`Unsupported build platform: ${platform}. Packaging currently supports only Windows and macOS.`);
  if (!['amd64', 'arm64'].includes(arch)) throw new Error(`Unsupported build architecture: ${arch}`);
  if (arch !== (platform === 'windows' ? 'amd64' : 'arm64')) throw new Error('Packaging currently supports only macOS arm64 and Windows amd64.');
  if (platform === 'darwin' && process.platform !== 'darwin') throw new Error('macOS packaging requires a Mac for codesign and hdiutil.');
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Packaging requires Node.js 22 or newer.');
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(version)) throw new Error('Invalid package.json version');

  const localGo = path.join(root, '.tools', 'go', 'bin', process.platform === 'win32' ? 'go.exe' : 'go');
  const requirements = [[fs.existsSync(localGo) ? localGo : 'go', 'Install Go 1.27.3+ or provide .tools/go/bin/go.']];
  if (platform === 'darwin') requirements.push(
    ['/usr/bin/codesign', "Restore Apple's codesign tool on this Mac; required ad-hoc signing is never skipped."],
    ['/usr/bin/hdiutil', "Restore Apple's hdiutil tool on this Mac to create the DMG."]);
  const tools = requirements.map(([name]) => resolve(name, env));
  const missing = requirements.filter((_, i) => !tools[i]);
  if (missing.length) throw new Error('Build prerequisites not met:\n' + missing.map(([name, help]) => `- Missing ${name}. ${help}`).join('\n'));
  const [go, systemTool, diskTool] = tools;
  const host = { cwd: root, env };
  const goVersion = run(go, ['version'], { ...host, capture: true });
  const parsed = /\bgo(\d+)\.(\d+)\.(\d+)\b/.exec(goVersion);
  const required = [1, 27, 3], actual = parsed?.slice(1).map(Number);
  if (!actual || actual.reduce((difference, part, i) => difference || part - required[i], 0) < 0) {
    throw new Error(`Go 1.27.3+ is required; found ${goVersion || 'an unknown version'}.`);
  }

  fs.mkdirSync(path.join(root, 'build'), { recursive: true });
  const work = fs.mkdtempSync(path.join(root, 'build', '.packaging-'));
  const resourceBackup = path.join(work, 'previous-resource.syso');
  try {
    const target = { ...host, env: { ...env, GOOS: platform, GOARCH: arch } };
    const name = `cc-go-${version}-${platform}-${arch}`;
    let artifact, application;
    if (platform === 'windows') {
      const prefix = path.join(root, 'cmd', 'cc-go', 'resource');
      const resource = `${prefix}_windows_${arch}.syso`;
      const existed = fs.existsSync(resource);
      if (existed && !fs.lstatSync(resource).isFile()) throw new Error(`Refusing to replace a non-regular resource file: ${resource}`);
      if (existed) fs.renameSync(resource, resourceBackup);
      try {
        run(go, ['run', 'github.com/tc-hib/go-winres@v0.3.3', 'simply', '--arch', arch, '--out', prefix,
          '--manifest', 'gui', '--icon', 'assets/icon.ico', '--product-name', 'CC Go',
          '--file-description', 'Claude Code VS Code extension (.vsix) desktop host',
          '--original-filename', 'cc-go.exe', '--product-version', version.split(/[+-]/)[0], '--file-version', version.split(/[+-]/)[0]], host);
        if (!fs.statSync(resource).isFile()) throw new Error('Windows resource generation produced no resource file.');
        artifact = path.join(work, name + '.exe');
        run(go, ['build', '-trimpath', '-ldflags=-s -w -H=windowsgui', '-o', artifact, './cmd/cc-go'], target);
      } finally {
        fs.rmSync(resource, { force: true });
        if (existed) fs.renameSync(resourceBackup, resource);
      }
    } else if (platform === 'darwin') {
      application = path.join(work, 'CC Go.app');
      const contents = path.join(application, 'Contents');
      fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
      fs.mkdirSync(path.join(contents, 'Resources'), { recursive: true });
      run(go, ['build', '-trimpath', '-ldflags=-s -w', '-o', path.join(contents, 'MacOS', 'cc-go'), './cmd/cc-go'], target);
      fs.copyFileSync(path.join(root, 'assets', 'icon.icns'), path.join(contents, 'Resources', 'icon.icns'));
      fs.writeFileSync(path.join(contents, 'Info.plist'), plist(version));
      run(systemTool, ['--force', '--deep', '--sign', '-', application], host);
      run(systemTool, ['--verify', '--deep', '--strict', application], host);
      const volume = path.join(work, 'dmg');
      fs.mkdirSync(volume);
      fs.cpSync(application, path.join(volume, 'CC Go.app'), { recursive: true });
      fs.symlinkSync('/Applications', path.join(volume, 'Applications'));
      artifact = path.join(work, name + '.dmg');
      // Magpie reserves headroom explicitly and retries transient hdiutil
      // "Resource busy" failures instead of trusting its automatic sizing.
      const size = Math.ceil(directoryBytes(volume) / 1024 / 1024 * 1.25) + 32;
      for (let attempt = 1; ; attempt++) {
        try {
          run(diskTool, ['create', '-volname', 'CC Go', '-srcfolder', volume, '-size', `${size}m`, '-ov', '-format', 'UDZO', artifact], { ...host, capture: true });
          break;
        } catch (error) {
          if (!/resource busy|resource temporarily unavailable|资源忙|资源暂时不可用/i.test(error.message) || attempt === 5) throw error;
          fs.rmSync(artifact, { force: true });
          log(`hdiutil is busy; retrying DMG creation (${attempt}/5).`);
          await (options.wait || wait)(attempt * 10000);
        }
      }
      for (let attempt = 1; ; attempt++) {
        try {
          run(diskTool, ['verify', artifact], { ...host, capture: true });
          break;
        } catch (error) {
          if (!/resource busy|resource temporarily unavailable|资源忙|资源暂时不可用/i.test(error.message) || attempt === 5) throw error;
          log(`hdiutil verification is busy; retrying (${attempt}/5).`);
          await (options.wait || wait)(attempt * 1000);
        }
      }
    }
    const output = path.join(root, 'release', path.basename(artifact));
    const checksum = await sha256(artifact);
    fs.writeFileSync(artifact + '.sha256', `${checksum}  ${path.basename(artifact)}\n`, 'ascii');
    const entries = [[artifact, output], [artifact + '.sha256', output + '.sha256']];
    if (application) entries.push([application, path.join(root, 'build', 'CC Go.app')]);
    publish(entries);
    log(`Built: ${output}`);
    if (application) log(`Application: ${path.join(root, 'build', 'CC Go.app')}`);
    return output;
  } finally {
    if (fs.existsSync(resourceBackup)) log(`Resource restoration failed; original retained at ${resourceBackup}`);
    else fs.rmSync(work, { recursive: true, force: true });
  }
}

module.exports = { build, sha256, parseArgs, findExecutable, publish };
if (require.main === module) {
  Promise.resolve().then(() => build(parseArgs(process.argv.slice(2)))).catch(error => {
    console.error(`Build failed: ${error.message}`);
    process.exitCode = 1;
  });
}
