/** 75.4 -> "1:15" */
export function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** ISO -> "5 octobre 2026, 15:51" (heure locale) */
export function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("fr-FR", { dateStyle: "long", timeStyle: "short" }).format(new Date(iso));
}

/** ISO -> "lundi 5 octobre 2026 · 15:51" (heure locale) */
export function formatDayAndTime(iso: string): string {
  const date = new Date(iso);
  const day = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(date);
  const time = new Intl.DateTimeFormat("fr-FR", { timeStyle: "short" }).format(date);
  return `${day} · ${time}`;
}
