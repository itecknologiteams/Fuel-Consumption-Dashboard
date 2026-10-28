import { Injectable, Logger } from '@nestjs/common';
import { FuelSensor } from './fuel-sensor-resolver.service';
import { FuelTransformService } from './fuel-transform.service';
import {
  DynamicTableQueryService,
  DataRow,
} from './dynamic-table-query.service';
import {
  FuelConsumptionService,
  periodConsumed,
} from './fuel-consumption.service';
import {
  DrainSample,
  drainOf,
  drainShares,
  ignitionOn,
} from './fuel-drain.util';
import { trackDistanceKm } from './track-distance.util';

const HIGH_SPEED_THRESHOLD_KMH = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

export type ThriftRating = 'excellent' | 'good' | 'average' | 'poor';

export interface HighSpeedDrain {
  liters: number;
  percentage: number;
  events: number;
}

export interface DailyTrendPoint {
  date: string;
  consumed: number;
  distanceKm: number;
  kmPerLiter: number | null;
  rating: ThriftRating;
}

export interface ThriftScoreBreakdown {
  idlePenalty: number;
  overspeedPenalty: number;
  efficiencyPenalty: number;
}

export interface ThriftScore {
  score: number;
  rating: ThriftRating;
  breakdown: ThriftScoreBreakdown;
}

export interface ThriftResult {
  imei: string;
  from: string;
  to: string;
  unit: string;
  consumed: number;
  efficiency: {
    totalDistanceKm: number;
    kmPerLiter: number | null;
    litersPer100km: number | null;
  };
  idleDrain: { liters: number; percentage: number };
  highSpeedDrain: HighSpeedDrain;
  dailyTrend: DailyTrendPoint[];
  thriftScore: ThriftScore;
  samples: number;
}

type EnrichedRow = DrainSample & { ts: Date; lat: number; lng: number };

@Injectable()
export class ThriftService {
  private readonly logger = new Logger(ThriftService.name);

  constructor(
    private readonly transform: FuelTransformService,
    private readonly dynQuery: DynamicTableQueryService,
    private readonly consumptionService: FuelConsumptionService,
  ) {}

  async getThrift(
    imei: string,
    from: Date,
    to: Date,
    sensor: FuelSensor,
  ): Promise<ThriftResult> {
    const rows = await this.dynQuery.getRowsInRange(imei, from, to);
    this.logger.log(`Thrift for IMEI ${imei}: processing ${rows.length} rows`);

    const enriched = this.enrichRows(rows, sensor, imei);

    // The period's burn is the same figure the dashboard, stats and
    // consumption report show. Summing every reading-to-reading fall here
    // instead reported 9 L for a day that burned 0.8 L.
    const totalConsumed = await this.consumedBetween(imei, from, to, sensor);
    const totalDistanceKm = trackDistanceKm(enriched);

    const shares = drainShares(enriched, HIGH_SPEED_THRESHOLD_KMH);
    const idleDrain = drainOf(totalConsumed, shares.idle);
    const highSpeedDrain: HighSpeedDrain = {
      ...drainOf(totalConsumed, shares.highSpeed),
      events: shares.highSpeedEvents,
    };
    const dailyTrend = await this.calcDailyTrend(
      imei,
      sensor,
      enriched,
      from,
      to,
    );

    const kmPerLiter =
      totalConsumed > 0 && totalDistanceKm > 0
        ? Math.round((totalDistanceKm / totalConsumed) * 100) / 100
        : null;

    const litersPer100km =
      totalConsumed > 0 && totalDistanceKm > 0
        ? Math.round((totalConsumed / totalDistanceKm) * 100 * 100) / 100
        : null;

    const thriftScore = this.calcThriftScore(
      idleDrain.percentage,
      highSpeedDrain.percentage,
      kmPerLiter,
    );

    return {
      imei,
      from: from.toISOString(),
      to: to.toISOString(),
      unit: sensor.units || 'L',
      consumed: Math.round(totalConsumed * 100) / 100,
      efficiency: {
        totalDistanceKm: Math.round(totalDistanceKm * 100) / 100,
        kmPerLiter,
        litersPer100km,
      },
      idleDrain,
      highSpeedDrain,
      dailyTrend,
      thriftScore,
      samples: rows.length,
    };
  }

  /** periodConsumed() over [from, to]; 0 when the window has no readings. */
  private async consumedBetween(
    imei: string,
    from: Date,
    to: Date,
    sensor: FuelSensor,
  ): Promise<number> {
    try {
      const result = await this.consumptionService.getConsumption(
        imei,
        from,
        to,
        sensor,
        '',
      );
      return periodConsumed(result);
    } catch {
      return 0;
    }
  }

  // ─── Enriched row ────────────────────────────────────────────────────────────

  private enrichRows(
    rows: DataRow[],
    sensor: FuelSensor,
    imei: string,
  ): EnrichedRow[] {
    return rows.map((row) => {
      const ts = new Date(row.dt_tracker);
      const rawValue = this.transform.extractRawValue(
        row.params,
        sensor.param,
        imei,
        ts.toISOString(),
      );
      const fuel =
        rawValue !== null
          ? (this.transform.transform(rawValue, sensor).value ?? null)
          : null;

      return {
        ts,
        fuel,
        lat: row.lat,
        lng: row.lng,
        speed: row.speed,
        ignition: ignitionOn(row.params),
      };
    });
  }

  // ─── Daily Trend ──────────────────────────────────────────────────────────────

  /**
   * One point per day of the range. Days are 24 h windows counted from
   * `from`, which the portal always sends as the user's local midnight — so a
   * day here is the same day the user (and the GPS server, in the user's
   * timezone) means. Grouping by UTC date used to split every Pakistan day at
   * 05:00 into two half-days.
   *
   * Each day's burn is periodConsumed() over that day, i.e. exactly what the
   * dashboard shows when that day is picked.
   */
  private async calcDailyTrend(
    imei: string,
    sensor: FuelSensor,
    rows: EnrichedRow[],
    from: Date,
    to: Date,
  ): Promise<DailyTrendPoint[]> {
    const trend: DailyTrendPoint[] = [];

    for (let start = from.getTime(); start < to.getTime(); start += DAY_MS) {
      const end = Math.min(start + DAY_MS, to.getTime());
      const dayRows = rows.filter((r) => {
        const t = r.ts.getTime();
        return t >= start && t < end;
      });
      if (dayRows.length === 0) continue;

      const consumed =
        Math.round(
          (await this.consumedBetween(
            imei,
            new Date(start),
            new Date(end),
            sensor,
          )) * 100,
        ) / 100;
      const km = trackDistanceKm(dayRows);
      const distanceKm = Math.round(km * 100) / 100;
      const kmPerLiter =
        consumed > 0 && km > 0 ? Math.round((km / consumed) * 100) / 100 : null;

      trend.push({
        // Local calendar date of the window: its midday is on that date in
        // UTC for any offset within ±12 h.
        date: new Date(start + DAY_MS / 2).toISOString().slice(0, 10),
        consumed,
        distanceKm,
        kmPerLiter,
        rating: this.rateKmPerLiter(kmPerLiter),
      });
    }

    return trend;
  }

  // ─── Thrift Score ─────────────────────────────────────────────────────────────

  private calcThriftScore(
    idlePercentage: number,
    overspeedPercentage: number,
    kmPerLiter: number | null,
  ): ThriftScore {
    // Idle penalty: max 30 points deducted at 75%+ idle
    const idlePenalty = Math.min(30, Math.round((idlePercentage / 75) * 30));

    // Overspeed penalty: max 25 points deducted at 50%+ overspeed
    const overspeedPenalty = Math.min(
      25,
      Math.round((overspeedPercentage / 50) * 25),
    );

    // Efficiency penalty: max 45 points
    // If km/L exists: score based on absolute value
    //   ≥ 15 km/L → 0 penalty (excellent)
    //   10-15     → scaled
    //   5-10      → scaled
    //   < 5       → max penalty
    let efficiencyPenalty = 0;
    if (kmPerLiter !== null) {
      if (kmPerLiter >= 15) {
        efficiencyPenalty = 0;
      } else if (kmPerLiter >= 10) {
        efficiencyPenalty = Math.round(((15 - kmPerLiter) / 5) * 20);
      } else if (kmPerLiter >= 5) {
        efficiencyPenalty = Math.round(20 + ((10 - kmPerLiter) / 5) * 25);
      } else {
        efficiencyPenalty = 45;
      }
    }

    const totalPenalty = idlePenalty + overspeedPenalty + efficiencyPenalty;
    const score = Math.max(0, Math.min(100, 100 - totalPenalty));

    return {
      score,
      rating: this.rateScore(score),
      breakdown: {
        idlePenalty: -idlePenalty,
        overspeedPenalty: -overspeedPenalty,
        efficiencyPenalty: -efficiencyPenalty,
      },
    };
  }

  private rateScore(score: number): ThriftRating {
    if (score >= 80) return 'excellent';
    if (score >= 60) return 'good';
    if (score >= 40) return 'average';
    return 'poor';
  }

  private rateKmPerLiter(kmPerLiter: number | null): ThriftRating {
    if (kmPerLiter === null) return 'average';
    if (kmPerLiter >= 12) return 'excellent';
    if (kmPerLiter >= 8) return 'good';
    if (kmPerLiter >= 5) return 'average';
    return 'poor';
  }
}
