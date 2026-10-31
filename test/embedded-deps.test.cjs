'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const dependencies = require('../package.json').dependencies;

test('Git preserves LF bytes for embedded dependencies and UI baseline on Windows', () => {
  assert.match(fs.readFileSync(path.join(root, '.gitattributes'), 'utf8'), /^\* text=auto eol=lf$/m);
});

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
  const script = fs.readFileSync(path.join(root, 'scripts/build.cjs'), 'utf8');
  assert.ok(script.includes("name + '.exe'"));
  assert.ok(script.includes('-H=windowsgui'));
  assert.ok(script.includes("crypto.createHash('sha256')"));
  assert.doesNotMatch(script, /Get-FileHash|shasum|sha256sum|Compress-Archive|Copy-Item.*node_modules/);
});

test('the offline Diff renderer embeds the pinned upstream bundles and license unchanged', () => {
  const directory = path.join(root, 'web', 'vendor', 'diff2html');
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  assert.equal(manifest.version, dependencies.diff2html);
  for (const file of ['bundles/js/diff2html.min.js', 'bundles/css/diff2html.min.css', 'LICENSE.md']) {
    assert.deepEqual(fs.readFileSync(path.join(directory, path.basename(file))),
      fs.readFileSync(path.join(root, 'node_modules', 'diff2html', file)));
  }
  for (const filename of ['LICENSE-jsdiff', 'LICENSE-hogan']) assert.ok(fs.existsSync(path.join(directory, filename)));
  assert.match(fs.readFileSync(path.join(directory, 'NOTICE-hogan'), 'utf8'), /Copyright 2011 Twitter, Inc\./);
});
