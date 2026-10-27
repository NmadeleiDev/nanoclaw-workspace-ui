#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
const root = path.dirname(fileURLToPath(import.meta.url));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function auditDistribution(directory = root) {
  const files = JSON.parse(fs.readFileSync(path.join(directory, 'release-files.json'), 'utf8'));
  const checksums = JSON.parse(fs.readFileSync(path.join(directory, 'checksums.json'), 'utf8'));
  const source = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  if (new Set(files).size !== files.length) throw Error('Duplicate release entries.');
  for (const relative of files) {
    if (relative.startsWith('-') || path.isAbsolute(relative) || relative.split(/[\\/]/).some((v) => !v || v === '.' || v === '..'))
      throw Error('Unsafe release path.');
    if (/(^|\/)(?:data|groups|logs|node_modules|\.cache|\.env[^/]*|\.workspace-preview[^/]*)(\/|$)/.test(relative))
      throw Error(`Private or generated release path: ${relative}`);
    const file = path.join(directory, relative);
    if (fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile())
      throw Error(`Release entry must be a regular file: ${relative}`);
    const bytes = fs.readFileSync(file);
    if (relative !== 'checksums.json' && checksums[relative] !== digest(bytes))
      throw Error(`Release checksum mismatch: ${relative}`);
    if (relative.endsWith('.png')) continue;
    const text = bytes.toString('utf8');
    if (/\/(?:Users|home)\/(?!example(?:[-/]|$)|sample(?:\/|$)|test(?:\/|$))[\w.-]+\//.test(text))
      throw Error(`Non-example home path in ${relative}`);
    if (/\.tail[0-9a-f]{6,}\.ts\.net/i.test(text)) throw Error(`Installation-specific tailnet in ${relative}`);
    if (
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{25,}|AKIA[A-Z0-9]{16})\b/.test(
        text,
      )
    )
      throw Error(`Credential signature in ${relative}`);
    if (
      relative.startsWith('payload/') &&
      /\.(?:ts|tsx|js|css|swift)$/.test(relative) &&
      /runtimeLayout|native-macos|sandbox-exec|from ['"][^'"]*\/execution\//.test(text)
    )
      throw Error(`Private runtime dependency in ${relative}`);
  }
  for (const relative of source)
    if (!files.includes('payload/' + relative)) throw Error(`Installed source missing from release list: ${relative}`);
  for (const relative of files.filter((file) => file.endsWith('.patch'))) {
    const additions = fs
      .readFileSync(path.join(directory, relative), 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
      .join('\n');
    if (/runtimeLayout|native-macos|sandbox-exec|['"][^'"]*\/execution(?:\/|\.js)/.test(additions))
      throw Error(`Private runtime hook in ${relative}`);
  }
  const walk = (directoryPath, prefix = '') => {
    for (const item of fs.readdirSync(directoryPath, { withFileTypes: true })) {
      if (!prefix && ['.git', 'dist'].includes(item.name)) continue;
      const relative = prefix + item.name;
      if (item.isSymbolicLink()) throw Error(`Symlink in distribution: ${relative}`);
      if (item.isDirectory()) walk(path.join(directoryPath, item.name), relative + '/');
      else if (!files.includes(relative)) throw Error(`Unlisted distribution file: ${relative}`);
    }
  };
  walk(directory);
  return files;
}
/** Regular-file-only USTAR: fixed ownership/modes/timestamps, no host metadata. */
export function buildArchive(files, directory = root) {
  const blocks = [];
  for (const relative of files) {
    const data = fs.readFileSync(path.join(directory, relative));
    const header = Buffer.alloc(512);
    const field = (value, offset, length) => {
      if (Buffer.byteLength(value) > length) throw Error(`Archive field too long: ${relative}`);
      header.write(value, offset, length, 'utf8');
    };
    let name = relative, prefix = '';
    if (Buffer.byteLength(name) > 100) {
      const slash = relative.lastIndexOf('/');
      prefix = relative.slice(0, slash); name = relative.slice(slash + 1);
    }
    field(name, 0, 100); field(prefix, 345, 155);
    const octal = (value, offset, length) => field(value.toString(8).padStart(length - 1, '0') + '\0', offset, length);
    octal(0o644, 100, 8); octal(0, 108, 8); octal(0, 116, 8);
    octal(data.length, 124, 12); octal(0, 136, 12);
    header.fill(32, 148, 156); field('0', 156, 1); field('ustar\0', 257, 6); field('00', 263, 2);
    field('root', 265, 32); field('root', 297, 32);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    field(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    blocks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks), { level: 9 });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2] ?? '--check';
  if (mode === '--refresh') {
    const files = JSON.parse(fs.readFileSync(path.join(root, 'release-files.json'), 'utf8'));
    fs.writeFileSync(
      path.join(root, 'checksums.json'),
      JSON.stringify(
        Object.fromEntries(
          files.filter((f) => f !== 'checksums.json').map((f) => [f, digest(fs.readFileSync(path.join(root, f)))]),
        ),
        null,
        2,
      ) + '\n',
    );
  }
  const files = auditDistribution();
  if (mode === '--build') {
    const { version } = JSON.parse(fs.readFileSync(path.join(root, 'compatibility.json'), 'utf8'));
    const out = path.join(root, 'dist');
    fs.mkdirSync(out, { recursive: true });
    const name = `workspace-ui-${version}.tar.gz`,
      archive = path.join(out, name);
    fs.writeFileSync(archive, buildArchive(files));
    fs.writeFileSync(archive + '.sha256', digest(fs.readFileSync(archive)) + '  ' + name + '\n');
    console.log(`Built ${archive} (${files.length} allowlisted files)`);
  } else console.log(`Distribution checks passed (${files.length} files).`);
}
