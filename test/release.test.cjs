'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sha256 } = require('../scripts/build.cjs');
const { validateTag, changelogNotes, releaseBody, expectedAssets, verifyAssets, publishRelease } = require('../scripts/release.cjs');

async function fixture(t, settings = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-go release ')), version = '0.1.0-beta.1';
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'release'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version }));
  const notes = '### Added\n\n- Keep desktop release notes in one place.';
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), `# Changelog\n\n## [Unreleased]\n\n- Future work.\n\n## [${version}] - 2026-11-01\n\n${notes}\n\n## [0.0.1] - 2026-10-29\n\n- Older work.\n`);
  const assets = expectedAssets(version), calls = [];
  for (const name of assets) {
    const file = path.join(root, 'release', name);
    fs.writeFileSync(file, `fixture ${name}`);
    fs.writeFileSync(file + '.sha256', `${await sha256(file)}  ${name}\n`);
  }
  const context = { eventName: 'push', ref: 'refs/tags/v' + version, sha: 'fixture-commit', repo: { owner: 'fixture', repo: 'cc-go' }, ...settings.context };
  const repos = {};
  const method = (name, run) => repos[name] = async args => { calls.push({ name, args }); return run(args); };
  method('getCommit', () => ({ data: { sha: settings.moved ? 'changed' : context.sha } }));
  method('getReleaseByTag', () => {
    if (settings.existing) return { data: settings.existing };
    throw Object.assign(new Error('not found'), { status: 404 });
  });
  method('listReleases', () => ({ data: settings.hiddenDraft ? [settings.hiddenDraft] : [] }));
  method('listReleaseAssets', () => ({ data: settings.existingAssets || [] }));
  method('createRelease', args => ({ data: { id: 42, ...args } }));
  method('deleteReleaseAsset', () => ({ data: {} }));
  method('uploadReleaseAsset', args => {
    if (settings.failUpload && args.name.endsWith('.exe')) throw new Error('upload failed');
    return { data: {} };
  });
  method('updateRelease', () => ({ data: {} }));
  const github = { rest: { repos }, paginate: async (fn, args) => (await fn(args)).data };
  return { root, version, notes, assets, calls, context, github, directory: path.join(root, 'release') };
}

test('first beta tag must match the app version exactly', () => {
  validateTag('v0.1.0-beta.1', '0.1.0-beta.1');
  validateTag('v0.1.0', '0.1.0');
  for (const tag of ['v0.1.1', '0.1.0-beta.1', 'v0.1.0-beta.1/extra', '']) {
    assert.throws(() => validateTag(tag, '0.1.0-beta.1'), /must exactly match/);
  }
});

test('release notes select the exact version without unreleased or older entries', async t => {
  const h = await fixture(t);
  assert.equal(changelogNotes(h.root, h.version), h.notes);
  assert.equal(releaseBody(h.root, h.version).split('\n\n---\n\n')[0], h.notes);
  const file = path.join(h.root, 'CHANGELOG.md');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\n/g, '\r\n'));
  assert.equal(changelogNotes(h.root, h.version), h.notes);
});

test('headings inside code fences remain in the selected notes', async t => {
  const h = await fixture(t);
  const notes = h.notes + '\n\n```md\n## [another-version]\n```\n\n~~~md\n## Example\n~~~';
  fs.writeFileSync(path.join(h.root, 'CHANGELOG.md'), `## [${h.version}] - 2026-11-01\n\n${notes}\n\n## [0.0.1] - 2026-10-29\n\n- Older work.`);
  assert.equal(changelogNotes(h.root, h.version), notes);
});

for (const kind of ['missing-file', 'missing-version', 'similar-version', 'duplicate', 'missing-date', 'invalid-date', 'empty', 'headings-only']) {
  test(`invalid changelog (${kind}) cannot reach the GitHub API`, async t => {
    const h = await fixture(t), file = path.join(h.root, 'CHANGELOG.md');
    let content = fs.readFileSync(file, 'utf8');
    if (kind === 'missing-file') fs.unlinkSync(file);
    else {
      if (kind === 'missing-version') content = '## [Unreleased]\n\n- Future work.';
      if (kind === 'similar-version') content = content.replace(`[${h.version}]`, `[${h.version}0]`);
      if (kind === 'duplicate') content += `\n\n## [${h.version}] - 2026-11-01\n\n- Duplicate.`;
      if (kind === 'missing-date') content = content.replace(`## [${h.version}] - 2026-11-01`, `## [${h.version}]`);
      if (kind === 'invalid-date') content = content.replace('2026-11-01', '2026-02-30');
      if (kind === 'empty') content = content.replace(h.notes, '');
      if (kind === 'headings-only') content = content.replace(h.notes, '### Added\n\n<!-- Write notes here. -->');
      fs.writeFileSync(file, content);
    }
    await assert.rejects(publishRelease(h), /CHANGELOG\.md/);
    assert.equal(h.calls.length, 0);
  });
}

test('release CLI checks the current changelog while manual builds allow unpublished versions', async t => {
  const h = await fixture(t), scripts = path.join(h.root, 'scripts');
  fs.mkdirSync(scripts);
  for (const file of ['release.cjs', 'build.cjs']) {
    fs.copyFileSync(path.join(__dirname, '../scripts', file), path.join(scripts, file));
  }
  const script = path.join(scripts, 'release.cjs');
  const env = { ...process.env };
  delete env.RELEASE_TAG;
  const check = spawnSync(process.execPath, [script, 'check'], { env, encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /Validated .* and CHANGELOG\.md/);
  const notes = spawnSync(process.execPath, [script, 'notes'], { env, encoding: 'utf8' });
  assert.equal(notes.status, 0, notes.stderr);
  assert.equal(notes.stdout.trim(), releaseBody(h.root, h.version));
  const tag = spawnSync(process.execPath, [script, 'validate-tag'], {
    env: { ...env, RELEASE_TAG: 'v999.0.0' }, encoding: 'utf8',
  });
  assert.equal(tag.status, 1);
  assert.match(tag.stderr, /must exactly match/);
  fs.unlinkSync(path.join(h.root, 'CHANGELOG.md'));
  const manual = spawnSync(process.execPath, [script, 'validate-tag'], { env, encoding: 'utf8' });
  assert.equal(manual.status, 0, manual.stderr);
  assert.match(manual.stdout, /Build only/);
  const missing = spawnSync(process.execPath, [script, 'validate-tag'], {
    env: { ...env, RELEASE_TAG: `v${h.version}` }, encoding: 'utf8',
  });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Missing CHANGELOG\.md/);
});

test('release set is exactly Mac ARM64 DMG, Windows x64 EXE and SHA256SUMS', async t => {
  const h = await fixture(t), result = await verifyAssets(h.directory, h.version);
  assert.equal(result.length, 3);
  assert.match(result[0], /-darwin-arm64\.dmg$/);
  assert.match(result[1], /-windows-amd64\.exe$/);
  assert.equal(result[2], 'SHA256SUMS');
  const lines = fs.readFileSync(path.join(h.directory, 'SHA256SUMS'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.ok(lines.every(line => /^[a-f0-9]{64}  cc-go-/.test(line)));
});

for (const kind of ['missing', 'mismatch', 'extra']) {
  test(`invalid release assets (${kind}) cannot reach the GitHub API`, async t => {
    const h = await fixture(t), file = path.join(h.directory, h.assets[0]);
    if (kind === 'missing') fs.unlinkSync(file);
    if (kind === 'mismatch') fs.writeFileSync(file, 'tampered');
    if (kind === 'extra') fs.writeFileSync(path.join(h.directory, 'unwanted-linux-binary'), 'extra');
    await assert.rejects(publishRelease(h));
    assert.equal(h.calls.length, 0);
  });
}

for (const context of [{ eventName: 'workflow_dispatch' }, { ref: 'refs/heads/main' }]) {
  test(`manual/branch builds never publish: ${JSON.stringify(context)}`, async t => {
    const h = await fixture(t, { context });
    await assert.rejects(publishRelease(h), /only for a pushed version tag/);
    assert.equal(h.calls.length, 0);
  });
}

test('a moved/deleted version tag cannot publish or be implicitly recreated', async t => {
  const h = await fixture(t, { moved: true });
  await assert.rejects(publishRelease(h), /tag moved/);
  assert.deepEqual(h.calls.map(call => call.name), ['getCommit']);
});

test('beta is uploaded as a draft, then published as a prerelease only after all files succeed', async t => {
  const h = await fixture(t);
  await publishRelease(h);
  const create = h.calls.find(call => call.name === 'createRelease');
  assert.equal(create.args.draft, true);
  assert.equal(create.args.prerelease, true);
  assert.equal(create.args.body, releaseBody(h.root, h.version));
  assert.equal(create.args.generate_release_notes, undefined);
  assert.doesNotMatch(create.args.body, /Future work|Older work/);
  const uploads = h.calls.filter(call => call.name === 'uploadReleaseAsset');
  assert.deepEqual(uploads.map(call => call.args.name), [...h.assets, 'SHA256SUMS']);
  assert.ok(uploads.every(call => Buffer.isBuffer(call.args.data)));
  assert.equal(h.calls.at(-1).name, 'updateRelease');
  assert.equal(h.calls.at(-1).args.draft, false);
  assert.equal(h.calls.at(-1).args.prerelease, true);
  assert.equal(h.calls.at(-1).args.make_latest, 'false');
  assert.equal(h.calls.at(-1).args.body, create.args.body);
});

test('upload failure leaves the draft unpublished', async t => {
  const h = await fixture(t, { failUpload: true });
  await assert.rejects(publishRelease(h), /upload failed/);
  assert.ok(h.calls.some(call => call.name === 'createRelease'));
  assert.equal(h.calls.some(call => call.name === 'updateRelease'), false);
});

test('retry resumes only a draft and removes partial uploads before replacing them', async t => {
  const h = await fixture(t, { hiddenDraft: { id: 7, tag_name: 'v0.1.0-beta.1', draft: true }, existingAssets: [{ id: 8 }] });
  await publishRelease(h);
  assert.equal(h.calls.some(call => call.name === 'createRelease'), false);
  const deletion = h.calls.findIndex(call => call.name === 'deleteReleaseAsset');
  const upload = h.calls.findIndex(call => call.name === 'uploadReleaseAsset');
  assert.ok(deletion >= 0 && deletion < upload);
  assert.equal(h.calls.at(-1).args.release_id, 7);
  assert.equal(h.calls.at(-1).args.body, releaseBody(h.root, h.version));
});

test('already published versions cannot have their downloads silently replaced', async t => {
  const h = await fixture(t, { existing: { id: 1, draft: false } });
  await assert.rejects(publishRelease(h), /already published/);
  assert.equal(h.calls.some(call => /create|upload|delete|update/i.test(call.name)), false);
});

test('workflow builds only two desktop targets and limits publishing to tag pushes', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/build.yml'), 'utf8');
  assert.match(workflow, /tags: \['v\*'\]/);
  assert.match(workflow, /if: github\.event_name == 'push' && startsWith\(github.ref, 'refs\/tags\/v'\)/);
  assert.equal([...workflow.matchAll(/platform: /g)].length, 2);
  assert.match(workflow, /platform: darwin\s+arch: arm64/);
  assert.match(workflow, /platform: windows\s+arch: amd64/);
  assert.doesNotMatch(workflow, /platform: linux|macos-15-intel|windows-11-arm/);
  assert.match(workflow, /publish:\s+needs: build/);
});
