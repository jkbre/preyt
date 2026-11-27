#!/usr/bin/env node
// Builds dist/preyt-<v>.xpi (unsigned) and dist/SHA256SUMS.
// Reproducible: fixed file order and mtimes (SOURCE_DATE_EPOCH, default 2026-11-19).
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension', 'manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const VERSION = manifest.version;
if (pkg.version !== VERSION) throw new Error(`package.json version ${pkg.version} != manifest ${VERSION}`);
const epoch = Number(process.env.SOURCE_DATE_EPOCH || Date.UTC(2026, 10, 19) / 1000);
const stamp = new Date(epoch * 1000);

function listFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

function copyTree(src, dst) {
  for (const f of listFiles(src)) {
    const to = path.join(dst, path.relative(src, f));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(f, to);
  }
}

function touchAll(dir) {
  for (const f of listFiles(dir)) fs.utimesSync(f, stamp, stamp);
  const dirs = [dir];
  for (let i = 0; i < dirs.length; i++) {
    for (const e of fs.readdirSync(dirs[i], { withFileTypes: true })) if (e.isDirectory()) dirs.push(path.join(dirs[i], e.name));
  }
  for (const d of dirs.reverse()) fs.utimesSync(d, stamp, stamp);
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

fs.rmSync(dist, { recursive: true, force: true });
const stage = path.join(dist, 'stage');

// ---- XPI ---------------------------------------------------------------------
const extStage = path.join(stage, 'extension');
copyTree(path.join(root, 'extension'), extStage);
touchAll(extStage);
const xpi = path.join(dist, `preyt-${VERSION}.xpi`);
const rel = listFiles(extStage).map((f) => path.relative(extStage, f));
execFileSync('zip', ['-X', '-D', '-q', '-9', xpi, ...rel], { cwd: extStage, env: { ...process.env, TZ: 'UTC' } });

fs.rmSync(stage, { recursive: true, force: true });
const sums = [xpi].map((f) => `${sha256(f)}  ${path.basename(f)}`).join('\n') + '\n';
fs.writeFileSync(path.join(dist, 'SHA256SUMS'), sums);
process.stdout.write(`Built (unsigned):\n${sums}`);
