import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Both entry points keep their own Moli processes; the container shares resources.
export function supervise({ spawnChild = spawn, runtime = process, timeout = 8000 } = {}) {
  const children = ['/app/server.mjs', '/app/cdp-gateway.mjs'].map(file =>
    spawnChild(runtime.execPath, [file], { stdio: 'inherit', env: runtime.env }));
  let stopping = false;
  let exitCode = 0;
  let timer;
  const live = new Set(children);
  function stop(code) {
    exitCode ||= code;
    if (stopping) return;
    stopping = true;
    for (const child of live) child.kill('SIGTERM');
    if (live.size) {
      timer = setTimeout(() => { for (const child of live) child.kill('SIGKILL'); }, timeout);
      timer.unref();
    }
  }
  for (const child of children) {
    child.once('error', error => { console.error('Service startup failed:', error.message); stop(1); });
    child.once('close', () => {
      live.delete(child);
      if (!stopping) stop(1);
      if (!live.size) { clearTimeout(timer); runtime.exitCode = exitCode; }
    });
  }
  runtime.once('SIGTERM', () => stop(0));
  runtime.once('SIGINT', () => stop(0));
  return { children, stop };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) supervise();
