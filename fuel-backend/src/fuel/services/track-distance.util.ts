/**
 * Distance driven over a run of GPS fixes — the one implementation every page
 * uses, so the dashboard, stats, thrift, trips and master report agree.
 *
 * Distance is measured from the last accepted fix (the anchor):
 *   • an invalid fix (0,0 or out of range) is ignored;
 *   • across a gap longer than MAX_SEGMENT_GAP_MS the path is unknown, so
 *     nothing is added and the anchor restarts;
 *   • a fix implying more than MAX_SEGMENT_SPEED_KMH from the anchor is a
 *     position jump — skipped, keeping the anchor, so the real distance
 *     around it still counts;
 *   • a fix within MIN_SEGMENT_KM of the anchor is drift — skipped, keeping
 *     the anchor, so slow genuine movement still adds up once it clears it.
 *
 * Checked against the GPS server's own odometer (gs_objects.odometer) over a
 * live window: exact on clean tracks and through position jumps, where
 * dropping both segments around a bad fix used to lose ~10 %.
 */

export const MAX_SEGMENT_GAP_MS = 5 * 60 * 1000;
export const MIN_SEGMENT_KM = 0.02;
export const MAX_SEGMENT_SPEED_KMH = 160;

export interface TrackFix {
  lat: number;
  lng: number;
  /** Timestamp of the fix (Date or anything `new Date()` accepts). */
  dt_tracker?: Date | string;
  ts?: Date;
}

export function isValidFix(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180 &&
    !(lat === 0 && lng === 0)
  );
}

export function haversineKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6371.0088;
  const rad = (d: number) => (d * Math.PI) / 180;
  const a =
    Math.sin(rad(lat2 - lat1) / 2) ** 2 +
    Math.cos(rad(lat1)) *
      Math.cos(rad(lat2)) *
      Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const fixTime = (f: TrackFix): number =>
  (f.ts ?? new Date(f.dt_tracker as Date | string)).getTime();

/** Total km over fixes in time order. */
export function trackDistanceKm(fixes: TrackFix[]): number {
  let km = 0;
  let anchor: { lat: number; lng: number; t: number } | null = null;

  for (const f of fixes) {
    const lat = Number(f.lat);
    const lng = Number(f.lng);
    if (!isValidFix(lat, lng)) continue;
    const t = fixTime(f);
    if (anchor === null) {
      anchor = { lat, lng, t };
      continue;
    }
    const dtMs = t - anchor.t;
    if (!(dtMs > 0)) continue;
    if (dtMs > MAX_SEGMENT_GAP_MS) {
      anchor = { lat, lng, t };
      continue;
    }
    const d = haversineKm(anchor.lat, anchor.lng, lat, lng);
    if (d / (dtMs / 3_600_000) > MAX_SEGMENT_SPEED_KMH) continue;
    if (d < MIN_SEGMENT_KM) continue;
    km += d;
    anchor = { lat, lng, t };
  }
  return km;
}
