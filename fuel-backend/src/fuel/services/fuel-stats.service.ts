import { Injectable, Logger } from '@nestjs/common';
import { FuelSensor } from './fuel-sensor-resolver.service';
import { FuelTransformService } from './fuel-transform.service';
import {
  DynamicTableQueryService,
  DataRow,
} from './dynamic-table-query.service';
import {
  DropEvent,
  FuelConsumptionService,
  RefuelEvent,
  periodConsumed,
} from './fuel-consumption.service';
import { drainOf, drainShares, ignitionOn } from './fuel-drain.util';
import { trackDistanceKm } from './track-distance.util';
import { FuelReading } from './fuel-drop-filter.util';

export interface EfficiencyStats {
  totalDistanceKm: number;
  kmPerLiter: number | null;
  litersPer100km: number | null;
}

export interface IdleDrainStats {
  liters: number;
  percentage: number;
}

export interface FuelTimeline {
  biggestDrop: { at: string; consumed: number; unit: string } | null;
  biggestRefuel: { at: string; added: number; unit: string } | null;
  lowestLevel: { at: string; fuel: number; unit: string } | null;
  highestLevel: { at: string; fuel: number; unit: string } | null;
}

export interface FuelStatsResult {
  imei: string;
  from: string;
  to: string;
  unit: string;
  consumed: number;
  refueled: number;
  estimatedCost: number | null;
  avgDailyConsumption: number;
  efficiency: EfficiencyStats;
  idleDrain: IdleDrainStats;
  fuelTimeline: FuelTimeline;
  refuelEvents: number;
  totalDropEvents: number;
  samples: number;
  drops: DropEvent[];
  refuels: RefuelEvent[];
  /** Raw fuel readings for anomaly detection */
  readings?: FuelReading[];
}

@Injectable()
export class FuelStatsService {
  private readonly logger = new Logger(FuelStatsService.name);

  constructor(
    private readonly transform: FuelTransformService,
    private readonly dynQuery: DynamicTableQueryService,
    private readonly consumptionService: FuelConsumptionService,
  ) {}

  async getStats(
    imei: string,
    from: Date,
    to: Date,
    sensor: FuelSensor,
    pricePerLiter: number | null,
  ): Promise<FuelStatsResult> {
    const rows = await this.dynQuery.getRowsInRange(imei, from, to);
    this.logger.log(`Stats for IMEI ${imei}: fetched ${rows.length} rows`);

    // Drops, refuels and the period's burn come from the consumption service
    // itself, so this panel can never disagree with the dashboard, reports and
    // chart. It used to run its own copy of the detection, which drifted from
    // the original (99.26 vs 110.16 L refueled on the same day).
    const consumption = await this.consumptionService.getConsumption(
      imei,
      from,
      to,
      sensor,
      '',
    );
    const drops = consumption.drops;
    const refuels = consumption.refuels;
    const verifiedRefuels = refuels.filter((r) => r.isVerified !== false);
    const readings = (consumption.readings ?? []).filter((r) => r.ts >= from);
    const refueled = consumption.refueled;
    // Rounded here rather than at each use: summing two already-rounded
    // figures leaves float noise that reaches the panel as 112.78999999999999.
    const consumed = Math.round(periodConsumed(consumption) * 100) / 100;

    // Row-level arrays for distance, idle share and the level timeline.
    const transformedRows = this.transformRows(rows, sensor, imei);

    const estimatedCost =
      pricePerLiter !== null
        ? Math.round(consumed * pricePerLiter * 100) / 100
        : null;

    const rangeDays = Math.max(
      (to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24),
      1,
    );
    const avgDailyConsumption = Math.round((consumed / rangeDays) * 100) / 100;

    const efficiency = this.calcEfficiency(rows, consumed);
    const idleDrain = this.calcIdleDrain(transformedRows, consumed);
    const fuelTimeline = this.calcTimeline(
      drops,
      verifiedRefuels,
      transformedRows,
      sensor.units || 'L',
    );

    return {
      imei,
      from: from.toISOString(),
      to: to.toISOString(),
      unit: sensor.units || 'L',
      consumed,
      refueled,
      estimatedCost,
      avgDailyConsumption,
      efficiency,
      idleDrain,
      fuelTimeline,
      refuelEvents: verifiedRefuels.length,
      totalDropEvents: drops.length,
      samples: rows.length,
      drops,
      refuels,
      readings, // Include readings for anomaly detection middleware
    };
  }

  // ─── Transformed row type ────────────────────────────────────────────────────

  private transformRows(
    rows: DataRow[],
    sensor: FuelSensor,
    imei: string,
  ): Array<{
    ts: Date;
    fuel: number | null;
    lat: number;
    lng: number;
    speed: number;
    params: string;
  }> {
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
        params: row.params,
      };
    });
  }

  // ─── Efficiency: Haversine distance ─────────────────────────────────────────

  private calcEfficiency(rows: DataRow[], consumed: number): EfficiencyStats {
    // Shared with every other page so distances agree (drift and jumps
    // excluded). Ratios use the unrounded distance, as thrift does.
    const km = trackDistanceKm(rows);
    const totalDistanceKm = Math.round(km * 100) / 100;

    const kmPerLiter =
      consumed > 0 && km > 0 ? Math.round((km / consumed) * 100) / 100 : null;

    const litersPer100km =
      consumed > 0 && km > 0
        ? Math.round((consumed / km) * 100 * 100) / 100
        : null;

    return { totalDistanceKm, kmPerLiter, litersPer100km };
  }

  // ─── Idle Drain ──────────────────────────────────────────────────────────────

  /** Idle share of the period's real burn — see fuel-drain.util.ts. */
  private calcIdleDrain(
    transformedRows: Array<{
      fuel: number | null;
      speed: number;
      params: string;
    }>,
    totalConsumed: number,
  ): IdleDrainStats {
    const shares = drainShares(
      transformedRows.map((r) => ({
        fuel: r.fuel,
        speed: r.speed,
        ignition: ignitionOn(r.params),
      })),
      Infinity,
    );
    return drainOf(totalConsumed, shares.idle);
  }

  // ─── Timeline ────────────────────────────────────────────────────────────────

  private calcTimeline(
    drops: DropEvent[],
    refuels: RefuelEvent[],
    transformedRows: Array<{ ts: Date; fuel: number | null }>,
    unit: string,
  ): FuelTimeline {
    // Prefer confirmed drops (≥ 8 L, stayed low 7 min) for biggestDrop; fall
    // back to all drops only if none are confirmed (mirrors Python alert logic).
    const confirmedDrops = drops.filter((d) => d.isConfirmedDrop);
    const dropPool = confirmedDrops.length > 0 ? confirmedDrops : drops;
    const biggestDrop =
      dropPool.length > 0
        ? dropPool.reduce((max, d) => (d.consumed > max.consumed ? d : max))
        : null;

    const biggestRefuel =
      refuels.length > 0
        ? refuels.reduce((max, r) => (r.added > max.added ? r : max))
        : null;

    const validRows = transformedRows.filter((r) => r.fuel !== null);

    const lowestRow =
      validRows.length > 0
        ? validRows.reduce((min, r) =>
            (r.fuel ?? Infinity) < (min.fuel ?? Infinity) ? r : min,
          )
        : null;

    const highestRow =
      validRows.length > 0
        ? validRows.reduce((max, r) =>
            (r.fuel ?? -Infinity) > (max.fuel ?? -Infinity) ? r : max,
          )
        : null;

    return {
      biggestDrop: biggestDrop
        ? { at: biggestDrop.at, consumed: biggestDrop.consumed, unit }
        : null,
      biggestRefuel: biggestRefuel
        ? { at: biggestRefuel.at, added: biggestRefuel.added, unit }
        : null,
      lowestLevel: lowestRow
        ? {
            at: lowestRow.ts.toISOString(),
            fuel: Math.round((lowestRow.fuel ?? 0) * 100) / 100,
            unit,
          }
        : null,
      highestLevel: highestRow
        ? {
            at: highestRow.ts.toISOString(),
            fuel: Math.round((highestRow.fuel ?? 0) * 100) / 100,
            unit,
          }
        : null,
    };
  }
}
