import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { FuelSensorResolverService } from '../fuel/services/fuel-sensor-resolver.service';
import {
  FuelConsumptionService,
  periodConsumed,
} from '../fuel/services/fuel-consumption.service';
import { FuelTransformService } from '../fuel/services/fuel-transform.service';
import { DynamicTableQueryService } from '../fuel/services/dynamic-table-query.service';
import { ThriftService } from '../fuel/services/thrift.service';
import { TheftDetectionService } from '../fuel/services/theft-detection.service';
import {
  TripAnalyzerService,
  normalizeTripFuelToPeriod,
} from '../fuel/services/trip-analyzer.service';

const NOISE_THRESHOLD = 0.5;

@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly sensorResolver: FuelSensorResolverService,
    private readonly consumptionService: FuelConsumptionService,
    private readonly transform: FuelTransformService,
    private readonly dynQuery: DynamicTableQueryService,
    private readonly thriftService: ThriftService,
    private readonly theftDetectionService: TheftDetectionService,
    private readonly tripAnalyzerService: TripAnalyzerService,
  ) {}

  // ─── Shared helpers ───────────────────────────────────────────────────────

  parseDateRange(fromStr: string, toStr: string): { from: Date; to: Date } {
    const from = new Date(fromStr);
    let to = new Date(toStr);
    if (isNaN(from.getTime()) || isNaN(to.getTime())) {
      throw new BadRequestException('Invalid date format. Use ISO 8601 UTC.');
    }

    // Allow same-day selection (e.g. Apr 18 -> Apr 18) by expanding
    // the upper bound to a full 24h window.
    if (from.getTime() === to.getTime()) {
      to = new Date(to.getTime() + 24 * 60 * 60 * 1000);
    }

    if (from > to) {
      throw new BadRequestException("'from' must be before 'to'");
    }
    return { from, to };
  }

  private safeDate(raw: Date | string | null | undefined): Date | null {
    if (!raw) return null;
    const d = new Date(raw);
    return isNaN(d.getTime()) ? null : d;
  }

  private async getUserVehicles(userId: number) {
    const rows: Array<{
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
    return rows;
  }

  private async getFcr(imei: string): Promise<string> {
    const rows: Array<{ fcr: string }> = await this.dataSource.query(
      `SELECT fcr FROM gs_objects WHERE imei = ? LIMIT 1`,
      [imei],
    );
    return rows[0]?.fcr ?? '';
  }

  private parsePricePerLiter(fcrJson: string, from: Date): number | null {
    if (!fcrJson || fcrJson === '{}' || fcrJson === '') return null;
    try {
      const parsed: unknown = JSON.parse(fcrJson);
      if (Array.isArray(parsed)) {
        const rates = parsed as Array<{ from: string; pricePerLiter: number }>;
        const sorted = rates
          .filter((r) => new Date(r.from) <= from)
          .sort(
            (a, b) => new Date(b.from).getTime() - new Date(a.from).getTime(),
          );
        return sorted[0]?.pricePerLiter ?? null;
      }
      const obj = parsed as { cost?: string };
      const cost = parseFloat(obj.cost ?? '0');
      return cost > 0 ? cost : null;
    } catch {
      return null;
    }
  }

  // ─── 1. Consumption Report ────────────────────────────────────────────────

  async getConsumptionReport(userId: number, fromStr: string, toStr: string) {
    const { from, to } = this.parseDateRange(fromStr, toStr);
    const vehicles = await this.getUserVehicles(userId);

    let totalConsumed = 0;
    let totalRefueled = 0;
    let totalCost = 0;
    let hasCost = false;

    const results = await Promise.all(
      vehicles.map(async (v) => {
        try {
          const sensor = await this.sensorResolver.resolveFuelSensor(v.imei);
          const fcrJson = v.fcr ?? '';
          const result = await this.consumptionService.getConsumption(
            v.imei,
            from,
            to,
            sensor,
            fcrJson,
          );

          // Align with Routes page mass-balance:
          // consumed = (firstFuel + refueled) - lastFuel, i.e. refueled + netDrop.
          const consumed = periodConsumed(result);

          totalConsumed += consumed;
          totalRefueled += result.refueled;
          if (result.estimatedCost !== null) {
            totalCost += result.estimatedCost;
            hasCost = true;
          }
          return {
            imei: v.imei,
            name: v.name,
            plateNumber: v.plate_number,
            consumed: Math.round(consumed * 100) / 100,
            refueled: result.refueled,
            estimatedCost: result.estimatedCost,
            refuelEvents: result.refuelEvents,
            unit: result.unit,
            status: 'ok',
          };
        } catch (err) {
          this.logger.warn(
            `Consumption report skip IMEI ${v.imei}: ${String(err)}`,
          );
          return {
            imei: v.imei,
            name: v.name,
            plateNumber: v.plate_number,
            consumed: 0,
            refueled: 0,
            estimatedCost: null,
            refuelEvents: 0,
            unit: 'L',
            status: 'no_data',
          };
        }
      }),
    );

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      totals: {
        consumed: Math.round(totalConsumed * 100) / 100,
        refueled: Math.round(totalRefueled * 100) / 100,
        cost: hasCost ? Math.round(totalCost * 100) / 100 : null,
      },
      vehicles: results,
    };
  }

  // ─── 2. Refuels Report ────────────────────────────────────────────────────

  async getRefuelsReport(userId: number, fromStr: string, toStr: string) {
    const { from, to } = this.parseDateRange(fromStr, toStr);
    const vehicles = await this.getUserVehicles(userId);

    const allEvents: Array<{
      imei: string;
      name: string;
      plateNumber: string;
      at: string;
      fuelBefore: number;
      fuelAfter: number;
      added: number;
      unit: string;
    }> = [];

    await Promise.all(
      vehicles.map(async (v) => {
        try {
          const sensor = await this.sensorResolver.resolveFuelSensor(v.imei);
          const result = await this.consumptionService.getConsumption(
            v.imei,
            from,
            to,
            sensor,
            v.fcr ?? '',
          );
          for (const r of result.refuels) {
            allEvents.push({
              imei: v.imei,
              name: v.name,
              plateNumber: v.plate_number,
              ...r,
            });
          }
        } catch {
          // no data for this vehicle
        }
      }),
    );

    allEvents.sort((a, b) => a.at.localeCompare(b.at));

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      totalEvents: allEvents.length,
      totalAdded:
        Math.round(allEvents.reduce((s, e) => s + e.added, 0) * 100) / 100,
      events: allEvents,
    };
  }

  // ─── 3. Idle Waste Report ─────────────────────────────────────────────────

  async getIdleWasteReport(userId: number, fromStr: string, toStr: string) {
    const { from, to } = this.parseDateRange(fromStr, toStr);
    const vehicles = await this.getUserVehicles(userId);

    let fleetIdleLiters = 0;
    let fleetConsumed = 0;

    const results = await Promise.all(
      vehicles.map(async (v) => {
        try {
          const sensor = await this.sensorResolver.resolveFuelSensor(v.imei);
          const rows = await this.dynQuery.getRowsInRange(v.imei, from, to);

          let idleLiters = 0;
          let totalConsumed = 0;
          let prevFuel: number | null = null;
          let prevSpeed: number | null = null;
          let prevIgnition: boolean | null = null;

          for (const row of rows) {
            const ts = new Date(row.dt_tracker);
            const rawValue = this.transform.extractRawValue(
              row.params,
              sensor.param,
              v.imei,
              ts.toISOString(),
            );
            if (rawValue === null) continue;
            const { value } = this.transform.transform(rawValue, sensor);
            if (value === null) continue;

            let ignition = false;
            try {
              const p = JSON.parse(row.params) as Record<
                string,
                string | number
              >;
              ignition =
                p['acc'] === '1' ||
                p['acc'] === 1 ||
                p['io1'] === '1' ||
                p['io1'] === 1;
            } catch {
              /* no ignition field */
            }

            if (
              prevFuel !== null &&
              prevSpeed !== null &&
              prevIgnition !== null
            ) {
              const delta = value - prevFuel;
              if (delta < -NOISE_THRESHOLD) {
                totalConsumed += Math.abs(delta);
                if (prevSpeed < 2 && prevIgnition) {
                  idleLiters += Math.abs(delta);
                }
              }
            }

            prevFuel = value;
            prevSpeed = row.speed;
            prevIgnition = ignition;
          }

          idleLiters = Math.round(idleLiters * 100) / 100;
          totalConsumed = Math.round(totalConsumed * 100) / 100;
          const percentage =
            totalConsumed > 0
              ? Math.round((idleLiters / totalConsumed) * 100 * 10) / 10
              : 0;

          fleetIdleLiters += idleLiters;
          fleetConsumed += totalConsumed;

          return {
            imei: v.imei,
            name: v.name,
            plateNumber: v.plate_number,
            totalConsumed,
            idleLiters,
            idlePercentage: percentage,
            unit: sensor.units || 'L',
            status: 'ok',
          };
        } catch (err) {
          this.logger.warn(`Idle waste skip IMEI ${v.imei}: ${String(err)}`);
          return {
            imei: v.imei,
            name: v.name,
            plateNumber: v.plate_number,
            totalConsumed: 0,
            idleLiters: 0,
            idlePercentage: 0,
            unit: 'L',
            status: 'no_data',
          };
        }
      }),
    );

    const fleetIdlePercentage =
      fleetConsumed > 0
        ? Math.round((fleetIdleLiters / fleetConsumed) * 100 * 10) / 10
        : 0;

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      fleetTotals: {
        idleLiters: Math.round(fleetIdleLiters * 100) / 100,
        totalConsumed: Math.round(fleetConsumed * 100) / 100,
        idlePercentage: fleetIdlePercentage,
      },
      vehicles: results.sort((a, b) => b.idleLiters - a.idleLiters),
    };
  }

  // ─── 4. High Speed Waste Report ───────────────────────────────────────────

  async getHighSpeedReport(userId: number, fromStr: string, toStr: string) {
    const { from, to } = this.parseDateRange(fromStr, toStr);
    const vehicles = await this.getUserVehicles(userId);

    const HIGH_SPEED_KMH = 100;
    let fleetHighSpeedLiters = 0;
    let fleetConsumed = 0;

    const results = await Promise.all(
      vehicles.map(async (v) => {
        try {
          const sensor = await this.sensorResolver.resolveFuelSensor(v.imei);
          const rows = await this.dynQuery.getRowsInRange(v.imei, from, to);

          let highSpeedLiters = 0;
          let highSpeedEvents = 0;
          let totalConsumed = 0;
          let prevFuel: number | null = null;
          let prevSpeed: number | null = null;

          for (const row of rows) {
            const ts = new Date(row.dt_tracker);
            const rawValue = this.transform.extractRawValue(
              row.params,
              sensor.param,
              v.imei,
              ts.toISOString(),
            );
            if (rawValue === null) continue;
            const { value } = this.transform.transform(rawValue, sensor);
            if (value === null) continue;

            if (prevFuel !== null && prevSpeed !== null) {
              const delta = value - prevFuel;
              if (delta < -NOISE_THRESHOLD) {
                totalConsumed += Math.abs(delta);
                if (prevSpeed > HIGH_SPEED_KMH) {
                  highSpeedLiters += Math.abs(delta);
                  highSpeedEvents++;
                }
              }
            }

            prevFuel = value;
            prevSpeed = row.speed;
          }

          highSpeedLiters = Math.round(highSpeedLiters * 100) / 100;
          totalConsumed = Math.round(totalConsumed * 100) / 100;
          const percentage =
            totalConsumed > 0
              ? Math.round((highSpeedLiters / totalConsumed) * 100 * 10) / 10
              : 0;

          fleetHighSpeedLiters += highSpeedLiters;
          fleetConsumed += totalConsumed;

          return {
            imei: v.imei,
            name: v.name,
            plateNumber: v.plate_number,
            totalConsumed,
            highSpeedLiters,
            highSpeedPercentage: percentage,
            highSpeedEvents,
            unit: sensor.units || 'L',
            status: 'ok',
          };
        } catch (err) {
          this.logger.warn(`High speed skip IMEI ${v.imei}: ${String(err)}`);
          return {
            imei: v.imei,
            name: v.name,
            plateNumber: v.plate_number,
            totalConsumed: 0,
            highSpeedLiters: 0,
            highSpeedPercentage: 0,
            highSpeedEvents: 0,
            unit: 'L',
            status: 'no_data',
          };
        }
      }),
    );

    const fleetHighSpeedPercentage =
      fleetConsumed > 0
        ? Math.round((fleetHighSpeedLiters / fleetConsumed) * 100 * 10) / 10
        : 0;

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      speedThresholdKmh: HIGH_SPEED_KMH,
      fleetTotals: {
        highSpeedLiters: Math.round(fleetHighSpeedLiters * 100) / 100,
        totalConsumed: Math.round(fleetConsumed * 100) / 100,
        highSpeedPercentage: fleetHighSpeedPercentage,
      },
      vehicles: results.sort((a, b) => b.highSpeedLiters - a.highSpeedLiters),
    };
  }

  // ─── 5. Daily Trend Report ────────────────────────────────────────────────

  async getDailyTrendReport(userId: number, fromStr: string, toStr: string) {
    const { from, to } = this.parseDateRange(fromStr, toStr);
    const vehicles = await this.getUserVehicles(userId);

    const results = await Promise.all(
      vehicles.map(async (v) => {
        try {
          const sensor = await this.sensorResolver.resolveFuelSensor(v.imei);
          const thrift = await this.thriftService.getThrift(
            v.imei,
            from,
            to,
            sensor,
          );
          return {
            imei: v.imei,
            name: v.name,
            plateNumber: v.plate_number,
            unit: sensor.units || 'L',
            totalConsumed: thrift.consumed,
            dailyTrend: thrift.dailyTrend,
            status: 'ok',
          };
        } catch (err) {
          this.logger.warn(`Daily trend skip IMEI ${v.imei}: ${String(err)}`);
          return {
            imei: v.imei,
            name: v.name,
            plateNumber: v.plate_number,
            unit: 'L',
            totalConsumed: 0,
            dailyTrend: [],
            status: 'no_data',
          };
        }
      }),
    );

    // Build fleet-level daily aggregation (sum across all vehicles per day)
    const dayMap = new Map<string, { consumed: number; distanceKm: number }>();
    for (const v of results) {
      for (const day of v.dailyTrend) {
        const existing = dayMap.get(day.date) ?? { consumed: 0, distanceKm: 0 };
        existing.consumed += day.consumed;
        existing.distanceKm += day.distanceKm;
        dayMap.set(day.date, existing);
      }
    }
    const fleetDailyTrend = Array.from(dayMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, agg]) => ({
        date,
        consumed: Math.round(agg.consumed * 100) / 100,
        distanceKm: Math.round(agg.distanceKm * 100) / 100,
      }));

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      fleetDailyTrend,
      vehicles: results,
    };
  }

  // ─── 6. Thrift Score Report ───────────────────────────────────────────────

  async getThriftReport(userId: number, fromStr: string, toStr: string) {
    const { from, to } = this.parseDateRange(fromStr, toStr);
    const vehicles = await this.getUserVehicles(userId);

    const results = await Promise.all(
      vehicles.map(async (v) => {
        try {
          const sensor = await this.sensorResolver.resolveFuelSensor(v.imei);
          const thrift = await this.thriftService.getThrift(
            v.imei,
            from,
            to,
            sensor,
          );
          return {
            imei: v.imei,
            name: v.name,
            plateNumber: v.plate_number,
            consumed: thrift.consumed,
            unit: thrift.unit,
            kmPerLiter: thrift.efficiency.kmPerLiter,
            litersPer100km: thrift.efficiency.litersPer100km,
            totalDistanceKm: thrift.efficiency.totalDistanceKm,
            idleLiters: thrift.idleDrain.liters,
            idlePercentage: thrift.idleDrain.percentage,
            highSpeedLiters: thrift.highSpeedDrain.liters,
            highSpeedPercentage: thrift.highSpeedDrain.percentage,
            thriftScore: thrift.thriftScore.score,
            thriftRating: thrift.thriftScore.rating,
            breakdown: thrift.thriftScore.breakdown,
            status: 'ok',
          };
        } catch (err) {
          this.logger.warn(`Thrift report skip IMEI ${v.imei}: ${String(err)}`);
          return {
            imei: v.imei,
            name: v.name,
            plateNumber: v.plate_number,
            consumed: 0,
            unit: 'L',
            kmPerLiter: null,
            litersPer100km: null,
            totalDistanceKm: 0,
            idleLiters: 0,
            idlePercentage: 0,
            highSpeedLiters: 0,
            highSpeedPercentage: 0,
            thriftScore: 0,
            thriftRating: 'poor',
            breakdown: null,
            status: 'no_data',
          };
        }
      }),
    );

    const ranked = [...results]
      .filter((r) => r.status === 'ok')
      .sort((a, b) => b.thriftScore - a.thriftScore);

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      fleetAvgScore:
        ranked.length > 0
          ? Math.round(
              ranked.reduce((s, r) => s + r.thriftScore, 0) / ranked.length,
            )
          : null,
      bestVehicle: ranked[0] ?? null,
      worstVehicle: ranked[ranked.length - 1] ?? null,
      vehicles: results.sort((a, b) => b.thriftScore - a.thriftScore),
    };
  }

  // ─── 7. Engine Hours Report ───────────────────────────────────────────────

  async getEngineHoursReport(userId: number, fromStr: string, toStr: string) {
    const { from, to } = this.parseDateRange(fromStr, toStr);
    const vehicles = await this.getUserVehicles(userId);

    const results = await Promise.all(
      vehicles.map(async (v) => {
        try {
          const rows = await this.dynQuery.getRowsInRange(v.imei, from, to);

          let engineOnMs = 0;
          let prevTs: Date | null = null;
          let prevIgnition = false;

          for (const row of rows) {
            const ts = new Date(row.dt_tracker);
            let ignition = false;
            try {
              const p = JSON.parse(row.params) as Record<
                string,
                string | number
              >;
              ignition =
                p['acc'] === '1' ||
                p['acc'] === 1 ||
                p['io1'] === '1' ||
                p['io1'] === 1;
            } catch {
              /* no ignition */
            }

            if (prevTs !== null && prevIgnition) {
              const gapMs = ts.getTime() - prevTs.getTime();
              // Only count gaps <= 30 minutes (avoid counting long offline gaps)
              if (gapMs > 0 && gapMs <= 30 * 60 * 1000) {
                engineOnMs += gapMs;
              }
            }

            prevTs = ts;
            prevIgnition = ignition;
          }

          const engineOnHours = Math.round((engineOnMs / 3600000) * 100) / 100;
          const rangeDays = Math.max(
            (to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24),
            1,
          );
          const avgHoursPerDay =
            Math.round((engineOnHours / rangeDays) * 100) / 100;

          return {
            imei: v.imei,
            name: v.name,
            plateNumber: v.plate_number,
            engineOnHours,
            avgHoursPerDay,
            totalSamples: rows.length,
            status: 'ok',
          };
        } catch (err) {
          this.logger.warn(`Engine hours skip IMEI ${v.imei}: ${String(err)}`);
          return {
            imei: v.imei,
            name: v.name,
            plateNumber: v.plate_number,
            engineOnHours: 0,
            avgHoursPerDay: 0,
            totalSamples: 0,
            status: 'no_data',
          };
        }
      }),
    );

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      fleetTotalEngineHours:
        Math.round(results.reduce((s, r) => s + r.engineOnHours, 0) * 100) /
        100,
      vehicles: results.sort((a, b) => b.engineOnHours - a.engineOnHours),
    };
  }

  // ─── 8. Vehicle Status Report ─────────────────────────────────────────────

  async getVehicleStatusReport(userId: number) {
    const staleMinutes = this.config.get<number>('STALE_THRESHOLD_MINUTES', 30);
    const now = Date.now();

    const vehicleRows: Array<{
      imei: string;
      name: string;
      plate_number: string;
      speed: number;
      lat: number;
      lng: number;
      dt_tracker: Date | null;
      device: string;
      model: string;
      sim_number: string;
    }> = await this.dataSource.query(
      `SELECT o.imei, o.name, o.plate_number, o.speed, o.lat, o.lng,
              o.dt_tracker, o.device, o.model, o.sim_number
       FROM gs_user_objects uo
       INNER JOIN gs_objects o ON o.imei = uo.imei
       WHERE uo.user_id = ?
       ORDER BY o.name ASC`,
      [userId],
    );

    const vehicles = await Promise.all(
      vehicleRows.map(async (v) => {
        const lastSeenDate = this.safeDate(v.dt_tracker);
        const staleMs = staleMinutes * 60 * 1000;
        const isOnline =
          lastSeenDate !== null && now - lastSeenDate.getTime() < staleMs;
        const minutesSinceLastSeen = lastSeenDate
          ? Math.round((now - lastSeenDate.getTime()) / 60000)
          : null;

        let currentFuel: number | null = null;
        let fuelUnit = 'L';

        try {
          const sensor = await this.sensorResolver.resolveFuelSensor(v.imei);
          fuelUnit = sensor.units || 'L';
          const latestRow = await this.dynQuery.getLatestRestingRow(v.imei);
          if (latestRow) {
            const ts = new Date(latestRow.dt_tracker).toISOString();
            const rawValue = this.transform.extractRawValue(
              latestRow.params,
              sensor.param,
              v.imei,
              ts,
            );
            if (rawValue !== null) {
              const { value } = this.transform.transform(rawValue, sensor);
              currentFuel = value;
            }
          }
        } catch {
          /* no sensor configured */
        }

        return {
          imei: v.imei,
          name: v.name,
          plateNumber: v.plate_number,
          status: isOnline ? 'online' : 'offline',
          lastSeen: lastSeenDate ? lastSeenDate.toISOString() : null,
          minutesSinceLastSeen,
          speed: v.speed,
          lat: v.lat,
          lng: v.lng,
          currentFuel,
          fuelUnit,
          device: v.device,
          model: v.model,
          simNumber: v.sim_number,
        };
      }),
    );

    const onlineCount = vehicles.filter((v) => v.status === 'online').length;
    const offlineCount = vehicles.length - onlineCount;

    return {
      generatedAt: new Date().toISOString(),
      totalVehicles: vehicles.length,
      online: onlineCount,
      offline: offlineCount,
      vehicles,
    };
  }

  // ─── 9. Theft Detection Report ────────────────────────────────────────────

  async getTheftDetectionReport(
    userId: number,
    fromStr: string,
    toStr: string,
  ) {
    const { from, to } = this.parseDateRange(fromStr, toStr);
    const vehicles = await this.getUserVehicles(userId);

    let fleetTotalDrops = 0;
    let fleetSuspiciousDrops = 0;
    let fleetTheftDrops = 0;
    let fleetTotalFuelLost = 0;
    let fleetSuspiciousFuelLost = 0;
    let fleetTheftFuelLost = 0;

    const results = await Promise.all(
      vehicles.map(async (v) => {
        try {
          const sensor = await this.sensorResolver.resolveFuelSensor(v.imei);
          const detection = await this.theftDetectionService.detectTheft(
            v.imei,
            from,
            to,
            sensor,
          );

          fleetTotalDrops += detection.summary.totalDrops;
          fleetSuspiciousDrops += detection.summary.suspiciousDrops;
          fleetTheftDrops += detection.summary.theftDrops;
          fleetTotalFuelLost += detection.summary.totalFuelLost;
          fleetSuspiciousFuelLost += detection.summary.suspiciousFuelLost;
          fleetTheftFuelLost += detection.summary.theftFuelLost;

          return {
            imei: v.imei,
            name: v.name,
            plateNumber: v.plate_number,
            unit: detection.unit,
            summary: detection.summary,
            riskLevel: detection.riskLevel,
            riskScore: detection.riskScore,
            alerts: detection.alerts,
            drops: detection.drops,
            status: 'ok',
          };
        } catch (err) {
          this.logger.warn(
            `Theft detection skip IMEI ${v.imei}: ${String(err)}`,
          );
          return {
            imei: v.imei,
            name: v.name,
            plateNumber: v.plate_number,
            unit: 'L',
            summary: {
              totalDrops: 0,
              normalDrops: 0,
              suspiciousDrops: 0,
              theftDrops: 0,
              totalFuelLost: 0,
              suspiciousFuelLost: 0,
              theftFuelLost: 0,
            },
            riskLevel: 'low',
            riskScore: 0,
            alerts: [],
            drops: [],
            status: 'no_data',
          };
        }
      }),
    );

    // Calculate fleet risk level based on total theft events
    const fleetRiskLevel =
      fleetTheftDrops > 0
        ? 'high'
        : fleetSuspiciousDrops > 5
          ? 'medium'
          : 'low';
    const fleetRiskScore = Math.min(
      100,
      fleetTheftDrops * 25 + fleetSuspiciousDrops * 10,
    );

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      fleetSummary: {
        totalDrops: fleetTotalDrops,
        suspiciousDrops: fleetSuspiciousDrops,
        theftDrops: fleetTheftDrops,
        totalFuelLost: Math.round(fleetTotalFuelLost * 100) / 100,
        suspiciousFuelLost: Math.round(fleetSuspiciousFuelLost * 100) / 100,
        theftFuelLost: Math.round(fleetTheftFuelLost * 100) / 100,
      },
      fleetRiskLevel,
      fleetRiskScore: Math.round(fleetRiskScore),
      vehicles: results.sort((a, b) => b.riskScore - a.riskScore),
    };
  }

  // ─── 10. Theft Locations Report (Python ground-truth + GPS lookup) ──────────

  async getTheftLocationsReport(userId: number, fromStr: string, toStr: string) {
    const { from, to } = this.parseDateRange(fromStr, toStr);
    const vehicles = await this.getUserVehicles(userId);

    const allEvents: Array<{
      imei: string;
      name: string;
      plateNumber: string;
      at: string;
      fuelBefore: number;
      fuelAfter: number;
      consumed: number;
      lat: number | null;
      lng: number | null;
    }> = [];

    await Promise.all(
      vehicles.map(async (v) => {
        try {
          const sensor = await this.sensorResolver.resolveFuelSensor(v.imei);
          const unit   = sensor.units || 'L';

          // ── Mirror the Routes page merge logic exactly ─────────────────
          // 1. Python-confirmed drops (fuel_drop_alerts) — primary source.
          const pythonAlerts = await this.consumptionService.getPythonAlerts(v.imei, from, to, unit);
          const pythonTimes  = pythonAlerts.map((a) => new Date(a.at).getTime());

          // 2. NestJS confirmed drops (analyzeRows) — same source as Routes page,
          //    secondary to Python, deduped ±5 min.
          let nestConfirmed: Array<{ at: string; fuelBefore: number; fuelAfter: number; consumed: number }> = [];
          try {
            const c = await this.consumptionService.getConsumption(v.imei, from, to, sensor, v.fcr ?? '');
            nestConfirmed = (c.drops ?? []).filter((d) => d.isConfirmedDrop === true);
          } catch { /* no data — skip secondary */ }

          // ── Build event list ───────────────────────────────────────────
          // Python drops first; GPS resolved via 60-min GPS lookup.
          for (const alert of pythonAlerts) {
            const gps = await this.dynQuery.getNearestGpsPoint(v.imei, new Date(alert.at), 60);
            const hasGps = gps && gps.lat && gps.lng && !(gps.lat === 0 && gps.lng === 0);
            allEvents.push({
              imei: v.imei, name: v.name, plateNumber: v.plate_number,
              at: alert.at, fuelBefore: alert.fuelBefore,
              fuelAfter: alert.fuelAfter, consumed: alert.consumed,
              lat: hasGps ? gps!.lat : null,
              lng: hasGps ? gps!.lng : null,
            });
          }

          // NestJS confirmed drops not already covered by a Python alert (±5 min).
          for (const drop of nestConfirmed) {
            const dropMs  = new Date(drop.at).getTime();
            const inPython = pythonTimes.some((t) => Math.abs(t - dropMs) < 5 * 60 * 1000);
            if (inPython) continue;

            const gps = await this.dynQuery.getNearestGpsPoint(v.imei, new Date(drop.at), 60);
            const hasGps = gps && gps.lat && gps.lng && !(gps.lat === 0 && gps.lng === 0);
            allEvents.push({
              imei: v.imei, name: v.name, plateNumber: v.plate_number,
              at: drop.at, fuelBefore: drop.fuelBefore,
              fuelAfter: drop.fuelAfter, consumed: drop.consumed,
              lat: hasGps ? gps!.lat : null,
              lng: hasGps ? gps!.lng : null,
            });
          }
        } catch (err) {
          this.logger.warn(`TheftLocations skip IMEI=${v.imei}: ${String(err)}`);
        }
      }),
    );

    allEvents.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

    return {
      from: from.toISOString(),
      to:   to.toISOString(),
      totalEvents: allEvents.length,
      events: allEvents,
    };
  }

  // ─── 11. Trips Report ─────────────────────────────────────────────────────

  async getTripsReport(userId: number, fromStr: string, toStr: string) {
    const { from, to } = this.parseDateRange(fromStr, toStr);
    const vehicles = await this.getUserVehicles(userId);

    let fleetTotalTrips = 0;
    let fleetTotalDistance = 0;
    let fleetTripFuel = 0;
    let fleetPeriodFuel = 0;
    let fleetTotalDuration = 0;

    const results = await Promise.all(
      vehicles.map(async (v) => {
        try {
          const sensor = await this.sensorResolver.resolveFuelSensor(v.imei);
          const [analysis, consumption] = await Promise.all([
            this.tripAnalyzerService.analyzeTrips(v.imei, from, to, sensor),
            this.consumptionService.getConsumption(
              v.imei,
              from,
              to,
              sensor,
              v.fcr ?? '',
            ),
          ]);

          const normalized = normalizeTripFuelToPeriod(analysis, consumption);

          fleetTotalTrips += analysis.totalTrips;
          fleetTotalDistance += analysis.totalDistanceKm;
          fleetTripFuel += normalized.tripFuelConsumed;
          fleetPeriodFuel += normalized.totalFuelConsumed;
          fleetTotalDuration += analysis.totalDurationMinutes;

          return {
            imei: v.imei,
            name: v.name,
            plateNumber: v.plate_number,
            unit: analysis.unit,
            totalTrips: analysis.totalTrips,
            totalDistanceKm: analysis.totalDistanceKm,
            totalFuelConsumed: normalized.totalFuelConsumed,
            tripFuelConsumed: normalized.tripFuelConsumed,
            unassignedFuelConsumed: normalized.unassignedFuelConsumed,
            totalDurationMinutes: analysis.totalDurationMinutes,
            avgKmPerLiter: normalized.avgKmPerLiter,
            trips: normalized.trips,
            status: 'ok' as const,
          };
        } catch (err) {
          this.logger.warn(`Trips report skip IMEI ${v.imei}: ${String(err)}`);
          return {
            imei: v.imei,
            name: v.name,
            plateNumber: v.plate_number,
            unit: 'L' as const,
            totalTrips: 0,
            totalDistanceKm: 0,
            totalFuelConsumed: 0,
            tripFuelConsumed: 0,
            unassignedFuelConsumed: 0,
            totalDurationMinutes: 0,
            avgKmPerLiter: null as number | null,
            trips: [],
            status: 'no_data' as const,
          };
        }
      }),
    );

    const validVehicles = results.filter(
      (r) => r.status === 'ok' && (r.totalTrips > 0 || r.totalFuelConsumed > 0),
    );
    const fleetAvgKmPerLiter =
      fleetTripFuel > 0 && fleetTotalDistance > 0
        ? Math.round((fleetTotalDistance / fleetTripFuel) * 100) / 100
        : null;

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      fleetTotals: {
        totalTrips: fleetTotalTrips,
        totalDistanceKm: Math.round(fleetTotalDistance * 100) / 100,
        totalFuelConsumed: Math.round(fleetPeriodFuel * 100) / 100,
        tripFuelConsumed: Math.round(fleetTripFuel * 100) / 100,
        unassignedFuelConsumed:
          Math.round(Math.max(0, fleetPeriodFuel - fleetTripFuel) * 100) / 100,
        totalDurationMinutes: Math.round(fleetTotalDuration * 100) / 100,
        avgKmPerLiter: fleetAvgKmPerLiter,
      },
      vehicles: validVehicles.sort((a, b) => b.totalTrips - a.totalTrips),
    };
  }
}
