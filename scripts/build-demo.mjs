#!/usr/bin/env node
// Builds demo/out/showcase.html: one self-contained page that runs the real extension
// popup + controller code (embedded unchanged as blob: modules) against SIMULATED data.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ext = path.join(root, 'extension');
const read = (p) => fs.readFileSync(p, 'utf8');

// Collect modules and their relative imports.
const files = {
  ...Object.fromEntries(fs.readdirSync(path.join(ext, 'lib')).filter((f) => f.endsWith('.js')).map((f) => [`lib/${f}`, path.join(ext, 'lib', f)])),
  'popup/summary.js': path.join(ext, 'popup', 'summary.js'),
  'demo/harness.js': path.join(root, 'demo', 'harness.js'),
};
const sources = {};
const deps = {};
for (const [key, file] of Object.entries(files)) {
  const dir = path.posix.dirname(key);
  deps[key] = [];
  sources[key] = read(file).replace(/(from\s+|import\s*\(\s*)'(\.{1,2}\/[^']+)'/g, (m, pre, spec) => {
    const target = path.posix.normalize(path.posix.join(dir, spec));
    if (!files[target]) throw new Error(`${key}: unknown import ${spec}`);
    deps[key].push(target);
    return `${pre}'__MOD__${target}'`;
  });
}
const order = [];
const visit = (k, stack = []) => {
  if (order.includes(k)) return;
  if (stack.includes(k)) throw new Error(`import cycle: ${[...stack, k].join(' -> ')}`);
  for (const d of deps[k]) visit(d, [...stack, k]);
  order.push(k);
};
Object.keys(files).forEach((k) => visit(k));

const popupHtml = read(path.join(ext, 'popup', 'summary.html'))
  .replace('<link rel="stylesheet" href="summary.css">', `<style>${read(path.join(ext, 'popup', 'summary.css'))}</style>`)
  .replace('<script type="module" src="summary.js"></script>', '<script>window.browser = parent.__mockBrowser;</script><script type="module" src="__POPUP_JS__"></script>');
const icon = `data:image/svg+xml;base64,${Buffer.from(read(path.join(ext, 'icons', 'preyt.svg'))).toString('base64')}`;
// JSON is not safe inside <script> as-is: escape "<" so "</script>" in sources cannot end the tag.
const js = (v) => JSON.stringify(v).replace(/</g, '\\u003c');
const html = read(path.join(root, 'demo', 'showcase.template.html'))
  .replaceAll('__ICON__', icon)
  .replace('__MODULE_SOURCES__', () => js(sources))
  .replace('__MODULE_ORDER__', () => js(order))
  .replace('__POPUP_HTML__', () => js(popupHtml));
fs.mkdirSync(path.join(root, 'demo', 'out'), { recursive: true });
fs.writeFileSync(path.join(root, 'demo', 'out', 'showcase.html'), html);
console.log(`demo/out/showcase.html (${(html.length / 1024).toFixed(0)} KiB, modules: ${order.join(', ')})`);
