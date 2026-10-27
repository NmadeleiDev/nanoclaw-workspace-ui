#!/usr/bin/env node
import { auditDistribution } from './release.mjs';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const release = path.dirname(fileURLToPath(import.meta.url));
auditDistribution(release);
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 18)) throw Error('Use Node 22.18 or newer; Node 24 LTS is recommended.');
const args = process.argv.slice(2);
const targetArg = args.indexOf('--target');
const mode = args.find((a) => ['--check', '--apply', '--remove', '--check-remove'].includes(a)) ?? '--check';
if (targetArg < 0 || !args[targetArg + 1])
  throw Error('Usage: node install.mjs --target /path/to/nanoclaw [--check|--apply|--check-remove|--remove]');
const target = fs.realpathSync(path.resolve(args[targetArg + 1]));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const read = (file) => fs.readFileSync(file);
const stateDir = path.join(target, '.nanoclaw/addons/workspace-ui');
const statePath = path.join(stateDir, 'state.json');
const manifest = JSON.parse(read(path.join(release, 'manifest.json')));
const compatibility = JSON.parse(read(path.join(release, 'compatibility.json')));
const safe = (relative) => {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).some((p) => !p || p === '.' || p === '..'))
    throw Error(`Unsafe path: ${relative}`);
  let current = target;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw Error(`Refusing symlink: ${relative}`);
  }
  return path.join(target, relative);
};
if (
  !fs.existsSync(path.join(target, 'src/index.ts')) ||
  !fs.existsSync(path.join(target, 'container/agent-runner/src/index.ts'))
)
  throw Error('Choose an installed NanoClaw v2 source checkout.');
const currentState = fs.existsSync(statePath) ? JSON.parse(read(statePath)) : null;
const git = (patch, reverse = false, check = true) =>
  spawnSync(
    'git',
    ['apply', ...(reverse ? ['--reverse'] : []), ...(check ? ['--check'] : []), path.join(release, patch)],
    { cwd: target, encoding: 'utf8' },
  );
const patches = currentState?.patches ?? [
  'integration.patch',
  ...(fs.existsSync(path.join(target, 'container/agent-runner/src/providers/opencode.ts'))
    ? ['optional/opencode.patch']
    : []),
];
const patchPaths = (patch) =>
  [
    ...read(path.join(release, patch))
      .toString()
      .matchAll(/^diff --git a\/(.+) b\/.+$/gm),
  ].map((m) => m[1]);
const modified = [...new Set(patches.flatMap(patchPaths))];
for (const relative of [
  ...manifest,
  ...modified,
  'package.json',
  'pnpm-workspace.yaml',
  '.gitignore',
  '.nanoclaw/addons/workspace-ui/state.json',
])
  safe(relative);
const scripts = {
  'workspace:build': 'pnpm --dir web/workspace run build',
  'workspace:build-native': 'sh scripts/build-workspace-native.sh',
  'workspace:preview': 'tsx scripts/workspace-preview.ts',
};
const dependencies = { 'web-push': '3.6.7' };
const devDependencies = { '@types/web-push': '3.6.4', vitest: '4.1.12' };
const ignores = ['web/workspace/dist/', '.workspace-preview*/', '.cache/'];
const YAML = createRequire(path.join(target, 'package.json'))('yaml');
const packagePath = safe('package.json'),
  workspacePath = safe('pnpm-workspace.yaml'),
  ignorePath = safe('.gitignore');
let pkg = JSON.parse(read(packagePath)),
  workspace = YAML.parseDocument(read(workspacePath).toString()),
  ignore = read(ignorePath).toString();
const savedFields = [];
for (const [section, values] of Object.entries({ scripts, dependencies, devDependencies }))
  for (const [name, value] of Object.entries(values)) {
    const prior = pkg[section]?.[name];
    if (currentState && mode.includes('remove')) {
      if (prior !== value) throw Error(`Preserve your changed package setting before removal: ${section}.${name}`);
    } else if (
      !currentState &&
      prior !== undefined &&
      prior !== value &&
      !(section === 'devDependencies' && name === 'vitest' && ['^4.1.11', '^4.1.12'].includes(prior))
    )
      throw Error(`Existing package setting conflicts: ${section}.${name}`);
    savedFields.push({ section, name, prior: prior ?? null });
  }
if (currentState) {
  if (JSON.stringify(Object.keys(currentState.owned).sort()) !== JSON.stringify([...manifest].sort()))
    throw Error(
      'This release changed its owned file list without a versioned migration. Use the original installer for removal.',
    );
  if (currentState.version !== compatibility.version)
    throw Error('Install state belongs to a different add-on version; use its installer for removal.');
  for (const [rel, expected] of Object.entries(currentState.owned))
    if (!fs.existsSync(safe(rel)) || hash(read(safe(rel))) !== expected)
      throw Error(`Owned source changed; reconcile it before proceeding: ${rel}`);
  for (const patch of patches) {
    const result = git(patch, true);
    if (result.status !== 0)
      throw Error(`Integration changed; reconcile before proceeding: ${patch}\n${result.stderr}`);
  }
  if (!mode.includes('remove')) {
    console.log('Workspace UI is installed; owned source and integration checks passed.');
    process.exit(0);
  }
} else {
  if (mode.includes('remove')) throw Error('No Workspace UI installation state exists in this target.');
  for (const rel of manifest)
    if (fs.existsSync(safe(rel))) throw Error(`Refusing to overwrite existing source: ${rel}`);
  for (const patch of patches) {
    const result = git(patch);
    if (result.status !== 0)
      throw Error(
        `Unsupported core/provider revision; no files changed. Tested upstream: ${compatibility.upstreamCommit}\n${result.stderr}`,
      );
  }
}
if (mode === '--check' || mode === '--check-remove') {
  console.log(
    `Preflight passed (${mode}); no files changed. ${manifest.length} owned files, ${modified.length} patched files. Docker only.`,
  );
  process.exit(0);
}
// Applying source under a running host can expose a mixed runner version.
const socket = path.join(target, 'data/ncl.sock');
if (fs.existsSync(socket)) {
  const listening = await new Promise((resolve) => {
    const client = net.connect(socket);
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      client.destroy();
      resolve(v);
    };
    client.setTimeout(500, () => finish(true));
    client.on('connect', () => finish(true));
    client.on('error', () => finish(false));
  });
  if (listening)
    throw Error(
      'Stop this target’s NanoClaw host before changing installed source. The installer never stops services.',
    );
}
const removing = mode === '--remove';
let installState;
const touched = [...manifest, ...modified, 'package.json', 'pnpm-workspace.yaml', '.gitignore'];
const backup = new Map(touched.map((rel) => [rel, fs.existsSync(safe(rel)) ? read(safe(rel)) : null]));
try {
  if (removing) {
    for (const patch of [...patches].reverse()) {
      const result = git(patch, true, false);
      if (result.status !== 0) throw Error(result.stderr);
    }
    for (const rel of manifest) fs.unlinkSync(safe(rel));
    for (const { section, name, prior } of currentState.fields) {
      if (prior === null) delete pkg[section][name];
      else pkg[section][name] = prior;
    }
    if (currentState.addedWorkspace) {
      const list = workspace.get('packages');
      list.items = list.items.filter((item) => String(item) !== 'web/workspace');
      if (currentState.hadPackages === false && !list.items.length) workspace.delete('packages');
    }
    ignore = ignore
      .split('\n')
      .filter((line) => !currentState.addedIgnores.includes(line))
      .join('\n');
  } else {
    for (const patch of patches) {
      const result = git(patch, false, false);
      if (result.status !== 0) throw Error(result.stderr);
    }
    for (const rel of manifest) {
      const destination = safe(rel);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, read(path.join(release, 'payload', rel)));
    }
    for (const [section, values] of Object.entries({ scripts, dependencies, devDependencies }))
      pkg[section] = { ...pkg[section], ...values };
    const list = workspace.get('packages');
    const addedWorkspace = !list?.items.some((item) => String(item) === 'web/workspace');
    const hadPackages = !!list;
    if (!list) workspace.set('packages', ['web/workspace']);
    else if (addedWorkspace) list.add('web/workspace');
    const addedIgnores = ignores.filter((line) => !ignore.split('\n').includes(line));
    ignore += '\n' + addedIgnores.join('\n') + '\n';
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    installState = {
      version: compatibility.version,
      patches,
      owned: Object.fromEntries(manifest.map((rel) => [rel, hash(read(safe(rel)))])),
      fields: savedFields,
      hadPackages,
      addedWorkspace,
      addedIgnores,
      originals: Object.fromEntries(
        ['package.json', 'pnpm-workspace.yaml', '.gitignore'].map((rel) => [rel, backup.get(rel).toString('base64')]),
      ),
    };
  }
  fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n');
  fs.writeFileSync(workspacePath, String(workspace));
  fs.writeFileSync(ignorePath, ignore);
  if (removing) {
    for (const [rel, original] of Object.entries(currentState.originals))
      if (hash(backup.get(rel)) === currentState.metadataHashes[rel])
        fs.writeFileSync(safe(rel), Buffer.from(original, 'base64'));
    fs.unlinkSync(statePath);
  } else {
    installState.metadataHashes = Object.fromEntries(
      ['package.json', 'pnpm-workspace.yaml', '.gitignore'].map((rel) => [rel, hash(read(safe(rel)))]),
    );
    fs.writeFileSync(statePath, JSON.stringify(installState, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  }
  console.log(
    removing
      ? 'Workspace UI source removed. Provider modules and all user databases, attachments and configuration data retained.'
      : 'Workspace UI source installed. Update the lockfile, install with --frozen-lockfile, build and test before restarting your host.',
  );
} catch (error) {
  for (const [rel, bytes] of backup) {
    const file = safe(rel);
    if (bytes === null) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes);
    }
  }
  if (!currentState && fs.existsSync(statePath)) fs.unlinkSync(statePath);
  throw error;
}
