import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { auditDistribution, buildArchive } from '../release.mjs';
import { gunzipSync } from 'node:zlib';
const release = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const parent = process.env.WORKSPACE_UI_UPSTREAM
  ? path.join(process.env.WORKSPACE_UI_UPSTREAM, '.cache')
  : path.resolve(release, '../../.cache');
fs.mkdirSync(parent, { recursive: true });
test('the public distribution has no unlisted content or private runtime dependencies', () => {
  assert.ok(auditDistribution(release).length > 60);
});
test('detects tampering, accidental artifacts and non-example personal paths', () => {
  const root = fs.mkdtempSync(path.join(parent, 'workspace-ui-release-audit-'));
  try {
    for (const relative of JSON.parse(fs.readFileSync(path.join(release, 'release-files.json')))) {
      const file = path.join(root, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.copyFileSync(path.join(release, relative), file);
    }
    const relative = 'payload/web/workspace/index.html',
      file = path.join(root, relative),
      original = fs.readFileSync(file);
    fs.appendFileSync(file, 'tampered');
    assert.throws(() => auditDistribution(root), /checksum/);
    fs.writeFileSync(file, original);
    fs.writeFileSync(path.join(root, 'accidental-notes.txt'), 'private');
    assert.throws(() => auditDistribution(root), /Unlisted/);
    fs.unlinkSync(path.join(root, 'accidental-notes.txt'));
    fs.appendFileSync(file, ['', 'Users', 'alice', 'private', ''].join('/'));
    const checksums = JSON.parse(fs.readFileSync(path.join(root, 'checksums.json')));
    checksums[relative] = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    fs.writeFileSync(path.join(root, 'checksums.json'), JSON.stringify(checksums));
    assert.throws(() => auditDistribution(root), /Non-example home path/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('archive headers contain only allowlisted files and normalized public metadata', () => {
  const files = auditDistribution(release);
  const packed = buildArchive(files, release);
  assert.deepEqual(buildArchive(files, release), packed);
  const tar = gunzipSync(packed), names = [];
  for (let offset = 0; offset < tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const text = (start, length) => header.toString('utf8', start, start + length).replace(/\0.*$/s, '');
    const prefix = text(345, 155), name = (prefix ? prefix + '/' : '') + text(0, 100);
    const size = parseInt(text(124, 12), 8);
    assert.equal(text(265, 32), 'root'); assert.equal(text(297, 32), 'root');
    assert.equal(parseInt(text(108, 8), 8), 0); assert.equal(parseInt(text(116, 8), 8), 0);
    assert.equal(parseInt(text(136, 12), 8), 0); assert.equal(text(156, 1), '0');
    assert.deepEqual(tar.subarray(offset + 512, offset + 512 + size), fs.readFileSync(path.join(release, name)));
    names.push(name); offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.deepEqual(names, files);
});
