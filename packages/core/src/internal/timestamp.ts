const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;

/**
 * Protocol timestamps are UTC, second precision, exactly `YYYY-MM-DDTHH:MM:SSZ`. The fixed
 * width makes lexicographic order equal chronological order, so key-validity windows can be
 * compared as strings without a date library.
 */
export function isValidTimestamp(value: string): boolean {
  const match = TIMESTAMP.exec(value);
  if (match === null) return false;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (year < 1970 || hour > 23 || minute > 59 || second > 59) return false;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

export function formatTimestamp(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}
