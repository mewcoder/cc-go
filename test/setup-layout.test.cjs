'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '../web/host.css'), 'utf8');

test('setup content centers in the usable window and remains scrollable when expanded', () => {
  assert.match(css, /\.setup-dialog \{[^}]*display: flex;[^}]*flex-direction: column;[^}]*padding: 54px 0 24px;[^}]*overflow: auto/);
  assert.match(css, /\.setup-vertical \{[^}]*flex: 0 0 auto;[^}]*margin: auto;/);
  assert.doesNotMatch(css, /\.setup-vertical \{[^}]*margin(?:-block)?: (?:clamp\(|\d)/);
  assert.match(css, /@media \(max-height: 620px\) \{\s*\.setup-dialog \{ padding: 42px 0 12px; \}/);
});

test('setup steps share fixed number, status and right-side action columns', () => {
  assert.match(css, /\.setup-vertical \.setup-card \{[^}]*grid-template-columns: 24px minmax\(0, 1fr\)/);
  assert.match(css, /\.setup-card-body \{[^}]*grid-template-columns: minmax\(0, 1fr\) 56px 168px;/);
  assert.match(css, /\.setup-card-status \{[^}]*grid-column: 2; grid-row: 1/);
  assert.match(css, /\.setup-vertical \.setup-card-body > \.setup-actions \{ grid-column: 3; grid-row: 1; align-self: start; justify-content: flex-end;/);
  assert.doesNotMatch(css, /grid-row: 1 \/ span 3/);
});

test('expanding content spans the body without recentering the first row', () => {
  assert.match(css, /\.setup-card-body > :is\([^)]*\.setup-install[^)]*\.setup-step-error\) \{ grid-column: 1 \/ -1; min-width: 0; \}/);
  assert.match(css, /\.setup-card-details \{[^}]*flex-wrap: wrap/);
  assert.match(css, /\.setup-card-version \{[^}]*overflow-wrap: anywhere/);
});

test('setup versions have no inline action icon styling', () => {
  assert.doesNotMatch(css, /setup-version-control|setup-version-action/);
});

test('narrow setup keeps actions right-aligned below details', () => {
  const narrow = css.slice(css.indexOf('@media (max-width: 560px)'));
  assert.match(narrow, /\.setup-vertical \{ width: calc\(100% - 32px\); \}/);
  assert.match(narrow, /\.setup-card-body \{ grid-template-columns: minmax\(0, 1fr\) 56px; \}/);
  assert.match(narrow, /\.setup-vertical \.setup-card-body > \.setup-actions \{ grid-column: 1 \/ -1; grid-row: auto; justify-content: flex-end; \}/);
});
