'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const dependencies = {
  picomatch: ['package.json', 'LICENSE', 'index.js', 'posix.js', 'lib'],
  'vscode-uri': ['package.json', 'LICENSE.md', 'lib/umd/index.js'],
};

for (const [name, files] of Object.entries(dependencies)) {
  const source = path.join(root, 'node_modules', name);
  const target = path.join(root, 'runtime', 'deps', name);
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
  const version = require('../package.json').dependencies[name];
  if (manifest.version !== version) throw new Error(`${name}: expected ${version}, got ${manifest.version}`);
  fs.rmSync(target, { recursive: true, force: true });
  for (const file of files) {
    const destination = path.join(target, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(path.join(source, file), destination, { recursive: true });
  }
  console.log(`Vendored ${name}@${version}`);
}
