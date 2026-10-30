'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { sha256 } = require('./build.cjs');

function validateTag(tag, version) {
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag) || tag !== `v${version}`) {
    throw new Error(`Release tag ${tag || '(missing)'} must exactly match package.json version v${version}.`);
  }
}

function expectedAssets(version) {
  return [`cc-go-${version}-darwin-arm64.dmg`, `cc-go-${version}-windows-amd64.exe`];
}

async function verifyAssets(directory, version) {
  const assets = expectedAssets(version);
  const expected = new Set([...assets, ...assets.map(name => name + '.sha256'), 'SHA256SUMS']);
  for (const name of fs.readdirSync(directory)) {
    if (!expected.has(name)) throw new Error(`Unexpected release asset: ${name}`);
  }
  const sums = [];
  for (const name of assets) {
    const file = path.join(directory, name), sidecar = file + '.sha256';
    for (const required of [file, sidecar]) {
      if (!fs.lstatSync(required).isFile() || fs.statSync(required).size === 0) throw new Error(`Invalid release asset: ${required}`);
    }
    const line = `${await sha256(file)}  ${name}`;
    if (fs.readFileSync(sidecar, 'ascii').trimEnd() !== line) throw new Error(`Checksum mismatch: ${name}`);
    sums.push(line);
  }
  fs.writeFileSync(path.join(directory, 'SHA256SUMS'), sums.join('\n') + '\n', 'ascii');
  return [...assets, 'SHA256SUMS'];
}

async function publishRelease({ github, context, root = path.resolve(__dirname, '..') }) {
  if (context.eventName !== 'push' || !context.ref.startsWith('refs/tags/v')) {
    throw new Error('Publishing is allowed only for a pushed version tag, never a branch or manual build.');
  }
  const tag = context.ref.slice('refs/tags/'.length);
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  validateTag(tag, version);
  const directory = path.join(root, 'release');
  const files = await verifyAssets(directory, version);
  const repo = context.repo;
  // A tag deleted/moved during a long build must not be silently recreated by
  // the Releases API or publish downloads for a different source commit.
  const commit = await github.rest.repos.getCommit({ ...repo, ref: tag });
  if (commit.data.sha !== context.sha) throw new Error('Release tag moved after this build started.');
  let release;
  try {
    release = (await github.rest.repos.getReleaseByTag({ ...repo, tag })).data;
  } catch (error) {
    if (error.status !== 404) throw error;
    const releases = await github.paginate(github.rest.repos.listReleases, { ...repo, per_page: 100 });
    release = releases.find(item => item.tag_name === tag);
  }
  if (release && !release.draft) throw new Error(`${tag} is already published; use a new version tag instead of replacing its downloads.`);
  const prerelease = version.includes('-');
  if (!release) {
    release = (await github.rest.repos.createRelease({ ...repo, tag_name: tag, target_commitish: context.sha,
      name: `CC Go ${tag}`, draft: true, prerelease, generate_release_notes: true,
      body: '支持 macOS Apple Silicon（DMG）和 Windows x64（EXE）。需要本机 Node.js 22+；首次启动优先复用 VS Code 已安装的稳定版 Claude 插件，没有可用插件时自动下载，使用插件内置 Claude。\n\n当前为测试阶段：Mac 仅临时签名、未公证，Windows 未做发行者代码签名。下载后可用 SHA256SUMS 校验。' })).data;
  }
  const release_id = release.id;
  // A failed run leaves a draft. A retry replaces only that draft's assets;
  // nothing becomes public until every verified file has been uploaded.
  const existing = await github.paginate(github.rest.repos.listReleaseAssets, { ...repo, release_id, per_page: 100 });
  for (const asset of existing) await github.rest.repos.deleteReleaseAsset({ ...repo, asset_id: asset.id });
  for (const name of files) {
    const data = fs.readFileSync(path.join(directory, name));
    await github.rest.repos.uploadReleaseAsset({ ...repo, release_id, name, data,
      headers: { 'content-type': 'application/octet-stream', 'content-length': String(data.length) } });
  }
  await github.rest.repos.updateRelease({ ...repo, release_id, draft: false, prerelease,
    make_latest: prerelease ? 'false' : 'legacy' });
}

module.exports = { validateTag, expectedAssets, verifyAssets, publishRelease };
if (require.main === module) {
  try {
    if (process.argv[2] !== 'validate-tag') throw new Error('Usage: node scripts/release.cjs validate-tag');
    const { version } = require('../package.json');
    if (process.env.RELEASE_TAG) validateTag(process.env.RELEASE_TAG, version);
    console.log(process.env.RELEASE_TAG ? `Validated ${process.env.RELEASE_TAG}` : 'Build only: no release tag.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
