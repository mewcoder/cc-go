'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('sidebar update starts installation directly without opening setup first', () => {
  const source = fs.readFileSync(path.join(__dirname, '../web/shell.js'), 'utf8');
  const start = source.indexOf("  ui.pluginUpdate.addEventListener('click'");
  const end = source.indexOf('\n  });', start) + '\n  });'.length;
  for (const status of ['idle', 'ready', 'cancelled']) {
    let click, updates = 0;
    vm.runInNewContext(source.slice(start, end), {
      state: { pluginSetup: { status } },
      ui: { pluginUpdate: { addEventListener(type, fn) { assert.equal(type, 'click'); click = fn; } } },
      runCommand(key, fn) { assert.equal(key, 'plugin'); return fn(); },
      desktop: {
        reloadPlugin() { updates++; },
        showPluginSetup() { assert.fail('update must not navigate to setup'); },
      },
    });
    click();
    assert.equal(updates, 1);
  }
});
