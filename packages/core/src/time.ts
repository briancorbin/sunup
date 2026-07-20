/** Timezone math via Intl only — no libraries, portable to any JS runtime. */

export interface LocalParts {
  /** "YYYY-MM-DD" local date. */
  date: string;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
  /** Minutes since local midnight. */
  minutes: number;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function localParts(now: Date, timezone: string): LocalParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(now)) parts[p.type] = p.value;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: WEEKDAYS[parts.weekday ?? "Sun"] ?? 0,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/** "HH:MM" → minutes since midnight. Returns null when malformed. */
export function parseHM(hm: string): number | null {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(hm.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Human "Mon, Jun 2" style label for a "YYYY-MM-DD" run date. */
export function formatRunDate(runDate: string): string {
  const d = new Date(`${runDate}T12:00:00Z`);
  return d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" });
}
