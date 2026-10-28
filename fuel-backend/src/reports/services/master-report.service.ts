import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import {
  FuelSensor,
  FuelSensorResolverService,
} from '../../fuel/services/fuel-sensor-resolver.service';
import {
  FuelConsumptionService,
  periodConsumed,
} from '../../fuel/services/fuel-consumption.service';
import { FuelTransformService } from '../../fuel/services/fuel-transform.service';
import {
  DataRow,
  DynamicTableQueryService,
} from '../../fuel/services/dynamic-table-query.service';
import {
  TripAnalyzerService,
  normalizeTripFuelToPeriod,
} from '../../fuel/services/trip-analyzer.service';
import { TheftDetectionService } from '../../fuel/services/theft-detection.service';
import { drainOf, drainShares } from '../../fuel/services/fuel-drain.util';
import { trackDistanceKm } from '../../fuel/services/track-distance.util';
import {
  AssignmentRecord,
  AssignmentRepository,
  RouteEvent,
} from '../../dispatch/services/assignment.repository';
import {
  RouteRecord,
  RouteRepository,
} from '../../dispatch/services/route.repository';
import { StopCompletionRepository } from '../../dispatch/services/stop-completion.repository';
import { LatLng } from '../../dispatch/services/geo.util';
import { CorridorIndex } from './corridor-index';
import { ReportsService } from '../reports.service';

// ─── Tuning ──────────────────────────────────────────────────────────────────

/** Speed above which fuel burn is attributed to "high speed" waste. */
const HIGH_SPEED_KMH = 100;
/** Telemetry gaps longer than this are offline, not engine-on time. */
const MAX_ENGINE_GAP_MS = 30 * 60 * 1000;
/** Distance filters — mirror TripAnalyzerService so totals stay comparable. */
const MAX_DISTANCE_SEGMENT_GAP_MS = 5 * 60 * 1000;
const MIN_DISTANCE_SEGMENT_KM = 0.02;
const MAX_REASONABLE_SEGMENT_SPEED_KMH = 160;
/** Points kept per assignment track in the payload (map rendering). */
const TRACK_POINT_BUDGET = 600;
/** Points measured against the corridor per assignment (deviation detection). */
const CORRIDOR_SAMPLE_BUDGET = 1500;
/** Points kept per planned-route polyline in the payload. */
const GEOMETRY_POINT_BUDGET = 1500;
/** Points kept per deviation excursion path in the payload. */
const EXCURSION_POINT_BUDGET = 120;
/**
 * A deviation must stay outside the corridor at least this long to be reported
 * as an excursion — matches DeviationService's alerting hysteresis, so a lone
 * GPS jitter fix never becomes a "proven" deviation.
 */
const EXCURSION_MIN_MS = 90_000;
/** Two off-corridor runs closer than this are one excursion, not two. */
const EXCURSION_MERGE_GAP_MS = 3 * 60 * 1000;
/** A logged event within this window of an excursion is attached to it. */
const EVENT_MATCH_SLACK_MS = 10 * 60 * 1000;
/** Safety valve on payload size for very wide ranges. */
const MAX_ASSIGNMENTS = 60;

// ─── Shapes ──────────────────────────────────────────────────────────────────

interface Sample {
  ts: Date;
  lat: number;
  lng: number;
  speed: number;
  fuel: number | null;
  ignition: boolean;
}

export interface TrackPoint {
  at: string;
  lat: number;
  lng: number;
  speed: number;
}

export interface DeviationEventDetail {
  eventId: number;
  type: string;
  at: string;
  lat: number | null;
  lng: number | null;
  distanceM: number | null;
  actor: string;
  note: string | null;
  remark: string | null;
}

export interface DeviationExcursion {
  excursionId: string;
  assignmentId: number;
  routeName: string | null;
  driverName: string | null;
  startedAt: string;
  endedAt: string;
  durationMinutes: number;
  maxDistanceM: number;
  avgDistanceM: number;
  corridorBufferM: number;
  /** Farthest point of the excursion — the headline "where" of the deviation. */
  peak: { lat: number; lng: number; at: string };
  /** Off-corridor portion of the actual track: the map proof. */
  path: LatLng[];
  /** Whether the vehicle came back inside the corridor before the job ended. */
  returnedToRoute: boolean;
  /** Distance driven while off-corridor. */
  offRouteDistanceKm: number;
  /** Logged deviation events (with operator remarks) that fall in this window. */
  events: DeviationEventDetail[];
  /** Operator remarks attached to those events — the recorded explanation. */
  remarks: string[];
}

export interface MasterStopDetail {
  stopId: number | null;
  seq: number;
  name: string | null;
  lat: number;
  lng: number;
  radiusM: number;
  /** completed = driver-confirmed; visited = GPS reached it; skipped/missed otherwise. */
  status: 'completed' | 'visited' | 'skipped' | 'missed';
  completedAt: string | null;
  /** Driver→bin distance recorded at completion. */
  completionDistanceM: number | null;
  inRange: boolean | null;
  photoPath: string | null;
  note: string | null;
  /** Operator remark from the skip alert for this stop, if any. */
  skipRemark: string | null;
}

export interface MasterAssignmentDetail {
  assignmentId: number;
  routeId: number;
  routeName: string | null;
  driverId: number;
  driverName: string | null;
  status: string;
  priority: string;
  persistent: boolean;
  notes: string | null;
  scheduledStart: string | null;
  startedAt: string | null;
  completedAt: string | null;
  /** Window actually analysed (assignment window clipped to the report range). */
  windowFrom: string;
  windowTo: string;
  corridorBufferM: number;
  plannedDistanceKm: number | null;
  depot: { name: string | null; lat: number; lng: number } | null;
  plannedGeometry: LatLng[];
  actualTrack: TrackPoint[];
  stops: MasterStopDetail[];
  excursions: DeviationExcursion[];
  stats: {
    stopsTotal: number;
    stopsCompleted: number;
    stopsSkipped: number;
    stopsMissed: number;
    completionRatePct: number;
    distanceKm: number;
    durationMinutes: number | null;
    excursionCount: number;
    maxDeviationM: number;
    gpsFixes: number;
    photoProofCount: number;
  };
}

// ─── Service ─────────────────────────────────────────────────────────────────

/**
 * The master vehicle report: one vehicle, one date range, everything the
 * platform knows about it — fuel, distance, trips, engine time, theft signals,
 * dispatch assignments, per-bin proof, and route deviations with the map
 * evidence and operator remarks behind each one.
 *
 * All GPS telemetry is read once and reused by every section, so adding a
 * section costs aggregation rather than another full-range table scan.
 */
@Injectable()
export class MasterReportService {
  private readonly logger = new Logger(MasterReportService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly reports: ReportsService,
    private readonly sensorResolver: FuelSensorResolverService,
    private readonly consumptionService: FuelConsumptionService,
    private readonly transform: FuelTransformService,
    private readonly dynQuery: DynamicTableQueryService,
    private readonly tripAnalyzer: TripAnalyzerService,
    private readonly theftDetection: TheftDetectionService,
    private readonly assignments: AssignmentRepository,
    private readonly routes: RouteRepository,
    private readonly completions: StopCompletionRepository,
  ) {}

  async getMasterReport(
    userId: number,
    imei: string,
    fromStr: string,
    toStr: string,
  ) {
    const { from, to } = this.reports.parseDateRange(fromStr, toStr);
    const vehicle = await this.getOwnedVehicle(userId, imei);

    const sensor = await this.sensorResolver
      .resolveFuelSensor(imei)
      .catch(() => null);

    const rows = await this.dynQuery
      .getRowsInRangeOrEmpty(imei, from, to)
      .catch((err) => {
        this.logger.warn(
          `Master report: no telemetry for ${imei}: ${String(err)}`,
        );
        return [] as DataRow[];
      });

    const samples = this.enrich(rows, sensor, imei);

    const [consumption, tripAnalysis, theft, assignmentRecords] =
      await Promise.all([
        sensor
          ? this.consumptionService
              .getConsumption(imei, from, to, sensor, vehicle.fcr ?? '')
              .catch((err) => {
                this.logger.warn(
                  `Master report consumption ${imei}: ${String(err)}`,
                );
                return null;
              })
          : Promise.resolve(null),
        sensor
          ? this.tripAnalyzer
              .analyzeTrips(imei, from, to, sensor)
              .catch((err) => {
                this.logger.warn(`Master report trips ${imei}: ${String(err)}`);
                return null;
              })
          : Promise.resolve(null),
        sensor
          ? this.theftDetection
              .detectTheft(imei, from, to, sensor)
              .catch((err) => {
                this.logger.warn(`Master report theft ${imei}: ${String(err)}`);
                return null;
              })
          : Promise.resolve(null),
        this.assignments
          .listForVehicleInRange(userId, imei, from, to)
          .catch((err) => {
            this.logger.warn(
              `Master report assignments ${imei}: ${String(err)}`,
            );
            return [] as AssignmentRecord[];
          }),
      ]);

    const movement = this.summariseMovement(samples);
    // Idle / high-speed are shares of the period's real burn (fuel-drain.util).
    const shares = drainShares(samples, HIGH_SPEED_KMH);

    const truncatedAssignments = assignmentRecords.length > MAX_ASSIGNMENTS;
    const analysed = await this.buildAssignments(
      userId,
      assignmentRecords.slice(0, MAX_ASSIGNMENTS),
      samples,
      from,
      to,
    );

    const unit = sensor?.units || consumption?.unit || 'L';
    const periodConsumedLiters = consumption ? periodConsumed(consumption) : 0;
    const idleBurn = drainOf(periodConsumedLiters, shares.idle);
    const highSpeedBurn = drainOf(periodConsumedLiters, shares.highSpeed);

    // Trips' raw per-trip fuel (a drop-sum within each trip window) can
    // inflate under sensor oscillation just like the whole-period drop sum
    // did — normalize it against the same reliable mass balance the "fuel"
    // section above uses, so a trip's figure here never disagrees with the
    // /reports/trips report for the same trip.
    const normalizedTripFuel =
      tripAnalysis && consumption
        ? normalizeTripFuelToPeriod(tripAnalysis, consumption)
        : null;

    const excursions = analysed.flatMap((a) => a.excursions);
    const stopTotals = analysed.reduce(
      (acc, a) => ({
        stops: acc.stops + a.stats.stopsTotal,
        completed: acc.completed + a.stats.stopsCompleted,
        skipped: acc.skipped + a.stats.stopsSkipped,
        missed: acc.missed + a.stats.stopsMissed,
        photos: acc.photos + a.stats.photoProofCount,
      }),
      { stops: 0, completed: 0, skipped: 0, missed: 0, photos: 0 },
    );

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      generatedAt: new Date().toISOString(),

      vehicle: {
        imei: vehicle.imei,
        name: vehicle.name,
        plateNumber: vehicle.plate_number,
        model: vehicle.model ?? null,
        device: vehicle.device ?? null,
        simNumber: vehicle.sim_number ?? null,
        lastSeen: vehicle.dt_tracker
          ? new Date(vehicle.dt_tracker).toISOString()
          : null,
        online: this.isOnline(vehicle.dt_tracker),
        fuelSensor: sensor
          ? {
              name: sensor.name,
              param: sensor.param,
              unit: sensor.units || 'L',
            }
          : null,
      },

      /** Everything downstream is derived from this many raw fixes. */
      telemetry: {
        gpsFixes: samples.length,
        firstFixAt: samples.length ? samples[0].ts.toISOString() : null,
        lastFixAt: samples.length
          ? samples[samples.length - 1].ts.toISOString()
          : null,
        hasFuelData: samples.some((s) => s.fuel !== null),
      },

      fuel: {
        unit,
        consumed: round2(periodConsumedLiters),
        refueled: round2(consumption?.refueled ?? 0),
        refuelEventCount: consumption?.refuelEvents ?? 0,
        estimatedCost: consumption?.estimatedCost ?? null,
        openingFuel: consumption?.firstFuel ?? null,
        closingFuel: consumption?.lastFuel ?? null,
        netDrop: consumption?.netDrop ?? null,
        idleLiters: idleBurn.liters,
        idlePercentage: idleBurn.percentage,
        highSpeedLiters: highSpeedBurn.liters,
        highSpeedPercentage: highSpeedBurn.percentage,
        highSpeedEvents: shares.highSpeedEvents,
        speedThresholdKmh: HIGH_SPEED_KMH,
        refuels: consumption?.refuels ?? [],
      },

      distance: {
        totalDistanceKm: round2(movement.distanceKm),
        tripDistanceKm: round2(tripAnalysis?.totalDistanceKm ?? 0),
        /** Distance covered while working a dispatch assignment. */
        onAssignmentDistanceKm: round2(
          analysed.reduce((s, a) => s + a.stats.distanceKm, 0),
        ),
        kmPerLiter:
          periodConsumedLiters > 0 && movement.distanceKm > 0
            ? round2(movement.distanceKm / periodConsumedLiters)
            : null,
        maxSpeedKmh: round2(movement.maxSpeed),
        avgMovingSpeedKmh: round2(movement.avgMovingSpeed),
      },

      engine: {
        engineOnHours: round2(movement.engineOnMs / 3_600_000),
        avgHoursPerDay: round2(
          movement.engineOnMs /
            3_600_000 /
            Math.max((to.getTime() - from.getTime()) / 86_400_000, 1),
        ),
        idleHours: round2(movement.idleMs / 3_600_000),
        movingHours: round2(movement.movingMs / 3_600_000),
        idleSharePct: pct(movement.idleMs, movement.idleMs + movement.movingMs),
      },

      trips: {
        totalTrips: tripAnalysis?.totalTrips ?? 0,
        totalDistanceKm: tripAnalysis?.totalDistanceKm ?? 0,
        totalFuelConsumed:
          normalizedTripFuel?.tripFuelConsumed ??
          tripAnalysis?.totalFuelConsumed ??
          0,
        totalDurationMinutes: tripAnalysis?.totalDurationMinutes ?? 0,
        avgKmPerLiter:
          normalizedTripFuel?.avgKmPerLiter ?? tripAnalysis?.avgKmPerLiter ?? null,
        items: normalizedTripFuel?.trips ?? tripAnalysis?.trips ?? [],
      },

      theft: theft
        ? {
            riskLevel: theft.riskLevel,
            riskScore: theft.riskScore,
            summary: theft.summary,
            alerts: theft.alerts,
          }
        : null,

      assignments: {
        total: assignmentRecords.length,
        analysed: analysed.length,
        truncated: truncatedAssignments,
        // No `cancelled` counter: cancelled assignments are withdrawn work and
        // are filtered out upstream, so it could only ever report zero.
        completed: assignmentRecords.filter((a) => a.status === 'completed')
          .length,
        inProgress: assignmentRecords.filter((a) =>
          ['accepted', 'en_route', 'arrived'].includes(a.status),
        ).length,
        notStarted: assignmentRecords.filter((a) => a.status === 'assigned')
          .length,
        stopsTotal: stopTotals.stops,
        stopsCompleted: stopTotals.completed,
        stopsSkipped: stopTotals.skipped,
        stopsMissed: stopTotals.missed,
        completionRatePct: pct(stopTotals.completed, stopTotals.stops),
        photoProofCount: stopTotals.photos,
        items: analysed,
      },

      deviations: {
        total: excursions.length,
        withRemarks: excursions.filter((e) => e.remarks.length > 0).length,
        maxDistanceM: excursions.reduce(
          (m, e) => Math.max(m, e.maxDistanceM),
          0,
        ),
        totalOffRouteKm: round2(
          excursions.reduce((s, e) => s + e.offRouteDistanceKm, 0),
        ),
        items: excursions.sort((a, b) => b.maxDistanceM - a.maxDistanceM),
      },
    };
  }

  // ─── Vehicle ───────────────────────────────────────────────────────────────

  private async getOwnedVehicle(userId: number, imei: string) {
    const rows: Array<{
      imei: string;
      name: string;
      plate_number: string;
      model: string | null;
      device: string | null;
      sim_number: string | null;
      dt_tracker: Date | null;
      fcr: string | null;
    }> = await this.dataSource.query(
      `SELECT o.imei, o.name, o.plate_number, o.model, o.device, o.sim_number,
              o.dt_tracker, o.fcr
       FROM gs_user_objects uo
       INNER JOIN gs_objects o ON o.imei = uo.imei
       WHERE uo.user_id = ? AND uo.imei = ?
       LIMIT 1`,
      [userId, imei],
    );
    if (!rows.length) {
      // Same response whether the vehicle is absent or simply not the caller's,
      // so the endpoint cannot be used to probe other users' fleets.
      throw new NotFoundException(`Vehicle ${imei} not found`);
    }
    return rows[0];
  }

  private isOnline(dtTracker: Date | null): boolean {
    if (!dtTracker) return false;
    const staleMinutes = this.config.get<number>('STALE_THRESHOLD_MINUTES', 30);
    return Date.now() - new Date(dtTracker).getTime() <= staleMinutes * 60_000;
  }

  // ─── Telemetry ─────────────────────────────────────────────────────────────

  private enrich(
    rows: DataRow[],
    sensor: FuelSensor | null,
    imei: string,
  ): Sample[] {
    const out: Sample[] = [];
    for (const row of rows) {
      const ts = new Date(row.dt_tracker);
      if (isNaN(ts.getTime())) continue;

      let fuel: number | null = null;
      if (sensor) {
        const raw = this.transform.extractRawValue(
          row.params,
          sensor.param,
          imei,
          ts.toISOString(),
        );
        if (raw !== null) {
          fuel = this.transform.transform(raw, sensor).value;
        }
      }

      let ignition = false;
      try {
        const p = JSON.parse(row.params) as Record<string, string | number>;
        ignition =
          p['acc'] === '1' ||
          p['acc'] === 1 ||
          p['io1'] === '1' ||
          p['io1'] === 1;
      } catch {
        /* tracker did not report ignition on this row */
      }

      out.push({
        ts,
        lat: Number(row.lat),
        lng: Number(row.lng),
        speed: Number(row.speed) || 0,
        fuel,
        ignition,
      });
    }
    return out.sort((a, b) => a.ts.getTime() - b.ts.getTime());
  }

  /** Distance, speed and engine/idle/moving time over a run of fixes. */
  private summariseMovement(samples: Sample[]) {
    let distanceKm = 0;
    let engineOnMs = 0;
    let idleMs = 0;
    let movingMs = 0;
    let maxSpeed = 0;
    let movingSpeedSum = 0;
    let movingSpeedCount = 0;

    for (let i = 0; i < samples.length; i++) {
      const curr = samples[i];
      if (curr.speed > maxSpeed) maxSpeed = curr.speed;
      if (curr.speed > 5) {
        movingSpeedSum += curr.speed;
        movingSpeedCount++;
      }
      if (i === 0) continue;

      const prev = samples[i - 1];
      const dtMs = curr.ts.getTime() - prev.ts.getTime();
      if (dtMs <= 0) continue;

      if (prev.ignition && dtMs <= MAX_ENGINE_GAP_MS) engineOnMs += dtMs;
      if (dtMs <= MAX_ENGINE_GAP_MS) {
        if (prev.speed > 5) movingMs += dtMs;
        // Idle = engine running while stopped. Counting every stopped minute
        // reported a parked, switched-off vehicle as idling 12 h a day.
        else if (prev.ignition) idleMs += dtMs;
      }

    }
    distanceKm = trackDistanceKm(samples);

    return {
      distanceKm,
      engineOnMs,
      idleMs,
      movingMs,
      maxSpeed,
      avgMovingSpeed: movingSpeedCount ? movingSpeedSum / movingSpeedCount : 0,
    };
  }


  // ─── Assignments, stops, deviations ────────────────────────────────────────

  private async buildAssignments(
    userId: number,
    records: AssignmentRecord[],
    samples: Sample[],
    from: Date,
    to: Date,
  ): Promise<MasterAssignmentDetail[]> {
    // Persistent assignments re-run the same route, so cache per route.
    const routeCache = new Map<number, RouteRecord | null>();
    const indexCache = new Map<number, CorridorIndex>();

    const out: MasterAssignmentDetail[] = [];
    for (const a of records) {
      try {
        if (!routeCache.has(a.routeId)) {
          routeCache.set(
            a.routeId,
            await this.routes.get(userId, a.routeId).catch(() => null),
          );
        }
        const route = routeCache.get(a.routeId) ?? null;

        const [events, stopCompletions] = await Promise.all([
          this.assignments.listEvents(a.assignmentId, 500).catch(() => []),
          this.completions.listForAssignment(a.assignmentId).catch(() => []),
        ]);

        const windowFrom = clampDate(
          a.startedAt ?? a.scheduledStart ?? a.createdAt,
          from,
          to,
        );
        const windowTo = clampDate(a.completedAt ?? to, from, to);
        const track = samples.filter(
          (s) =>
            s.ts >= windowFrom &&
            s.ts <= windowTo &&
            isValidCoord(s.lat, s.lng),
        );

        const geometry: LatLng[] =
          route && route.geometry.length >= 2
            ? route.geometry
            : (route?.stops ?? []).map((s) => ({ lat: s.lat, lng: s.lng }));

        if (route && geometry.length >= 2 && !indexCache.has(a.routeId)) {
          indexCache.set(a.routeId, new CorridorIndex(geometry));
        }
        const index = indexCache.get(a.routeId) ?? null;

        const corridorBufferM = route?.corridorBufferM ?? 150;
        const excursions =
          index && track.length
            ? this.detectExcursions(a, track, index, corridorBufferM)
            : [];
        this.attachEvents(excursions, events);

        const stops = this.buildStops(route, track, events, stopCompletions);
        const movement = this.summariseMovement(track);

        out.push({
          assignmentId: a.assignmentId,
          routeId: a.routeId,
          routeName: a.routeName,
          driverId: a.driverId,
          driverName: a.driverName,
          status: a.status,
          priority: a.priority,
          persistent: a.persistent,
          notes: a.notes,
          scheduledStart: isoOrNull(a.scheduledStart),
          startedAt: isoOrNull(a.startedAt),
          completedAt: isoOrNull(a.completedAt),
          windowFrom: windowFrom.toISOString(),
          windowTo: windowTo.toISOString(),
          corridorBufferM,
          plannedDistanceKm: route?.totalDistanceKm ?? null,
          depot: route?.depot
            ? {
                name: route.depot.name,
                lat: route.depot.lat,
                lng: route.depot.lng,
              }
            : null,
          plannedGeometry: downsample(geometry, GEOMETRY_POINT_BUDGET),
          actualTrack: downsample(track, TRACK_POINT_BUDGET).map((s) => ({
            at: s.ts.toISOString(),
            lat: s.lat,
            lng: s.lng,
            speed: s.speed,
          })),
          stops,
          excursions,
          stats: {
            stopsTotal: stops.length,
            stopsCompleted: stops.filter((s) => s.status === 'completed')
              .length,
            stopsSkipped: stops.filter((s) => s.status === 'skipped').length,
            stopsMissed: stops.filter((s) => s.status === 'missed').length,
            completionRatePct: pct(
              stops.filter((s) => s.status === 'completed').length,
              stops.length,
            ),
            distanceKm: round2(movement.distanceKm),
            durationMinutes:
              a.startedAt && a.completedAt
                ? round2(
                    (new Date(a.completedAt).getTime() -
                      new Date(a.startedAt).getTime()) /
                      60_000,
                  )
                : null,
            excursionCount: excursions.length,
            maxDeviationM: excursions.reduce(
              (m, e) => Math.max(m, e.maxDistanceM),
              0,
            ),
            gpsFixes: track.length,
            photoProofCount: stops.filter((s) => s.photoPath).length,
          },
        });
      } catch (err) {
        this.logger.warn(
          `Master report: assignment ${a.assignmentId} skipped: ${String(err)}`,
        );
      }
    }
    return out;
  }

  /**
   * Find every sustained excursion outside the route corridor and package it as
   * map-ready proof: when it started, how far off it got, the off-corridor
   * path, and whether the vehicle returned.
   *
   * This is measured from the recorded GPS trail rather than read from the
   * alert log, so it also reconstructs deviations the live monitor throttled or
   * never saw (it only alerts once per 10 minutes, and only while a job is
   * actively being monitored). Logged events — and the operator remarks on
   * them — are matched back onto these excursions by `attachEvents`.
   */
  private detectExcursions(
    a: AssignmentRecord,
    track: Sample[],
    index: CorridorIndex,
    bufferM: number,
  ): DeviationExcursion[] {
    const measured = downsample(track, CORRIDOR_SAMPLE_BUDGET).map((s) => ({
      s,
      d: index.distanceM({ lat: s.lat, lng: s.lng }),
    }));

    // Contiguous runs of off-corridor fixes, merging brief dips back inside
    // (a single fix clipping the corridor edge is not "returned to route").
    const runs: Array<Array<{ s: Sample; d: number }>> = [];
    let current: Array<{ s: Sample; d: number }> = [];
    let lastOffTs: number | null = null;

    for (const m of measured) {
      if (m.d > bufferM) {
        const ts = m.s.ts.getTime();
        if (
          current.length &&
          lastOffTs !== null &&
          ts - lastOffTs > EXCURSION_MERGE_GAP_MS
        ) {
          runs.push(current);
          current = [];
        }
        current.push(m);
        lastOffTs = ts;
      }
    }
    if (current.length) runs.push(current);

    const lastMeasured = measured[measured.length - 1];

    return runs
      .map((run, i): DeviationExcursion | null => {
        const startTs = run[0].s.ts;
        const endTs = run[run.length - 1].s.ts;
        const durationMs = endTs.getTime() - startTs.getTime();
        // One-off fixes and sub-window blips are GPS noise, not deviations.
        if (durationMs < EXCURSION_MIN_MS || run.length < 2) return null;

        const peak = run.reduce((best, m) => (m.d > best.d ? m : best), run[0]);
        let offRouteKm = 0;
        for (let j = 1; j < run.length; j++) {
          const dtMs = run[j].s.ts.getTime() - run[j - 1].s.ts.getTime();
          offRouteKm += segmentKm(run[j - 1].s, run[j].s, dtMs);
        }

        return {
          excursionId: `${a.assignmentId}-${i + 1}`,
          assignmentId: a.assignmentId,
          routeName: a.routeName,
          driverName: a.driverName,
          startedAt: startTs.toISOString(),
          endedAt: endTs.toISOString(),
          durationMinutes: round2(durationMs / 60_000),
          maxDistanceM: Math.round(peak.d),
          avgDistanceM: Math.round(
            run.reduce((s, m) => s + m.d, 0) / run.length,
          ),
          corridorBufferM: bufferM,
          peak: {
            lat: peak.s.lat,
            lng: peak.s.lng,
            at: peak.s.ts.toISOString(),
          },
          path: downsample(
            run.map((m) => ({ lat: m.s.lat, lng: m.s.lng })),
            EXCURSION_POINT_BUDGET,
          ),
          returnedToRoute: run[run.length - 1].s !== lastMeasured?.s,
          offRouteDistanceKm: round2(offRouteKm),
          events: [],
          remarks: [],
        };
      })
      .filter((e): e is DeviationExcursion => e !== null);
  }

  /**
   * Bind logged deviation events — and the operator remarks written against
   * them on the live monitor — to the excursion they occurred during, so the
   * report shows the recorded explanation next to the map evidence.
   */
  private attachEvents(
    excursions: DeviationExcursion[],
    events: RouteEvent[],
  ): void {
    const deviationEvents = events.filter((e) => e.type === 'deviation');
    for (const ex of excursions) {
      const start = new Date(ex.startedAt).getTime() - EVENT_MATCH_SLACK_MS;
      const end = new Date(ex.endedAt).getTime() + EVENT_MATCH_SLACK_MS;
      ex.events = deviationEvents
        .filter((e) => {
          const t = new Date(e.createdAt).getTime();
          return t >= start && t <= end;
        })
        .map((e) => ({
          eventId: e.eventId,
          type: e.type,
          at: new Date(e.createdAt).toISOString(),
          lat: e.lat,
          lng: e.lng,
          distanceM: e.distanceM,
          actor: e.actor,
          note: e.note,
          remark: e.remark,
        }))
        .sort((x, y) => x.at.localeCompare(y.at));
      ex.remarks = ex.events
        .map((e) => e.remark)
        .filter((r): r is string => !!r && r.trim().length > 0);
    }
  }

  /**
   * Per-bin outcome: driver-confirmed completion (with its photo proof) beats
   * a GPS-only pass, which beats a logged skip, which beats never reached.
   */
  private buildStops(
    route: RouteRecord | null,
    track: Sample[],
    events: RouteEvent[],
    stopCompletions: Awaited<
      ReturnType<StopCompletionRepository['listForAssignment']>
    >,
  ): MasterStopDetail[] {
    if (!route) return [];

    const completionByStop = new Map(stopCompletions.map((c) => [c.stopId, c]));
    const skipRemarkByStop = new Map<number, string>();
    for (const e of events) {
      if (e.type === 'stop_skipped' && e.stopId != null && e.remark) {
        // listEvents returns newest first, so the first remark seen is current.
        if (!skipRemarkByStop.has(e.stopId)) {
          skipRemarkByStop.set(e.stopId, e.remark);
        }
      }
    }
    const skippedStopIds = new Set(
      events
        .filter((e) => e.type === 'stop_skipped' && e.stopId != null)
        .map((e) => e.stopId as number),
    );

    return route.stops.map((s) => {
      const completion =
        s.stopId != null ? completionByStop.get(s.stopId) : undefined;
      const reached = track.some(
        (p) => haversineM(p.lat, p.lng, s.lat, s.lng) <= s.radiusM,
      );

      let status: MasterStopDetail['status'];
      if (completion) status = 'completed';
      else if (reached) status = 'visited';
      else if (s.stopId != null && skippedStopIds.has(s.stopId))
        status = 'skipped';
      else status = 'missed';

      return {
        stopId: s.stopId ?? null,
        seq: s.seq,
        name: s.name,
        lat: s.lat,
        lng: s.lng,
        radiusM: s.radiusM,
        status,
        completedAt: completion
          ? new Date(completion.createdAt).toISOString()
          : null,
        completionDistanceM: completion?.distanceM ?? null,
        inRange: completion?.inRange ?? null,
        photoPath: completion?.photoPath ?? null,
        note: completion?.note ?? null,
        skipRemark:
          s.stopId != null ? (skipRemarkByStop.get(s.stopId) ?? null) : null,
      };
    });
  }
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function pct(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0;
}

function isoOrNull(d: Date | null): string | null {
  return d ? new Date(d).toISOString() : null;
}

function clampDate(d: Date | string, min: Date, max: Date): Date {
  const t = new Date(d).getTime();
  if (isNaN(t)) return min;
  return new Date(Math.min(Math.max(t, min.getTime()), max.getTime()));
}

function isValidCoord(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180 &&
    !(lat === 0 && lng === 0)
  );
}

/** Haversine distance in metres. */
function haversineM(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6371008.8;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Distance between two consecutive fixes, in km, with the same guards
 * TripAnalyzerService applies: drop long gaps, sub-20 m jitter, and segments
 * implying an impossible speed.
 */
function segmentKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
  dtMs: number,
): number {
  if (dtMs <= 0 || dtMs > MAX_DISTANCE_SEGMENT_GAP_MS) return 0;
  if (!isValidCoord(a.lat, a.lng) || !isValidCoord(b.lat, b.lng)) return 0;
  const km = haversineM(a.lat, a.lng, b.lat, b.lng) / 1000;
  if (km < MIN_DISTANCE_SEGMENT_KM) return 0;
  if (km / (dtMs / 3_600_000) > MAX_REASONABLE_SEGMENT_SPEED_KMH) return 0;
  return km;
}

/** Even-stride thinning that always keeps the first and last point. */
function downsample<T>(items: T[], budget: number): T[] {
  if (items.length <= budget) return items;
  const stride = (items.length - 1) / (budget - 1);
  const out: T[] = [];
  for (let i = 0; i < budget; i++) out.push(items[Math.round(i * stride)]);
  return out;
}
