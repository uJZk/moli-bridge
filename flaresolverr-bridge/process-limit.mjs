// A malformed limit must not silently disable the process-capacity check.
export function processLimit(value, name) {
  const limit = value === undefined ? 8 : Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return limit;
}
