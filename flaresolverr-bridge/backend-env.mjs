// Only normalize the backend's default timezone. An explicit CDP timezone
// override is applied later and remains authoritative.
export function backendEnvironment(env = process.env, zone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const result = { ...env };
  if (['UTC', 'Etc/UTC', 'Etc/GMT', 'GMT'].includes(zone)) result.TZ = 'America/Los_Angeles';
  return result;
}
