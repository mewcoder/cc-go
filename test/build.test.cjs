'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { build, sha256, parseArgs, findExecutable, publish } = require('../scripts/build.cjs');

function fixture(t, settings = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-go packaging '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (name, text) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  };
  write('package.json', JSON.stringify({ version: '0.1.0' }));
  for (const file of ['icon.ico', 'icon.icns', 'icon.png', 'cc-go.desktop']) write('assets/' + file, file);
  write('README.md', 'fixture');
  fs.mkdirSync(path.join(root, 'cmd', 'cc-go'), { recursive: true });
  const calls = [], logs = [], waits = [];
  let busyFailures = settings.busyFailures || 0;
  let verifyBusyFailures = settings.verifyBusyFailures || 0;
  const execute = (command, args, options) => {
    calls.push({ command, args, options });
    if (args[0] === 'version') return settings.goVersion || 'go version go1.27.3 fixture/amd64';
    let step;
    if (args[0] === 'run') {
      const prefix = args[args.indexOf('--out') + 1], arch = args[args.indexOf('--arch') + 1];
      fs.writeFileSync(`${prefix}_windows_${arch}.syso`, 'generated');
      step = 'generate';
    } else if (args[0] === 'build') {
      const output = args[args.indexOf('-o') + 1];
      fs.mkdirSync(path.dirname(output), { recursive: true });
      if (!settings.noArtifact) fs.writeFileSync(output, 'abc');
      step = 'build';
    } else if (path.basename(command) === 'codesign') {
      step = args[0] === '--verify' ? 'verify' : 'sign';
    } else if (path.basename(command) === 'hdiutil') {
      if (args[0] === 'create') {
        const volume = args[args.indexOf('-srcfolder') + 1];
        calls.at(-1).volume = { applications: fs.readlinkSync(path.join(volume, 'Applications')),
          app: fs.existsSync(path.join(volume, 'CC Go.app/Contents/MacOS/cc-go')) };
        if (!settings.noArtifact) fs.writeFileSync(args.at(-1), 'abc');
        if (busyFailures-- > 0) throw new Error('hdiutil create failed: Resource busy');
        step = 'dmg';
      } else {
        if (verifyBusyFailures-- > 0) throw new Error('hdiutil: verify failed - 资源暂时不可用');
        step = 'dmg-verify';
      }
    } else throw new Error(`unexpected tool: ${command}`);
    if (settings.fail === step) throw new Error(`fixture ${step} failure`);
    return '';
  };
  const options = { root, platform: 'windows', arch: 'amd64', execute,
    findExecutable: name => settings.missing?.includes(name) ? undefined : name,
    log: text => logs.push(text), wait: async ms => { waits.push(ms); }, ...settings.options };
  return { root, write, calls, logs, waits, options };
}

test('SHA-256 uses Node streams and produces the standard digest without external tools', async t => {
  const h = fixture(t);
  const file = h.write('binary with spaces.exe', 'abc');
  assert.equal(await sha256(file), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  await assert.rejects(sha256(path.join(h.root, 'missing')), /ENOENT/);
});

test('Windows builds a single executable/checksum without PowerShell and restores an existing resource', async t => {
  const env = { PATH: 'fixture', GOOS: 'linux', GOARCH: 'arm64', CGO_ENABLED: '1' }, originalEnv = { ...env };
  const h = fixture(t, { options: { env } });
  const resource = h.write('cmd/cc-go/resource_windows_amd64.syso', 'original resource');
  const result = await build(h.options);
  assert.equal(path.basename(result), 'cc-go-0.1.0-windows-amd64.exe');
  assert.deepEqual(fs.readdirSync(path.dirname(result)).sort(), [path.basename(result), path.basename(result) + '.sha256']);
  assert.equal(fs.readFileSync(resource, 'utf8'), 'original resource');
  assert.equal(fs.readFileSync(result + '.sha256', 'utf8'), `${await sha256(result)}  ${path.basename(result)}\n`);
  assert.deepEqual(env, originalEnv, 'build must not mutate the caller environment');
  const generation = h.calls.find(call => call.args[0] === 'run');
  assert.equal(generation.options.env.GOOS, undefined);
  assert.equal(generation.options.env.GOARCH, undefined);
  const compile = h.calls.find(call => call.args[0] === 'build');
  assert.equal(compile.options.env.GOOS, 'windows');
  assert.equal(compile.options.env.GOARCH, 'amd64');
  assert.equal(compile.options.env.CGO_ENABLED, '0');
  assert.ok(compile.args.includes('-ldflags=-s -w -H=windowsgui'));
  assert.equal(h.calls.some(call => /powershell|shasum|sha256sum|Get-FileHash/i.test(call.command)), false);
  assert.equal(fs.readdirSync(path.join(h.root, 'build')).length, 0);
});

for (const fail of ['generate', 'build']) {
  test(`Windows ${fail} failure restores original resources and keeps previous release/checksum`, async t => {
    const h = fixture(t, { fail });
    const resource = h.write('cmd/cc-go/resource_windows_amd64.syso', 'original resource');
    const previous = h.write('release/cc-go-0.1.0-windows-amd64.exe', 'old binary');
    h.write('release/cc-go-0.1.0-windows-amd64.exe.sha256', 'old checksum');
    await assert.rejects(build(h.options), new RegExp(`fixture ${fail} failure`));
    assert.equal(fs.readFileSync(resource, 'utf8'), 'original resource');
    assert.equal(fs.readFileSync(previous, 'utf8'), 'old binary');
    assert.equal(fs.readFileSync(previous + '.sha256', 'utf8'), 'old checksum');
    assert.equal(h.logs.length, 0);
    assert.equal(fs.readdirSync(path.join(h.root, 'build')).length, 0);
  });
}

test('hash/read failures do not publish a successful build or leave temporary resources', async t => {
  const h = fixture(t, { noArtifact: true });
  const previous = h.write('release/cc-go-0.1.0-windows-amd64.exe', 'old binary');
  h.write('release/cc-go-0.1.0-windows-amd64.exe.sha256', 'old checksum');
  await assert.rejects(build(h.options), /ENOENT/);
  assert.equal(fs.readFileSync(previous, 'utf8'), 'old binary');
  assert.equal(fs.readFileSync(previous + '.sha256', 'utf8'), 'old checksum');
  assert.equal(fs.existsSync(path.join(h.root, 'cmd/cc-go/resource_windows_amd64.syso')), false);
  assert.deepEqual(h.logs, []);
});

test('missing Go fails preflight before resource generation or creating outputs', async t => {
  const h = fixture(t, { missing: ['go'] });
  await assert.rejects(build(h.options), /Missing go.*Install Go 1\.27\.3/);
  assert.equal(h.calls.length, 0);
  assert.equal(fs.existsSync(path.join(h.root, 'build')), false);
});

for (const version of ['go version go1.27.2 fixture/amd64', 'go version go1.26.9 fixture/amd64', 'unexpected']) {
  test(`unsupported Go version fails before building: ${version}`, async t => {
    const h = fixture(t, { goVersion: version });
    await assert.rejects(build(h.options), /Go 1\.27\.3\+ is required/);
    assert.equal(h.calls.length, 1);
    assert.equal(fs.existsSync(path.join(h.root, 'build')), false);
  });
}

test('Linux packaging is explicitly out of scope and does not create outputs', async t => {
  const h = fixture(t, { options: { platform: 'linux' } });
  await assert.rejects(build(h.options), /Packaging currently supports only Windows and macOS/);
  assert.equal(h.calls.length, 0);
  assert.equal(fs.existsSync(path.join(h.root, 'build')), false);
});

for (const target of [{ platform: 'darwin', arch: 'amd64' }, { platform: 'windows', arch: 'arm64' }]) {
  test(`unsupported desktop architecture is rejected: ${target.platform}/${target.arch}`, async t => {
    const h = fixture(t, { options: target });
    await assert.rejects(build(h.options), /only macOS arm64 and Windows amd64/);
    assert.equal(h.calls.length, 0);
  });
}

test('macOS missing codesign/hdiutil is a preflight error, never an unsigned fallback', { skip: process.platform !== 'darwin' }, async t => {
  const h = fixture(t, { missing: ['/usr/bin/codesign', '/usr/bin/hdiutil'], options: { platform: 'darwin', arch: 'arm64' } });
  await assert.rejects(build(h.options), error => {
    assert.match(error.message, /Missing \/usr\/bin\/codesign/);
    assert.match(error.message, /Missing \/usr\/bin\/hdiutil/);
    assert.match(error.message, /signing is never skipped/);
    return true;
  });
  assert.equal(h.calls.length, 0);
  assert.equal(fs.existsSync(path.join(h.root, 'build')), false);
});

for (const fail of ['sign', 'verify', 'dmg', 'dmg-verify']) {
  test(`macOS ${fail} failure does not replace a previous app/package`, { skip: process.platform !== 'darwin' }, async t => {
    const h = fixture(t, { fail, options: { platform: 'darwin', arch: 'arm64' } });
    const app = h.write('build/CC Go.app/previous', 'old app');
    const archive = h.write('release/cc-go-0.1.0-darwin-arm64.dmg', 'old archive');
    await assert.rejects(build(h.options), new RegExp(`fixture ${fail} failure`));
    assert.equal(fs.readFileSync(app, 'utf8'), 'old app');
    assert.equal(fs.readFileSync(archive, 'utf8'), 'old archive');
    assert.equal(h.logs.length, 0);
  });
}

test('macOS signs and verifies before creating a DMG, publishes a fresh app without stale bundled runtimes', { skip: process.platform !== 'darwin' }, async t => {
  const h = fixture(t, { options: { platform: 'darwin', arch: 'arm64' } });
  h.write('build/CC Go.app/Contents/Resources/node', 'obsolete runtime');
  const result = await build(h.options);
  assert.equal(path.basename(result), 'cc-go-0.1.0-darwin-arm64.dmg');
  const steps = h.calls.slice(2).map(call => path.basename(call.command) + ':' + call.args[0]);
  assert.deepEqual(steps, ['codesign:--force', 'codesign:--verify', 'hdiutil:create', 'hdiutil:verify']);
  const creation = h.calls.find(call => call.command === '/usr/bin/hdiutil' && call.args[0] === 'create');
  assert.deepEqual(creation.volume, { applications: '/Applications', app: true });
  assert.ok(Number.parseInt(creation.args[creation.args.indexOf('-size') + 1]) >= 32);
  assert.equal(fs.existsSync(path.join(h.root, 'build/CC Go.app/Contents/Resources/node')), false);
  assert.equal(fs.readdirSync(path.join(h.root, 'release')).some(name => name.endsWith('.zip')), false);
  assert.match(fs.readFileSync(path.join(h.root, 'build/CC Go.app/Contents/Info.plist'), 'utf8'), /<key>CFBundleDisplayName<\/key><string>CC Go<\/string>/);
  assert.equal(fs.readFileSync(result + '.sha256', 'utf8'), `${await sha256(result)}  ${path.basename(result)}\n`);
});

test('macOS retries transient image creation and verification failures with bounded backoff', { skip: process.platform !== 'darwin' }, async t => {
  const h = fixture(t, { busyFailures: 2, verifyBusyFailures: 1, options: { platform: 'darwin', arch: 'arm64' } });
  await build(h.options);
  assert.deepEqual(h.waits, [10000, 20000, 1000]);
  assert.equal(h.calls.filter(call => call.args[0] === 'create').length, 3);
  assert.equal(h.calls.filter(call => call.args[0] === 'verify').length, 2);
});

test('macOS stops after five busy image-creation failures without publishing', { skip: process.platform !== 'darwin' }, async t => {
  const h = fixture(t, { busyFailures: 10, options: { platform: 'darwin', arch: 'arm64' } });
  await assert.rejects(build(h.options), /Resource busy/);
  assert.equal(h.calls.filter(call => call.args[0] === 'create').length, 5);
  assert.equal(h.waits.length, 4);
  assert.equal(fs.existsSync(path.join(h.root, 'release')), false);
});

test('publication rollback restores the previous binary/checksum pair', t => {
  const h = fixture(t);
  const previous = h.write('release/previous.exe', 'old');
  const checksum = h.write('release/previous.exe.sha256', 'old checksum');
  const next = h.write('build/next.exe', 'new');
  assert.throws(() => publish([[next, previous], [path.join(h.root, 'missing'), checksum]]), /ENOENT/);
  assert.equal(fs.readFileSync(previous, 'utf8'), 'old');
  assert.equal(fs.readFileSync(checksum, 'utf8'), 'old checksum');
  assert.equal(fs.readdirSync(path.join(h.root, 'release')).length, 2);
});

test('tool lookup supports spaces and absolute paths and does not treat an empty PATH as cwd', t => {
  const h = fixture(t), file = h.write('tools with spaces/go', 'fixture');
  fs.chmodSync(file, 0o755);
  assert.equal(findExecutable(file, { PATH: '' }), file);
  assert.equal(findExecutable('missing-tool', { PATH: '' }), undefined);
});

test('one Node entry point handles native packaging and validates target flags', () => {
  assert.deepEqual(parseArgs(['--arch=arm64', '--platform', 'windows']), { arch: 'arm64', platform: 'windows' });
  assert.deepEqual(parseArgs(['-Arch', 'amd64']), { arch: 'amd64' });
  assert.throws(() => parseArgs(['--arch']), /Missing value/);
  assert.throws(() => parseArgs(['--unknown']), /Unknown build argument/);
  const runner = fs.readFileSync(path.join(__dirname, '../scripts/run.cjs'), 'utf8');
  assert.match(runner, /run\(process\.execPath, \[path\.join\(root, 'scripts', 'build\.cjs'\)/);
  assert.doesNotMatch(runner, /powershell\.exe|build\.ps1|build\.sh/);
});
