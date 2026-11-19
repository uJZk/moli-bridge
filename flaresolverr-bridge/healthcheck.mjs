const mode = process.env.MOLI_MODE ?? 'both';
const ports = mode === 'both' ? [process.env.BRIDGE_PORT ?? '8191', process.env.CDP_PORT ?? '9222']
  : mode === 'bridge' ? [process.env.BRIDGE_PORT ?? '8191']
  : mode === 'cdp' ? [process.env.CDP_PORT ?? '9222'] : [];
if (!ports.length) process.exit(1);
const healthy = await Promise.all(ports.map(async port => {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) });
    const body = await response.json();
    return response.ok && body.status === 'ok';
  } catch {
    return false;
  }
}));
if (!healthy.every(Boolean)) process.exitCode = 1;
