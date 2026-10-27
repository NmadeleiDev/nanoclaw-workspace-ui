import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const release = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const upstream = process.env.WORKSPACE_UI_UPSTREAM ?? path.resolve(release, '../..');
const commit = JSON.parse(fs.readFileSync(path.join(release, 'compatibility.json'))).upstreamCommit;
const manifest = JSON.parse(fs.readFileSync(path.join(release, 'manifest.json')));
fs.mkdirSync(path.join(upstream, '.cache'), { recursive: true });
function fixture() {
  const root = fs.mkdtempSync(path.join(upstream, '.cache/workspace-ui-install-'));
  const archive = execFileSync('git', ['-C', upstream, 'archive', commit], { maxBuffer: 100 * 1024 * 1024 });
  const unpack = spawnSync('tar', ['-xf', '-', '-C', root], { input: archive });
  assert.equal(unpack.status, 0);
  execFileSync('git', ['init', '-q', root]);
  fs.symlinkSync(path.join(upstream, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  return root;
}
const invoke = (root, mode = '--check') =>
  spawnSync(process.execPath, [path.join(release, 'install.mjs'), '--target', root, mode], { encoding: 'utf8' });
function ok(result) {
  assert.equal(result.status, 0, result.stdout + result.stderr);
}
function snapshot(root) {
  const files = [
    ...manifest,
    'package.json',
    'pnpm-workspace.yaml',
    '.gitignore',
    ...fs.readFileSync(path.join(release, 'integration.patch'), 'utf8').matchAll(/^diff --git a\/(.+) b\/.+$/gm),
  ].map((v) => (typeof v === 'string' ? v : v[1]));
  return Object.fromEntries(
    [...new Set(files)].map((rel) => [
      rel,
      fs.existsSync(path.join(root, rel))
        ? createHash('sha256')
            .update(fs.readFileSync(path.join(root, rel)))
            .digest('hex')
        : null,
    ]),
  );
}
test('clean upstream install, idempotency, and byte-exact source removal', () => {
  const root = fixture();
  try {
    const original = snapshot(root);
    ok(invoke(root));
    assert.deepEqual(snapshot(root), original);
    ok(invoke(root, '--apply'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).devDependencies.vitest, '4.1.12');
    const installed = snapshot(root);
    ok(invoke(root, '--apply'));
    assert.deepEqual(snapshot(root), installed);
    assert.equal(fs.existsSync(path.join(root, 'src/execution')), false);
    assert.equal(fs.existsSync(path.join(root, 'src/providers/opencode.ts')), false);
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data/user-work.txt'), 'keep this');
    ok(invoke(root, '--check-remove'));
    ok(invoke(root, '--remove'));
    assert.deepEqual(snapshot(root), original);
    assert.equal(fs.readFileSync(path.join(root, 'data/user-work.txt'), 'utf8'), 'keep this');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('refuses source collisions and incompatible patches before changing files', () => {
  const root = fixture();
  try {
    const rel = manifest[0],
      file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'operator file');
    const before = snapshot(root);
    assert.notEqual(invoke(root, '--apply').status, 0);
    assert.deepEqual(snapshot(root), before);
    fs.unlinkSync(file);
    fs.writeFileSync(path.join(root, 'src/container-runner.ts'), 'incompatible upstream');
    const changed = snapshot(root);
    assert.notEqual(invoke(root, '--apply').status, 0);
    assert.deepEqual(snapshot(root), changed);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('removal protects edited owned files and preserves unrelated package/core edits', () => {
  const root = fixture();
  try {
    ok(invoke(root, '--apply'));
    const file = path.join(root, manifest[0]),
      original = fs.readFileSync(file);
    fs.appendFileSync(file, '\n// operator edit\n');
    const edited = snapshot(root);
    assert.notEqual(invoke(root, '--remove').status, 0);
    assert.deepEqual(snapshot(root), edited);
    fs.writeFileSync(file, original);
    const pkgFile = path.join(root, 'package.json'),
      pkg = JSON.parse(fs.readFileSync(pkgFile));
    pkg.scripts['operator-task'] = 'echo preserved';
    fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
    const router = path.join(root, 'src/router.ts');
    fs.writeFileSync(router, '// unrelated operator customization\n' + fs.readFileSync(router, 'utf8'));
    ok(invoke(root, '--remove'));
    assert.equal(JSON.parse(fs.readFileSync(pkgFile)).scripts['operator-task'], 'echo preserved');
    assert.match(fs.readFileSync(path.join(root, 'src/router.ts'), 'utf8'), /unrelated operator customization/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('rejects symlinked destination directories', () => {
  const root = fixture();
  try {
    const outside = path.join(root, '.cache-safe');
    fs.mkdirSync(outside);
    fs.mkdirSync(path.join(root, 'web'));
    fs.symlinkSync(outside, path.join(root, 'web/workspace'), 'dir');
    assert.notEqual(invoke(root, '--apply').status, 0);
    assert.deepEqual(fs.readdirSync(outside), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('optional OpenCode patch preserves provider ownership on removal', () => {
  const root = fixture();
  try {
    const provider = path.join(root, '.claude/skills/add-opencode/payload');
    for (const rel of [
      'src/providers/opencode.ts',
      'container/agent-runner/src/providers/opencode-config.ts',
      'container/agent-runner/src/providers/opencode.ts',
      'container/agent-runner/src/providers/opencode-turn.ts',
    ]) {
      const destination = path.join(root, rel);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(provider, rel), destination);
    }
    const paths = [
      'src/providers/opencode.ts',
      'container/agent-runner/src/providers/opencode-config.ts',
      'container/agent-runner/src/providers/opencode.ts',
      'container/agent-runner/src/providers/opencode-turn.ts',
    ];
    const original = Object.fromEntries(paths.map((rel) => [rel, fs.readFileSync(path.join(root, rel))]));
    ok(invoke(root, '--apply'));
    assert.match(fs.readFileSync(path.join(root, paths[1]), 'utf8'), /OPENCODE_API_TYPE/);
    ok(invoke(root, '--remove'));
    for (const rel of paths) assert.deepEqual(fs.readFileSync(path.join(root, rel)), original[rel]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('refuses to change source while the target host socket is listening', async () => {
  const root = fixture();
  const server = net.createServer((socket) => socket.end());
  try {
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    await new Promise((resolve) => server.listen(path.join(root, 'data/ncl.sock'), resolve));
    const before = snapshot(root);
    const result = invoke(root, '--apply');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Stop this target/);
    assert.deepEqual(snapshot(root), before);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
