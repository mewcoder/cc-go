'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const dependencies = require('../package.json').dependencies;

for (const name of ['picomatch', 'vscode-uri']) {
  test(`embedded ${name} matches the pinned installed package and retains its license`, () => {
    const directory = path.join(root, 'runtime', 'deps', name);
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    assert.equal(manifest.version, dependencies[name], 'run npm ci and go generate ./runtime after updating dependencies');
    const files = fs.readdirSync(directory, { recursive: true })
      .filter(file => fs.statSync(path.join(directory, file)).isFile());
    assert.ok(files.some(file => /^LICENSE/.test(file)));
    assert.ok(files.includes(path.normalize(manifest.main)));
    for (const file of files) {
      assert.deepEqual(fs.readFileSync(path.join(directory, file)),
        fs.readFileSync(path.join(root, 'node_modules', name, file)), `${name}/${file} drifted from the installed dependency`);
    }
  });
}

test('Windows distribution is a GUI executable, not a ZIP with adjacent JS modules', () => {
  const script = fs.readFileSync(path.join(root, 'scripts/build.ps1'), 'utf8');
  assert.ok(script.includes('release/$Name.exe'));
  assert.ok(script.includes('-H=windowsgui'));
  assert.ok(script.includes('Get-FileHash -Algorithm SHA256 $Executable'));
  assert.doesNotMatch(script, /Compress-Archive|Copy-Item.*node_modules/);
});
