export function event(type, data = {}, timestamp = '2026-08-01T10:00:00.000Z') {
  return { type, data, timestamp };
}
