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

const diffSource = path.join(root, 'node_modules', 'diff2html');
const diffTarget = path.join(root, 'web', 'vendor', 'diff2html');
const diffVersion = require('../package.json').dependencies.diff2html;
if (JSON.parse(fs.readFileSync(path.join(diffSource, 'package.json'), 'utf8')).version !== diffVersion) {
  throw new Error(`diff2html: expected ${diffVersion}`);
}
fs.mkdirSync(diffTarget, { recursive: true });
for (const file of ['bundles/js/diff2html.min.js', 'bundles/css/diff2html.min.css', 'LICENSE.md', 'package.json']) {
  fs.copyFileSync(path.join(diffSource, file), path.join(diffTarget, path.basename(file)));
}
for (const [name, filename] of [['diff', 'LICENSE-jsdiff'], ['@profoundlogic/hogan', 'LICENSE-hogan']]) {
  fs.copyFileSync(path.join(root, 'node_modules', name, 'LICENSE'), path.join(diffTarget, filename));
}
const hoganTemplate = fs.readFileSync(path.join(root, 'node_modules', '@profoundlogic/hogan/lib/template.js'), 'utf8');
fs.writeFileSync(path.join(diffTarget, 'NOTICE-hogan'), hoganTemplate.match(/^\/\*[\s\S]*?\*\//)[0] + '\n');
console.log(`Vendored diff2html@${diffVersion}`);
