import {
  BadRequestException,
  Controller,
  Get,
  Logger,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ImeiOwnershipGuard } from '../common/guards/imei-ownership.guard';
import {
  FuelSensor,
  FuelSensorResolverService,
} from './services/fuel-sensor-resolver.service';
import { FuelTransformService } from './services/fuel-transform.service';
import { DynamicTableQueryService } from './services/dynamic-table-query.service';
import {
  FuelHistoryService,
  FuelInterval,
} from './services/fuel-history.service';
import { FuelConsumptionService } from './services/fuel-consumption.service';
import { FuelStatsService } from './services/fuel-stats.service';
import { ThriftService } from './services/thrift.service';
import { TheftDetectionService } from './services/theft-detection.service';
import { FuelHistoryDto } from './dto/fuel-history.dto';
import { FuelConsumptionDto } from './dto/fuel-consumption.dto';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

@Controller('vehicles/:imei/fuel')
@UseGuards(AuthGuard('jwt'), ImeiOwnershipGuard)
export class FuelController {
  private readonly logger = new Logger(FuelController.name);

  constructor(
    private readonly sensorResolver: FuelSensorResolverService,
    private readonly transform: FuelTransformService,
    private readonly dynQuery: DynamicTableQueryService,
    private readonly historyService: FuelHistoryService,
    private readonly consumptionService: FuelConsumptionService,
    private readonly statsService: FuelStatsService,
    private readonly thriftService: ThriftService,
    private readonly theftDetectionService: TheftDetectionService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /**
   * GET /vehicles/:imei/fuel/sensors
   * List all fuel sensors configured for this vehicle.
   * Use sensorId from here to filter other endpoints.
   */
  @Get('sensors')
  async listSensors(@Param('imei') imei: string) {
    this.logger.log(`GET /vehicles/${imei}/fuel/sensors`);
    const sensors = await this.sensorResolver.resolveAllFuelSensors(imei);
    return {
      success: true,
      message: `${sensors.length} fuel sensor(s) found`,
      data: {
        imei,
        count: sensors.length,
        sensors: sensors.map((s) => ({
          sensorId: s.sensorId,
          name: s.name,
          type: s.type,
          param: s.param,
          units: s.units,
          formula: s.formula || null,
          hasCalibration: s.calibration.length > 0,
        })),
      },
    };
  }

  /**
   * GET /vehicles/:imei/fuel/current?sensorId=
   * Latest fuel level. If vehicle has multiple tanks:
   *   - No sensorId → returns each tank separately + combined total
   *   - ?sensorId=123 → returns only that specific tank
   */
  @Get('current')
  async getCurrentFuel(
    @Param('imei') imei: string,
    @Query('sensorId') sensorIdStr?: string,
  ) {
    this.logger.log(
      `GET /vehicles/${imei}/fuel/current sensorId=${sensorIdStr}`,
    );

    const row = await this.dynQuery.getLatestRestingRow(imei);
    const ts = row ? new Date(row.dt_tracker).toISOString() : null;

    if (sensorIdStr) {
      const sensorId = parseInt(sensorIdStr, 10);
      if (isNaN(sensorId))
        throw new BadRequestException('sensorId must be a number');
      const sensor = await this.sensorResolver.resolveSensorById(
        imei,
        sensorId,
      );
      const value = row
        ? this.readSensorValue(row.params, sensor, imei, ts!)
        : null;
      return {
        success: true,
        message: 'Current fuel level fetched',
        data: {
          imei,
          sensorId: sensor.sensorId,
          sensorName: sensor.name,
          fuel: value?.value ?? null,
          unit: sensor.units || 'L',
          method: value?.method ?? null,
          lastSeen: ts,
          speed: row?.speed ?? null,
          lat: row?.lat ?? null,
          lng: row?.lng ?? null,
        },
      };
    }

    // Multiple sensors: return each tank + combined total
    const sensors = await this.sensorResolver.resolveAllFuelSensors(imei);
    const tanks = sensors.map((sensor) => {
      const value = row
        ? this.readSensorValue(row.params, sensor, imei, ts!)
        : null;
      return {
        sensorId: sensor.sensorId,
        sensorName: sensor.name,
        fuel: value?.value ?? null,
        unit: sensor.units || 'L',
        method: value?.method ?? null,
      };
    });

    const totalFuel = tanks.every((t) => t.fuel !== null)
      ? Math.round(tanks.reduce((sum, t) => sum + (t.fuel ?? 0), 0) * 100) / 100
      : null;

    return {
      success: true,
      message: 'Current fuel level fetched',
      data: {
        imei,
        // Mirrors the single-sensor (?sensorId=) response shape — every
        // frontend consumer of this endpoint reads `fuel`/`method` and never
        // requests a sensorId, so without these two fields "current fuel"
        // always renders as 0 regardless of the vehicle's actual level.
        fuel: totalFuel,
        method: tanks[0]?.method ?? null,
        totalFuel,
        unit: tanks[0]?.unit || 'L',
        tanks,
        lastSeen: ts,
        speed: row?.speed ?? null,
        lat: row?.lat ?? null,
        lng: row?.lng ?? null,
      },
    };
  }

  /**
   * GET /vehicles/:imei/fuel/history?from=&to=&interval=&sensorId=&tz=
   * If sensorId given → history for that tank only.
   * If not given and multiple sensors exist → primary sensor (first by priority).
   */
  @Get('history')
  async getFuelHistory(
    @Param('imei') imei: string,
    @Query() query: FuelHistoryDto,
    @Query('sensorId') sensorIdStr?: string,
  ) {
    this.logger.log(
      `GET /vehicles/${imei}/fuel/history from=${query.from} to=${query.to} interval=${query.interval} sensorId=${sensorIdStr}`,
    );

    const { from, to } = this.parseDateRange(query.from, query.to);
    const sensor = await this.resolveSensor(imei, sensorIdStr);

    const result = await this.historyService.getHistory(
      imei,
      from,
      to,
      sensor,
      query.interval as FuelInterval | undefined,
      query.tz,
    );

    return {
      success: true,
      message: 'Fuel history fetched successfully',
      data: { ...result, sensorId: sensor.sensorId, sensorName: sensor.name },
    };
  }

  /**
   * GET /vehicles/:imei/fuel/consumption?from=&to=&sensorId=
   * If sensorId given → consumption for that tank only.
   * If not given and multiple sensors → sums consumption across ALL tanks.
   */
  @Get('consumption')
  async getFuelConsumption(
    @Param('imei') imei: string,
    @Query() query: FuelConsumptionDto,
    @Query('sensorId') sensorIdStr?: string,
  ) {
    this.logger.log(
      `GET /vehicles/${imei}/fuel/consumption from=${query.from} to=${query.to} sensorId=${sensorIdStr}`,
    );

    const { from, to } = this.parseDateRange(query.from, query.to);
    const fcrJson = await this.getFcr(imei);

    if (sensorIdStr) {
      const sensor = await this.resolveSensor(imei, sensorIdStr);
      const result = await this.consumptionService.getConsumption(
        imei,
        from,
        to,
        sensor,
        fcrJson,
      );
      return {
        success: true,
        message: 'Fuel consumption calculated',
        data: result,
      };
    }

    // Multiple sensors: sum across all tanks
    const sensors = await this.sensorResolver.resolveAllFuelSensors(imei);

    if (sensors.length === 1) {
      const result = await this.consumptionService.getConsumption(
        imei,
        from,
        to,
        sensors[0],
        fcrJson,
      );
      return {
        success: true,
        message: 'Fuel consumption calculated',
        data: result,
      };
    }

    // Multi-tank: calculate per tank then aggregate
    const tankResults = await Promise.all(
      sensors.map((sensor) =>
        this.consumptionService.getConsumption(imei, from, to, sensor, fcrJson),
      ),
    );

    const totalConsumed =
      Math.round(tankResults.reduce((s, r) => s + r.consumed, 0) * 100) / 100;
    const totalRefueled =
      Math.round(tankResults.reduce((s, r) => s + r.refueled, 0) * 100) / 100;
    const totalCost = tankResults.every((r) => r.estimatedCost !== null)
      ? Math.round(
          tankResults.reduce((s, r) => s + (r.estimatedCost ?? 0), 0) * 100,
        ) / 100
      : null;

    // Merge and de-duplicate drops/refuels across all tanks.
    // Events from different sensors at the same timestamp are collapsed
    // so the same physical fuel change is not double-counted.
    const allDropsSeen = new Set<string>();
    const mergedDrops = tankResults
      .flatMap((r) => r.drops)
      .filter((d) => {
        const key = `${d.at}:${d.consumed}`;
        if (allDropsSeen.has(key)) return false;
        allDropsSeen.add(key);
        return true;
      })
      .sort((a, b) => a.at.localeCompare(b.at));

    const allRefuelsSeen = new Set<string>();
    const mergedRefuels = tankResults
      .flatMap((r) => r.refuels)
      .filter((r) => {
        const key = `${r.at}:${r.added}`;
        if (allRefuelsSeen.has(key)) return false;
        allRefuelsSeen.add(key);
        return true;
      })
      .sort((a, b) => a.at.localeCompare(b.at));

    return {
      success: true,
      message: 'Fuel consumption calculated (multi-tank)',
      data: {
        imei,
        from: from.toISOString(),
        to: to.toISOString(),
        consumed: totalConsumed,
        refueled: totalRefueled,
        estimatedCost: totalCost,
        unit: sensors[0].units || 'L',
        refuelEvents: tankResults.reduce((s, r) => s + r.refuelEvents, 0),
        samples: tankResults.reduce((s, r) => s + r.samples, 0),
        drops: mergedDrops,
        refuels: mergedRefuels,
        tanks: tankResults.map((r, i) => ({
          sensorId: sensors[i].sensorId,
          sensorName: sensors[i].name,
          consumed: r.consumed,
          refueled: r.refueled,
          refuelEvents: r.refuelEvents,
        })),
      },
    };
  }

  /**
   * GET /vehicles/:imei/fuel/refuels?from=&to=&sensorId=
   */
  @Get('refuels')
  async getRefuels(
    @Param('imei') imei: string,
    @Query() query: FuelConsumptionDto,
    @Query('sensorId') sensorIdStr?: string,
  ) {
    this.logger.log(
      `GET /vehicles/${imei}/fuel/refuels from=${query.from} to=${query.to} sensorId=${sensorIdStr}`,
    );

    const { from, to } = this.parseDateRange(query.from, query.to);
    const fcrJson = await this.getFcr(imei);
    const sensors = sensorIdStr
      ? [await this.resolveSensor(imei, sensorIdStr)]
      : await this.sensorResolver.resolveAllFuelSensors(imei);

    const allRefuels: Array<{
      sensorId: number;
      sensorName: string;
      at: string;
      fuelBefore: number;
      fuelAfter: number;
      added: number;
      unit: string;
    }> = [];

    for (const sensor of sensors) {
      const result = await this.consumptionService.getConsumption(
        imei,
        from,
        to,
        sensor,
        fcrJson,
      );
      for (const r of result.refuels) {
        allRefuels.push({
          sensorId: sensor.sensorId,
          sensorName: sensor.name,
          ...r,
        });
      }
    }

    allRefuels.sort((a, b) => a.at.localeCompare(b.at));

    return {
      success: true,
      message: 'Refuel events fetched',
      data: {
        imei,
        from: from.toISOString(),
        to: to.toISOString(),
        refuelEvents: allRefuels,
      },
    };
  }

  /**
   * GET /vehicles/:imei/fuel/debug?from=&to=&sensorId=
   */
  @Get('debug')
  async getDebug(
    @Param('imei') imei: string,
    @Query() query: FuelConsumptionDto,
    @Query('sensorId') sensorIdStr?: string,
  ) {
    this.logger.log(
      `GET /vehicles/${imei}/fuel/debug from=${query.from} to=${query.to} sensorId=${sensorIdStr}`,
    );

    const { from, to } = this.parseDateRange(query.from, query.to);
    const sensor = await this.resolveSensor(imei, sensorIdStr);
    const rows = await this.dynQuery.getRowsInRange(imei, from, to);

    const samples = rows.map((row) => {
      const ts = new Date(row.dt_tracker).toISOString();
      const rawValue = this.transform.extractRawValue(
        row.params,
        sensor.param,
        imei,
        ts,
      );
      const { value, method } =
        rawValue !== null
          ? this.transform.transform(rawValue, sensor)
          : { value: null, method: 'raw' as const };
      return { dt: ts, rawValue, transformedValue: value, method };
    });

    const fcrJson = await this.getFcr(imei);
    const result = await this.consumptionService.getConsumption(
      imei,
      from,
      to,
      sensor,
      fcrJson,
    );

    return {
      success: true,
      message: 'Debug data fetched',
      data: {
        sensor: {
          sensorId: sensor.sensorId,
          name: sensor.name,
          param: sensor.param,
          formula: sensor.formula || null,
          calibration: sensor.calibration,
          units: sensor.units,
        },
        samples: samples.slice(0, 200),
        totalSamples: samples.length,
        detectedRefuels: result.refuels,
        detectedDrops: result.drops,
      },
    };
  }

  /**
   * GET /vehicles/:imei/fuel/thrift?from=&to=&sensorId=
   * Thrift analysis:
   *   - highSpeedDrain  → fuel wasted while driving > 100 km/h
   *   - idleDrain       → fuel wasted while parked (engine on)
   *   - dailyTrend      → per-day consumed, distance, km/L, rating
   *   - thriftScore     → 0-100 score with rating (excellent/good/average/poor)
   */
  @Get('thrift')
  async getThrift(
    @Param('imei') imei: string,
    @Query() query: FuelConsumptionDto,
    @Query('sensorId') sensorIdStr?: string,
  ) {
    this.logger.log(
      `GET /vehicles/${imei}/fuel/thrift from=${query.from} to=${query.to} sensorId=${sensorIdStr}`,
    );

    const { from, to } = this.parseDateRange(query.from, query.to);
    const sensor = await this.resolveSensor(imei, sensorIdStr);

    const result = await this.thriftService.getThrift(imei, from, to, sensor);

    return {
      success: true,
      message: 'Thrift analysis calculated',
      data: result,
    };
  }

  /**
   * GET /vehicles/:imei/fuel/stats?from=&to=&sensorId=
   * Full stats: efficiency (km/L), idle drain, avg daily consumption,
   * fuel timeline (biggest drop/refuel, lowest/highest level), drops[], refuels[].
   */
  @Get('stats')
  async getFuelStats(
    @Param('imei') imei: string,
    @Query() query: FuelConsumptionDto,
    @Query('sensorId') sensorIdStr?: string,
  ) {
    this.logger.log(
      `GET /vehicles/${imei}/fuel/stats from=${query.from} to=${query.to} sensorId=${sensorIdStr}`,
    );

    const { from, to } = this.parseDateRange(query.from, query.to);
    const sensor = await this.resolveSensor(imei, sensorIdStr);
    const fcrJson = await this.getFcr(imei);
    const pricePerLiter = this.parsePricePerLiter(fcrJson, from);

    const result = await this.statsService.getStats(
      imei,
      from,
      to,
      sensor,
      pricePerLiter,
    );

    return {
      success: true,
      message: 'Fuel stats calculated',
      data: result,
    };
  }

  /**
   * GET /vehicles/:imei/fuel/drop-alerts?from=&to=
   * Returns confirmed fuel drop alerts written by the Python monitoring script.
   * These are the ground-truth alerts (same source as the email alerts).
   */
  @Get('drop-alerts')
  async getDropAlerts(
    @Param('imei') imei: string,
    @Query() query: FuelConsumptionDto,
  ) {
    this.logger.log(
      `GET /vehicles/${imei}/fuel/drop-alerts from=${query.from} to=${query.to}`,
    );
    const { from, to } = this.parseDateRange(query.from, query.to);
    const unit = 'Liters';
    const alerts = await this.consumptionService.getPythonAlerts(
      imei,
      from,
      to,
      unit,
    );
    return {
      success: true,
      message: `${alerts.length} confirmed drop alert(s) found`,
      data: {
        imei,
        from: from.toISOString(),
        to: to.toISOString(),
        count: alerts.length,
        drops: alerts,
      },
    };
  }

  /**
   * GET /vehicles/:imei/fuel/theft?from=&to=&sensorId=
   * Theft detection: analyzes fuel drops to detect suspicious patterns and potential theft.
   * Returns classified drops (normal/suspicious/theft) with risk score and alerts.
   */
  @Get('theft')
  async getTheftDetection(
    @Param('imei') imei: string,
    @Query() query: FuelConsumptionDto,
    @Query('sensorId') sensorIdStr?: string,
  ) {
    this.logger.log(
      `GET /vehicles/${imei}/fuel/theft from=${query.from} to=${query.to} sensorId=${sensorIdStr}`,
    );

    const { from, to } = this.parseDateRange(query.from, query.to);
    const sensor = await this.resolveSensor(imei, sensorIdStr);

    const result = await this.theftDetectionService.detectTheft(
      imei,
      from,
      to,
      sensor,
    );

    return {
      success: true,
      message: 'Theft detection analysis completed',
      data: result,
    };
  }

  /**
   * GET /vehicles/:imei/fuel/route?from=&to=
   * Returns GPS track points for a trip (used to draw the route polyline on the map).
   * Points are downsampled to ≤ 600 for performant map rendering.
   */
  @Get('route')
  async getTripRoute(
    @Param('imei') imei: string,
    @Query() query: FuelConsumptionDto,
  ) {
    this.logger.log(`GET /vehicles/${imei}/fuel/route from=${query.from} to=${query.to}`);
    const { from, to } = this.parseDateRange(query.from, query.to);

    const rows = await this.dynQuery.getRowsInRangeOrEmpty(imei, from, to);

    // Filter out invalid / zero coordinates
    const valid = rows.filter(
      (r) => r.lat && r.lng && !(r.lat === 0 && r.lng === 0),
    );

    // Downsample so the frontend never receives > 600 points
    const MAX_POINTS = 600;
    const step = Math.max(1, Math.floor(valid.length / MAX_POINTS));
    const points = valid
      .filter((_, i) => i % step === 0 || i === valid.length - 1)
      .map((r) => ({
        lat:   r.lat,
        lng:   r.lng,
        speed: r.speed ?? 0,
        ts:    r.dt_tracker instanceof Date
          ? r.dt_tracker.toISOString()
          : new Date(r.dt_tracker).toISOString(),
      }));

    return {
      success: true,
      message: `${points.length} GPS points returned`,
      data: { points, totalPoints: points.length },
    };
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private async resolveSensor(
    imei: string,
    sensorIdStr?: string,
  ): Promise<FuelSensor> {
    if (sensorIdStr) {
      const sensorId = parseInt(sensorIdStr, 10);
      if (isNaN(sensorId))
        throw new BadRequestException('sensorId must be a number');
      return this.sensorResolver.resolveSensorById(imei, sensorId);
    }
    return this.sensorResolver.resolveFuelSensor(imei);
  }

  private readSensorValue(
    paramsJson: string,
    sensor: FuelSensor,
    imei: string,
    ts: string,
  ) {
    const rawValue = this.transform.extractRawValue(
      paramsJson,
      sensor.param,
      imei,
      ts,
    );
    if (rawValue === null) return null;
    return this.transform.transform(rawValue, sensor);
  }

  private parseDateRange(
    fromStr: string,
    toStr: string,
  ): { from: Date; to: Date } {
    const from = new Date(fromStr);
    const to = new Date(toStr);

    if (isNaN(from.getTime()) || isNaN(to.getTime())) {
      throw new BadRequestException('Invalid date format. Use ISO 8601 UTC.');
    }
    if (from >= to) {
      throw new BadRequestException("'from' must be before 'to'");
    }
    return { from, to };
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
}
