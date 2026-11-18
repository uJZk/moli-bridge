const mode = process.env.MOLI_MODE ?? 'bridge';
const port = mode === 'bridge' ? (process.env.BRIDGE_PORT ?? '8191') : mode === 'cdp' ? (process.env.CDP_PORT ?? '9222') : undefined;
if (!port) process.exit(1);
try {
  const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) });
  const body = await response.json();
  if (!response.ok || body.status !== 'ok') process.exitCode = 1;
} catch {
  process.exitCode = 1;
}
