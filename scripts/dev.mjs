import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';

const root = new URL('../', import.meta.url);
const children = new Set();
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  process.exitCode = code;
}
function launch(command, args) {
  const child = spawn(command, args, { cwd: root, stdio: 'inherit' });
  children.add(child);
  child.on('error', error => { console.error(error.message); stop(1); });
  child.on('exit', code => { children.delete(child); if (!stopping) stop(code || 1); });
}
function portInUse(port) {
  return new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(1000);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
    socket.once('timeout', () => { socket.destroy(); resolve(true); });
  });
}

if (await portInUse(5173)) {
  console.error('端口 5173 已占用。请检查并复用现有随弦服务。');
  process.exitCode = 1;
} else {
  let omrRunning = false;
  if (await portInUse(5174)) {
    const health = await fetch('http://127.0.0.1:5174/api/health', { signal: AbortSignal.timeout(2000) }).then(r => r.json()).catch(() => null);
    if (health?.service !== 'suixian-omr') {
      console.error('端口 5174 被其他服务占用，请先检查该进程。');
      process.exitCode = 1;
    } else omrRunning = true;
  }
  if (!process.exitCode) {
    if (!omrRunning) launch('python3', ['server/omr_service.py']);
    launch(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5173', '--strictPort']);
    process.on('SIGINT', () => stop());
    process.on('SIGTERM', () => stop());
  }
}
