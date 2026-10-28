import { Injectable, Logger } from '@nestjs/common';
import {
  DataRow,
  DynamicTableQueryService,
} from './dynamic-table-query.service';
import {
  FuelSensor,
  FuelSensorResolverService,
} from './fuel-sensor-resolver.service';
import { FuelTransformService } from './fuel-transform.service';
import {
  ConsumptionResult,
  FuelConsumptionService,
} from './fuel-consumption.service';
import { ignitionOn } from './fuel-drain.util';
import { haversineKm, isValidFix, trackAnchors } from './track-distance.util';

/** Track points returned for the map; the line is simplified to fit. */
const MAX_TRACK_POINTS = 4000;
/** Starting Douglas–Peucker tolerance, doubled until the track fits. */
const SIMPLIFY_START_M = 3;
/** At or below this the vehicle counts as standing still. */
const STOP_SPEED_KMH = 5;
/** A stop must last this long to be listed (as the GPS server's history does). */
const MIN_STOP_MS = 5 * 60 * 1000;
/** Jitter radius: a "moving" fix this close to the stop doesn't end it. */
const STOP_RADIUS_KM = 0.05;
/** Moving time ignores reporting gaps longer than this. */
const MAX_MOVING_GAP_MS = 5 * 60 * 1000;

export interface RoutePoint {
  lat: number;
  lng: number;
  ts: string;
  speed: number;
  fuel: number | null;
  ignition: boolean;
  /** True when the tracker was silent before this point (path unknown). */
  gap?: boolean;
}

export interface RouteStop {
  from: string;
  to: string;
  durationMin: number;
  lat: number;
  lng: number;
  /** Share of the stop with the ignition on — idling rather than parked. */
  ignitionOnPct: number;
  fuelStart: number | null;
  fuelEnd: number | null;
}

export interface RouteFuelEvent {
  type: 'drop' | 'refuel';
  at: string;
  amount: number;
  fuelBefore: number;
  fuelAfter: number;
  unit: string;
  /** Drops: confirmed drop alert. Refuels: passed the anomaly check. */
  confirmed: boolean;
  lat: number;
  lng: number;
  speed: number;
}

export interface RouteHistory {
  imei: string;
  from: string;
  to: string;
  unit: string | null;
  points: RoutePoint[];
  totalPoints: number;
  stops: RouteStop[];
  events: RouteFuelEvent[];
  summary: {
    fixes: number;
    distanceKm: number;
    movingMinutes: number;
    maxSpeedKmh: number;
    startedAt: string | null;
    endedAt: string | null;
    start: { lat: number; lng: number } | null;
    end: { lat: number; lng: number } | null;
  };
}

type Fix = DataRow & { ts: Date; fuel: number | null; ignition: boolean };

@Injectable()
export class RouteHistoryService {
  private readonly logger = new Logger(RouteHistoryService.name);

  constructor(
    private readonly dynQuery: DynamicTableQueryService,
    private readonly sensorResolver: FuelSensorResolverService,
    private readonly transform: FuelTransformService,
    private readonly consumptionService: FuelConsumptionService,
  ) {}

  /**
   * The vehicle's full track over [from, to] with its fuel drops and refuels
   * placed where they happened — the portal's equivalent of the GPS server's
   * history playback.
   */
  async getRouteHistory(
    imei: string,
    from: Date,
    to: Date,
  ): Promise<RouteHistory> {
    const rows = await this.dynQuery.getRowsInRangeOrEmpty(imei, from, to);
    const sensor = await this.sensorResolver
      .resolveFuelSensor(imei)
      .catch(() => null);

    const fixes: Fix[] = rows
      .filter((r) => isValidFix(Number(r.lat), Number(r.lng)))
      .map((r) => ({
        ...r,
        lat: Number(r.lat),
        lng: Number(r.lng),
        speed: Number(r.speed) || 0,
        ts: new Date(r.dt_tracker),
        fuel: sensor ? this.fuelOf(r, sensor, imei) : null,
        ignition: ignitionOn(r.params),
      }));

    const anchors = trackAnchors(fixes);
    const points = this.simplify(
      anchors.map((a) => this.toPoint(a.fix, a.afterGap)),
    );

    const events = sensor
      ? await this.fuelEvents(imei, from, to, sensor, fixes)
      : [];
    const first = fixes[0];
    const last = fixes[fixes.length - 1];

    this.logger.log(
      `Route ${imei}: ${rows.length} rows → ${anchors.length} track fixes → ${points.length} points, ${events.length} fuel events`,
    );

    return {
      imei,
      from: from.toISOString(),
      to: to.toISOString(),
      unit: sensor ? sensor.units || 'L' : null,
      points,
      totalPoints: points.length,
      stops: this.findStops(fixes),
      events,
      summary: {
        fixes: fixes.length,
        distanceKm:
          Math.round(anchors.reduce((s, a) => s + a.km, 0) * 100) / 100,
        movingMinutes: Math.round(this.movingMs(fixes) / 60_000),
        maxSpeedKmh: fixes.reduce((m, f) => Math.max(m, f.speed), 0),
        startedAt: first ? first.ts.toISOString() : null,
        endedAt: last ? last.ts.toISOString() : null,
        start: first ? { lat: first.lat, lng: first.lng } : null,
        end: last ? { lat: last.lat, lng: last.lng } : null,
      },
    };
  }

  private fuelOf(
    row: DataRow,
    sensor: FuelSensor,
    imei: string,
  ): number | null {
    const raw = this.transform.extractRawValue(
      row.params,
      sensor.param,
      imei,
      new Date(row.dt_tracker).toISOString(),
    );
    if (raw === null) return null;
    const v = this.transform.transform(raw, sensor).value;
    return v === null ? null : Math.round(v * 100) / 100;
  }

  private toPoint(f: Fix, gap: boolean): RoutePoint {
    return {
      lat: f.lat,
      lng: f.lng,
      ts: f.ts.toISOString(),
      speed: f.speed,
      fuel: f.fuel,
      ignition: f.ignition,
      ...(gap ? { gap: true } : {}),
    };
  }

  // ─── Track simplification ───────────────────────────────────────────────────

  /**
   * Douglas–Peucker per continuous stretch (gaps are kept as breaks), with
   * the tolerance doubled until the track fits MAX_TRACK_POINTS. Shape-based,
   * unlike the old every-Nth-point stride that cut corners off the route.
   */
  private simplify(points: RoutePoint[]): RoutePoint[] {
    if (points.length <= MAX_TRACK_POINTS) return points;
    let tolM = SIMPLIFY_START_M;
    let out = points;
    while (out.length > MAX_TRACK_POINTS && tolM < 5000) {
      out = this.splitAtGaps(points).flatMap((s) => this.dp(s, tolM));
      tolM *= 2;
    }
    return out;
  }

  private splitAtGaps(points: RoutePoint[]): RoutePoint[][] {
    const parts: RoutePoint[][] = [];
    for (const p of points) {
      if (p.gap || parts.length === 0) parts.push([p]);
      else parts[parts.length - 1].push(p);
    }
    return parts;
  }

  /** Iterative Douglas–Peucker on an equirectangular projection (metres). */
  private dp(pts: RoutePoint[], tolM: number): RoutePoint[] {
    if (pts.length <= 2) return pts;
    const lat0 = (pts[0].lat * Math.PI) / 180;
    const xy = pts.map((p) => ({
      x: p.lng * 111_320 * Math.cos(lat0),
      y: p.lat * 110_540,
    }));
    const keep = new Uint8Array(pts.length);
    keep[0] = keep[pts.length - 1] = 1;
    const stack: Array<[number, number]> = [[0, pts.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop()!;
      let maxD = 0;
      let idx = -1;
      const ax = xy[a].x,
        ay = xy[a].y;
      const dx = xy[b].x - ax,
        dy = xy[b].y - ay;
      const len2 = dx * dx + dy * dy;
      for (let i = a + 1; i < b; i++) {
        const px = xy[i].x - ax,
          py = xy[i].y - ay;
        const t =
          len2 > 0 ? Math.max(0, Math.min(1, (px * dx + py * dy) / len2)) : 0;
        const d = Math.hypot(px - t * dx, py - t * dy);
        if (d > maxD) {
          maxD = d;
          idx = i;
        }
      }
      if (idx !== -1 && maxD > tolM) {
        keep[idx] = 1;
        stack.push([a, idx], [idx, b]);
      }
    }
    return pts.filter((_, i) => keep[i]);
  }

  // ─── Stops ──────────────────────────────────────────────────────────────────

  /**
   * Periods standing still for at least MIN_STOP_MS. A stop holds through a
   * GPS-jitter "moving" fix that stays within STOP_RADIUS_KM, and through a
   * reporting gap (trackers often go quiet while parked).
   */
  private findStops(fixes: Fix[]): RouteStop[] {
    const stops: RouteStop[] = [];
    let i = 0;
    while (i < fixes.length) {
      if (fixes[i].speed > STOP_SPEED_KMH) {
        i++;
        continue;
      }
      const start = fixes[i];
      let j = i;
      while (
        j + 1 < fixes.length &&
        (fixes[j + 1].speed <= STOP_SPEED_KMH ||
          haversineKm(
            start.lat,
            start.lng,
            fixes[j + 1].lat,
            fixes[j + 1].lng,
          ) <= STOP_RADIUS_KM)
      )
        j++;
      // A stop ends where movement resumes, i.e. at the next fix if any.
      const endFix = fixes[j + 1] ?? fixes[j];
      const durMs = endFix.ts.getTime() - start.ts.getTime();
      if (durMs >= MIN_STOP_MS) {
        let onMs = 0;
        for (let k = i; k < j + 1 && k + 1 < fixes.length; k++) {
          if (fixes[k].ignition)
            onMs += fixes[k + 1].ts.getTime() - fixes[k].ts.getTime();
        }
        const fuels = fixes
          .slice(i, j + 1)
          .map((f) => f.fuel)
          .filter((f): f is number => f !== null);
        stops.push({
          from: start.ts.toISOString(),
          to: endFix.ts.toISOString(),
          durationMin: Math.round(durMs / 60_000),
          lat: start.lat,
          lng: start.lng,
          ignitionOnPct: durMs > 0 ? Math.round((onMs / durMs) * 100) : 0,
          fuelStart: fuels.length ? fuels[0] : null,
          fuelEnd: fuels.length ? fuels[fuels.length - 1] : null,
        });
      }
      i = j + 1;
    }
    return stops;
  }

  private movingMs(fixes: Fix[]): number {
    let ms = 0;
    for (let k = 1; k < fixes.length; k++) {
      const dt = fixes[k].ts.getTime() - fixes[k - 1].ts.getTime();
      if (
        dt > 0 &&
        dt <= MAX_MOVING_GAP_MS &&
        fixes[k - 1].speed > STOP_SPEED_KMH
      )
        ms += dt;
    }
    return ms;
  }

  // ─── Fuel events on the map ─────────────────────────────────────────────────

  /**
   * Every drop and refuel the consumption service found (the same events the
   * rest of the portal counts), each placed at the fix nearest its time.
   */
  private async fuelEvents(
    imei: string,
    from: Date,
    to: Date,
    sensor: FuelSensor,
    fixes: Fix[],
  ): Promise<RouteFuelEvent[]> {
    if (!fixes.length) return [];
    let consumption: ConsumptionResult;
    try {
      consumption = await this.consumptionService.getConsumption(
        imei,
        from,
        to,
        sensor,
        '',
      );
    } catch {
      return [];
    }
    const unit = sensor.units || 'L';
    const place = (at: string) =>
      this.nearestFix(fixes, new Date(at).getTime());

    const drops = consumption.drops.map((d) => {
      const f = place(d.at);
      return {
        type: 'drop' as const,
        at: d.at,
        amount: d.consumed,
        fuelBefore: d.fuelBefore,
        fuelAfter: d.fuelAfter,
        unit,
        confirmed: d.isConfirmedDrop === true,
        lat: f.lat,
        lng: f.lng,
        speed: f.speed,
      };
    });
    const refuels = consumption.refuels.map((r) => {
      const f = place(r.at);
      return {
        type: 'refuel' as const,
        at: r.at,
        amount: r.added,
        fuelBefore: r.fuelBefore,
        fuelAfter: r.fuelAfter,
        unit,
        confirmed: r.isVerified !== false,
        lat: f.lat,
        lng: f.lng,
        speed: f.speed,
      };
    });
    return [...drops, ...refuels].sort((a, b) => a.at.localeCompare(b.at));
  }

  /** Binary search on time-ordered fixes. */
  private nearestFix(fixes: Fix[], t: number): Fix {
    let lo = 0;
    let hi = fixes.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (fixes[mid].ts.getTime() < t) lo = mid + 1;
      else hi = mid;
    }
    const prev = fixes[Math.max(0, lo - 1)];
    const cur = fixes[lo];
    return Math.abs(prev.ts.getTime() - t) < Math.abs(cur.ts.getTime() - t)
      ? prev
      : cur;
  }
}
