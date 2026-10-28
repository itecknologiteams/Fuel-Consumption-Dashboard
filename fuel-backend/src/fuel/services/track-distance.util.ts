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

export interface TrackAnchor<T> {
  fix: T;
  /** Km from the previous anchor (0 for the first, or after a gap). */
  km: number;
  /** True when this anchor follows a gap — the path before it is unknown. */
  afterGap: boolean;
}

/**
 * The fixes that make up the driven path, by the anchor rules above: drift
 * and position jumps are dropped, so consecutive anchors form a clean track
 * line, and their `km` values sum to trackDistanceKm().
 */
export function trackAnchors<T extends TrackFix>(fixes: T[]): TrackAnchor<T>[] {
  const out: TrackAnchor<T>[] = [];
  let anchor: { lat: number; lng: number } | null = null;
  // Time of the last believable fix (anchor or drift around it). Gaps and
  // jump speeds are judged from here, not from the anchor: a vehicle parked
  // for hours keeps reporting, so leaving the stop is not a gap — and a bad
  // fix after a long stop still reads as an impossible jump.
  let lastT = 0;

  for (const f of fixes) {
    const lat = Number(f.lat);
    const lng = Number(f.lng);
    if (!isValidFix(lat, lng)) continue;
    const t = fixTime(f);
    if (anchor === null) {
      anchor = { lat, lng };
      lastT = t;
      out.push({ fix: f, km: 0, afterGap: false });
      continue;
    }
    const dtMs = t - lastT;
    if (!(dtMs > 0)) continue;
    if (dtMs > MAX_SEGMENT_GAP_MS) {
      anchor = { lat, lng };
      lastT = t;
      out.push({ fix: f, km: 0, afterGap: true });
      continue;
    }
    const d = haversineKm(anchor.lat, anchor.lng, lat, lng);
    if (d / (dtMs / 3_600_000) > MAX_SEGMENT_SPEED_KMH) continue; // jump
    lastT = t;
    if (d < MIN_SEGMENT_KM) continue; // drift
    anchor = { lat, lng };
    out.push({ fix: f, km: d, afterGap: false });
  }
  return out;
}

/** Total km over fixes in time order. */
export function trackDistanceKm(fixes: TrackFix[]): number {
  return trackAnchors(fixes).reduce((km, a) => km + a.km, 0);
}
