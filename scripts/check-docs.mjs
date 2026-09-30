import { readdir, readFile } from 'node:fs/promises';
const files = ['AGENTS.md'];
async function walk(dir) { for (const e of await readdir(dir, { withFileTypes: true })) { const p = `${dir}/${e.name}`; if (e.isDirectory()) await walk(p); else if (p.endsWith('.md')) files.push(p); } }
await walk('docs');
let bad = false;
for (const file of files) { const text = await readFile(file, 'utf8'); const n = text.trimEnd().split('\n').length; if (n > 150) { console.error(`${file}: ${n} lines (limit 150)`); bad = true; } }
if (bad) process.exitCode = 1; else console.log(`${files.length} documents checked; all within 150 lines.`);
