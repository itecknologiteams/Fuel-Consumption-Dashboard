import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { FuelSensorResolverService, FuelSensor } from '../fuel/services/fuel-sensor-resolver.service';
import {
  FuelConsumptionService,
  periodConsumed,
} from '../fuel/services/fuel-consumption.service';
import { DynamicTableQueryService } from '../fuel/services/dynamic-table-query.service';
import { FuelTransformService } from '../fuel/services/fuel-transform.service';
import { ThriftService } from '../fuel/services/thrift.service';
import { ThriftRating } from '../fuel/services/thrift.service';

export interface VehicleSummary {
  imei: string;
  name: string;
  plateNumber: string;
  consumed: number;
  refueled: number;
  cost: number | null;
  lastSeen: string | null;
  status: 'online' | 'offline';
  currentFuel: number | null;
  unit: string;
}

export interface DashboardSummary {
  from: string;
  to: string;
  vehicles: VehicleSummary[];
  totals: { consumed: number; cost: number | null };
}

export interface FleetRankEntry {
  rank: number;
  imei: string;
  name: string;
  plateNumber: string;
  kmPerLiter: number | null;
  litersPer100km: number | null;
  consumed: number;
  totalDistanceKm: number;
  thriftScore: number;
  thriftRating: ThriftRating;
  badge: 'best' | 'worst' | null;
}

export interface FleetRanking {
  from: string;
  to: string;
  ranking: FleetRankEntry[];
  bestVehicle: FleetRankEntry | null;
  worstVehicle: FleetRankEntry | null;
}

/**
 * Map `items` through `fn` with at most `limit` running at once, preserving
 * input order in the result. Lets the dashboard analyse several vehicles in
 * parallel without firing every heavy query at the DB simultaneously.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, limit), items.length || 1) },
    async () => {
      while (next < items.length) {
        const idx = next++;
        results[idx] = await fn(items[idx]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly sensorResolver: FuelSensorResolverService,
    private readonly consumptionService: FuelConsumptionService,
    private readonly dynQuery: DynamicTableQueryService,
    private readonly transform: FuelTransformService,
    private readonly thriftService: ThriftService,
  ) {}

  /** Returns a valid Date or null — guards against MySQL zero-date (0000-00-00). */
  private safeDate(raw: Date | string | null | undefined): Date | null {
    if (!raw) return null;
    const d = new Date(raw);
    return isNaN(d.getTime()) ? null : d;
  }

  async getSummary(
    userId: number,
    fromStr: string,
    toStr: string,
  ): Promise<DashboardSummary> {
    const from = new Date(fromStr);
    const to = new Date(toStr);

    if (isNaN(from.getTime()) || isNaN(to.getTime())) {
      throw new BadRequestException('Invalid date format. Use ISO 8601 UTC.');
    }
    if (from >= to) {
      throw new BadRequestException("'from' must be before 'to'");
    }

    const vehicleRows: Array<{
      imei: string;
      name: string;
      plate_number: string;
      dt_tracker: Date | null;
      fcr: string;
    }> = await this.dataSource.query(
      `SELECT o.imei, o.name, o.plate_number, o.dt_tracker, o.fcr
       FROM gs_user_objects uo
       INNER JOIN gs_objects o ON o.imei = uo.imei
       WHERE uo.user_id = ?
       ORDER BY o.name ASC`,
      [userId],
    );

    const staleMinutes = this.config.get<number>('STALE_THRESHOLD_MINUTES', 30);
    const now = Date.now();
    const staleMs = staleMinutes * 60 * 1000;

    // Per-vehicle fuel summary. getConsumption is heavy (fetches + analyses the
    // full range), so the fleet is processed with bounded concurrency below
    // instead of one-at-a-time — the old sequential loop was the main cause of
    // dashboard-summary timeouts (504) on wide date ranges. Returns null for a
    // vehicle with no fuel sensor (excluded from the dashboard entirely).
    const computeVehicle = async (
      v: (typeof vehicleRows)[number],
    ): Promise<{ summary: VehicleSummary; consumed: number; cost: number | null } | null> => {
      const lastSeenDate = this.safeDate(v.dt_tracker);
      const isOnline =
        lastSeenDate !== null && now - lastSeenDate.getTime() < staleMs;

      let sensor: FuelSensor;
      try {
        sensor = await this.sensorResolver.resolveFuelSensor(v.imei);
      } catch {
        return null; // no fuel sensor → not part of the fuel dashboard
      }

      let consumed = 0;
      let refueled = 0;
      let cost: number | null = null;
      let currentFuel: number | null = null;

      try {
        const result = await this.consumptionService.getConsumption(
          v.imei,
          from,
          to,
          sensor,
          v.fcr ?? '',
        );

        // Mass-balance (matches the Routes "Period Summary"), falling back to
        // the drop sum when the balance is unusable — see periodConsumed().
        consumed = periodConsumed(result);
        refueled = result.refueled;
        cost = result.estimatedCost;

        const latestRow = await this.dynQuery.getLatestRestingRow(v.imei);
        if (latestRow) {
          const rawValue = this.transform.extractRawValue(
            latestRow.params,
            sensor.param,
            v.imei,
            new Date(latestRow.dt_tracker).toISOString(),
          );
          if (rawValue !== null) {
            currentFuel = this.transform.transform(rawValue, sensor).value;
          }
        }
      } catch (err) {
        // Sensor exists but consumption failed — still include the vehicle.
        this.logger.warn(
          `Could not compute fuel summary for IMEI ${v.imei}: ${String(err)}`,
        );
      }

      return {
        consumed,
        cost,
        summary: {
          imei: v.imei,
          name: v.name,
          plateNumber: v.plate_number,
          consumed: Math.round(consumed * 100) / 100,
          refueled: Math.round(refueled * 100) / 100,
          cost,
          lastSeen: lastSeenDate ? lastSeenDate.toISOString() : null,
          status: isOnline ? 'online' : 'offline',
          currentFuel,
          unit: sensor.units || 'L',
        },
      };
    };

    // Process vehicles ONE AT A TIME. The fuel analysis is heavy synchronous
    // CPU work on Node's single thread, so running vehicles concurrently gives
    // no CPU speedup and instead loads several large result sets into memory at
    // once — which saturated the process and made every endpoint slow. Keeping
    // it sequential bounds peak memory; the real speedup comes from the cache,
    // the forced index, and (future) downsampling — not concurrency.
    const computed = await mapWithConcurrency(vehicleRows, 1, computeVehicle);

    const vehicles: VehicleSummary[] = [];
    let totalConsumed = 0;
    let totalCost = 0;
    let hasCost = false;
    for (const c of computed) {
      if (!c) continue; // vehicle without a sensor
      vehicles.push(c.summary);
      totalConsumed += c.consumed;
      if (c.cost !== null) {
        totalCost += c.cost;
        hasCost = true;
      }
    }

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      vehicles,
      totals: {
        consumed: Math.round(totalConsumed * 100) / 100,
        cost: hasCost ? Math.round(totalCost * 100) / 100 : null,
      },
    };
  }

  async getFleetRanking(
    userId: number,
    fromStr: string,
    toStr: string,
  ): Promise<FleetRanking> {
    const from = new Date(fromStr);
    const to = new Date(toStr);

    if (isNaN(from.getTime()) || isNaN(to.getTime())) {
      throw new BadRequestException('Invalid date format. Use ISO 8601 UTC.');
    }
    if (from >= to) {
      throw new BadRequestException("'from' must be before 'to'");
    }

    const vehicleRows: Array<{
      imei: string;
      name: string;
      plate_number: string;
    }> = await this.dataSource.query(
      `SELECT o.imei, o.name, o.plate_number
       FROM gs_user_objects uo
       INNER JOIN gs_objects o ON o.imei = uo.imei
       WHERE uo.user_id = ?
       ORDER BY o.name ASC`,
      [userId],
    );

    const entries: FleetRankEntry[] = [];

    for (const v of vehicleRows) {
      try {
        const sensor = await this.sensorResolver.resolveFuelSensor(v.imei);
        const thrift = await this.thriftService.getThrift(
          v.imei,
          from,
          to,
          sensor,
        );

        entries.push({
          rank: 0,
          imei: v.imei,
          name: v.name,
          plateNumber: v.plate_number,
          kmPerLiter: thrift.efficiency.kmPerLiter,
          litersPer100km: thrift.efficiency.litersPer100km,
          consumed: thrift.consumed,
          totalDistanceKm: thrift.efficiency.totalDistanceKm,
          thriftScore: thrift.thriftScore.score,
          thriftRating: thrift.thriftScore.rating,
          badge: null,
        });
      } catch {
        this.logger.warn(
          `Skipping IMEI ${v.imei} in fleet ranking — no sensor/data`,
        );
      }
    }

    // Sort by thrift score descending (highest = best)
    entries.sort((a, b) => b.thriftScore - a.thriftScore);

    // Assign ranks and badges
    entries.forEach((e, i) => {
      e.rank = i + 1;
    });

    if (entries.length > 0) {
      entries[0].badge = 'best';
      entries[entries.length - 1].badge = 'worst';
    }

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      ranking: entries,
      bestVehicle: entries[0] ?? null,
      worstVehicle: entries[entries.length - 1] ?? null,
    };
  }
}
