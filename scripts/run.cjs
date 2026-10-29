'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const windows = process.platform === 'win32';
const localGo = path.join(root, '.tools', 'go', 'bin', windows ? 'go.exe' : 'go');
const go = fs.existsSync(localGo) ? localGo : 'go';
const [command, ...args] = process.argv.slice(2);
function run(executable, arguments_) {
  const result = spawnSync(executable, arguments_, { cwd: root, stdio: 'inherit',
    env: { ...process.env, CGO_ENABLED: process.env.CGO_ENABLED ?? '0' } });
  if (result.error) { console.error(result.error.message); process.exit(1); }
  if (result.status !== 0) process.exit(result.status || 1);
}
switch (command) {
  case 'start':
  case 'dev':
  case 'web': {
    const tags = command === 'start' ? [] : ['-tags=headless'];
    run(go, ['run', ...tags, './cmd/cc-go', ...(command === 'start' ? [] : ['--web']),
      ...(command === 'dev' ? ['--dev-assets', path.join(root, 'web')] : []), ...args]);
    break;
  }
  case 'test':
    run(process.execPath, ['--test', ...fs.readdirSync(path.join(root, 'test')).filter(name => name.endsWith('.test.cjs')).map(name => path.join(root, 'test', name))]);
    run(go, ['test', './...', ...args]);
    break;
  case 'build':
    run(process.execPath, [path.join(root, 'scripts', 'build.cjs'), ...args]);
    break;
  default:
    console.error('Usage: node scripts/run.cjs start|dev|web|test|build [arguments]');
    process.exit(1);
}
