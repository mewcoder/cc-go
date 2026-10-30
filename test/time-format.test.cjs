'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const source = fs.readFileSync(require.resolve('../web/shell.js'), 'utf8');
const start = source.indexOf('  function relativeTime(');
const end = source.indexOf('\n  function refreshSessionTimes(', start);
const functions = source.slice(start, end);
const now = Date.parse('2026-10-30T04:46:03Z');
const context = { Date: class extends Date { static now() { return now; } } };
vm.runInNewContext(functions, context);

test('conversation times follow the VSIX history units including every boundary', () => {
  for (const [elapsed, expected] of [
    [0, 'now'], [59999, 'now'], [60000, '1m'], [3599999, '59m'],
    [3600000, '1h'], [86399999, '23h'], [86400000, '1d'],
    [30 * 86400000 - 1, '29d'], [30 * 86400000, '1mo'],
    [60 * 86400000, '2mo'], [365 * 86400000 - 1, '12mo'],
    [365 * 86400000, '1y'], [2 * 365 * 86400000, '2y'],
  ]) {
    assert.equal(context.relativeTime(now - elapsed), expected, `${elapsed}ms`);
  }
  for (const invalid of [undefined, null, '', 'invalid', NaN, Infinity, -1, 0, now + 1]) {
    assert.equal(context.relativeTime(invalid), '');
  }
});

test('Output timestamps use the device time zone without inventing millisecond precision', () => {
  for (const [zone, expected] of [
    ['Asia/Shanghai', '2026-10-30 12:46:03'],
    ['UTC', '2026-10-30 04:46:03'],
    ['America/New_York', '2026-10-30 00:46:03'],
  ]) {
    const script = functions + `\nconsole.log(formatOutputLog('2026-10-30T04:46:03Z [info] Example'));`;
    const result = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: zone }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), expected + ' [info] Example');
  }
});

test('Output formatting preserves fractions, nested plugin timestamps and multiline messages', () => {
  const raw = '2026-10-30T04:46:03.123Z [info] Plugin: 2026-10-30T04:46:03.456Z\n  stack trace';
  const date = new Date('2026-10-30T04:46:03.123Z');
  const pad = value => String(value).padStart(2, '0');
  const expected = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.123`;
  assert.equal(context.formatOutputLog(raw), expected + ' [info] Plugin: 2026-10-30T04:46:03.456Z\n  stack trace');
  for (const unchanged of ['No output yet.', '2026-10-30T04:46:03Z user text', '2026-99-99T04:46:03Z [info] Invalid date']) {
    assert.equal(context.formatOutputLog(unchanged), unchanged);
  }
  assert.match(raw, /^2026-10-30T04:46:03\.123Z/, 'Formatting must not alter source logs');
});
