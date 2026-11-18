// Moli's tracing output may contain ANSI formatting, including in containers.
export function listeningAddress(output) {
  const plain = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  const match = plain.match(/protocol server listening addr=127\.0\.0\.1:(\d+)/);
  return match ? `http://127.0.0.1:${match[1]}` : undefined;
}
