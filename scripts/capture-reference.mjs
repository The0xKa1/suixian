/** Archive only the reference site's publicly served frontend assets. Never execute them. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(projectRoot, 'references/weeksync');
const pageUrl = 'https://weeksync.app/?ref=onepagelove';
const origin = new URL(pageUrl).origin;
const entries = new Map();
const skipped = new Set();

await mkdir(output, { recursive: true });

function publicUrl(value, base) {
  if (!value || /^(data:|blob:|#)/i.test(value)) return null;
  const url = new URL(value.replaceAll('&amp;', '&'), base);
  if (url.origin !== origin) {
    skipped.add(url.href);
    return null;
  }
  url.hash = '';
  return url.href;
}

function localPath(url, kind) {
  if (kind === 'html') return 'index.html';
  const { pathname, search } = new URL(url);
  const query = search ? `-${createHash('sha256').update(search).digest('hex').slice(0, 8)}` : '';
  const extension = extname(pathname);
  const base = pathname.slice(1, extension ? -extension.length : undefined);
  return `assets/${base}${query}${extension}`;
}

async function capture(url, kind) {
  if (entries.has(url)) return entries.get(url);
  const entry = { url, kind, path: localPath(url, kind), status: 'pending' };
  entries.set(url, entry);
  const target = join(output, entry.path);
  await mkdir(dirname(target), { recursive: true });
  try {
    if (kind === 'html' && process.argv.includes('--reuse-html')) {
      await readFile(target);
      entry.httpStatus = 200;
      entry.reused = true;
    } else {
      const result = await exec('curl', [
        '--fail', '--location', '--silent', '--show-error', '--max-time', '45',
        '--write-out', '%{http_code}', '--output', target, url,
      ], { maxBuffer: 1024 * 1024 });
      entry.httpStatus = Number(result.stdout.trim());
    }
    const data = await readFile(target);
    entry.bytes = data.length;
    entry.sha256 = createHash('sha256').update(data).digest('hex');
    entry.status = 'downloaded';
    return entry;
  } catch (error) {
    entry.status = 'failed';
    entry.error = String(error.stderr || error.message).trim();
    return entry;
  }
}

async function batch(items) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(queue.length, 4) }, async () => {
    while (queue.length) {
      const [url, kind] = queue.shift();
      await capture(url, kind);
    }
  });
  await Promise.all(workers);
}

const page = await capture(pageUrl, 'html');
if (page.status !== 'downloaded') throw new Error(page.error);
const html = await readFile(join(output, page.path), 'utf8');
const firstPass = new Map();
for (const match of html.matchAll(/<(script|link)\b[^>]*>/gi)) {
  const attributes = Object.fromEntries(
    [...match[0].matchAll(/([\w-]+)=["']([^"']*)["']/g)].map((a) => [a[1].toLowerCase(), a[2]]),
  );
  const value = attributes.src || attributes.href;
  const kind = match[1] === 'script' || attributes.as === 'script'
    ? 'javascript'
    : attributes.rel === 'stylesheet' ? 'stylesheet' : attributes.as === 'font' ? 'font' : null;
  if (!kind) continue;
  const url = publicUrl(value, pageUrl);
  if (url) firstPass.set(url, kind);
}
await batch(firstPass);

const discovered = new Map();
for (const entry of [...entries.values()]) {
  if (entry.status !== 'downloaded' || !['stylesheet', 'javascript'].includes(entry.kind)) continue;
  const content = await readFile(join(output, entry.path), 'utf8');
  if (entry.kind === 'stylesheet') {
    for (const match of content.matchAll(/url\(\s*["']?([^"')\s]+)["']?\s*\)/g)) {
      const url = publicUrl(match[1], entry.url);
      if (url && /\.(woff2?|ttf|otf)(\?|$)/i.test(url)) discovered.set(url, 'font');
    }
  }
  for (const match of content.matchAll(/[#@]\s*sourceMappingURL=([^\s*]+)/g)) {
    const url = publicUrl(match[1], entry.url);
    if (url) discovered.set(url, 'declared-source-map');
  }
}
await batch(discovered);

const manifest = {
  capturedAt: new Date().toISOString(),
  pageUrl,
  scope: 'Public HTML, explicitly linked same-origin CSS/JS, CSS fonts, and declared source maps only.',
  limitation: 'Production bundles are not the original development repository. Scripts were downloaded without execution.',
  skippedCrossOrigin: [...skipped].sort(),
  assets: [...entries.values()].sort((a, b) => a.path.localeCompare(b.path)),
};
await writeFile(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
const downloaded = manifest.assets.filter((entry) => entry.status === 'downloaded');
const failed = manifest.assets.filter((entry) => entry.status === 'failed');
console.log(JSON.stringify({ downloaded: downloaded.length, failed: failed.length, bytes: downloaded.reduce((n, entry) => n + entry.bytes, 0) }));
if (failed.length) process.exitCode = 1;
