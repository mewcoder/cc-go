'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
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
  const calls = [], logs = [];
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
    } else {
      const output = args.includes('-cf') ? args[args.indexOf('-cf') + 1] : args.at(-1);
      if (!settings.noArtifact) fs.writeFileSync(output, 'abc');
      step = 'archive';
    }
    if (settings.fail === step) throw new Error(`fixture ${step} failure`);
    return '';
  };
  const options = { root, platform: 'windows', arch: 'amd64', execute,
    findExecutable: name => settings.missing?.includes(name) ? undefined : name,
    log: text => logs.push(text), ...settings.options };
  return { root, write, calls, logs, options };
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

test('Linux missing tar is diagnosed before compilation', async t => {
  const h = fixture(t, { missing: ['tar'], options: { platform: 'linux' } });
  await assert.rejects(build(h.options), /Missing tar.*Install tar/);
  assert.equal(h.calls.length, 0);
});

test('Linux archive contains the launcher and does not call external hashing tools', async t => {
  const h = fixture(t, { options: { platform: 'linux', arch: 'arm64' } });
  const result = await build(h.options);
  assert.equal(path.basename(result), 'cc-go-0.1.0-linux-arm64.tar.gz');
  assert.equal(h.calls.at(-1).command, 'tar');
  assert.ok(h.calls.at(-1).args.includes('-cf'));
  assert.equal(zlib.gunzipSync(fs.readFileSync(result)).toString(), 'abc');
  assert.equal(fs.readFileSync(result + '.sha256', 'utf8'), `${await sha256(result)}  ${path.basename(result)}\n`);
});

test('macOS missing codesign/ditto is a preflight error, never an unsigned fallback', { skip: process.platform !== 'darwin' }, async t => {
  const h = fixture(t, { missing: ['/usr/bin/codesign', '/usr/bin/ditto'], options: { platform: 'darwin' } });
  await assert.rejects(build(h.options), error => {
    assert.match(error.message, /Missing \/usr\/bin\/codesign/);
    assert.match(error.message, /Missing \/usr\/bin\/ditto/);
    assert.match(error.message, /signing is never skipped/);
    return true;
  });
  assert.equal(h.calls.length, 0);
  assert.equal(fs.existsSync(path.join(h.root, 'build')), false);
});

for (const fail of ['sign', 'verify', 'archive']) {
  test(`macOS ${fail} failure does not replace a previous app/package`, { skip: process.platform !== 'darwin' }, async t => {
    const h = fixture(t, { fail, options: { platform: 'darwin' } });
    const app = h.write('build/CC Go.app/previous', 'old app');
    const archive = h.write('release/cc-go-0.1.0-darwin-amd64.zip', 'old archive');
    await assert.rejects(build(h.options), new RegExp(`fixture ${fail} failure`));
    assert.equal(fs.readFileSync(app, 'utf8'), 'old app');
    assert.equal(fs.readFileSync(archive, 'utf8'), 'old archive');
    assert.equal(h.logs.length, 0);
  });
}

test('macOS signs and verifies before archiving, publishes a fresh app without stale bundled runtimes', { skip: process.platform !== 'darwin' }, async t => {
  const h = fixture(t, { options: { platform: 'darwin' } });
  h.write('build/CC Go.app/Contents/Resources/node', 'obsolete runtime');
  const result = await build(h.options);
  assert.equal(path.basename(result), 'cc-go-0.1.0-darwin-amd64.zip');
  const steps = h.calls.slice(2).map(call => path.basename(call.command) + ':' + call.args[0]);
  assert.deepEqual(steps, ['codesign:--force', 'codesign:--verify', 'ditto:-c']);
  assert.equal(fs.existsSync(path.join(h.root, 'build/CC Go.app/Contents/Resources/node')), false);
  assert.match(fs.readFileSync(path.join(h.root, 'build/CC Go.app/Contents/Info.plist'), 'utf8'), /<key>CFBundleDisplayName<\/key><string>CC Go<\/string>/);
  assert.equal(fs.readFileSync(result + '.sha256', 'utf8'), `${await sha256(result)}  ${path.basename(result)}\n`);
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
