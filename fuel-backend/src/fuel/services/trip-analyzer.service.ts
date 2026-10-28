import { Injectable, Logger } from '@nestjs/common';
import { FuelSensor } from './fuel-sensor-resolver.service';
import { FuelTransformService } from './fuel-transform.service';
import {
  DynamicTableQueryService,
  DataRow,
} from './dynamic-table-query.service';
import { ConsumptionResult, periodConsumed } from './fuel-consumption.service';
import { trackDistanceKm } from './track-distance.util';

const NOISE_THRESHOLD = 0.5;
const MIN_TRIP_DURATION_MINUTES = 5;
const MIN_TRIP_DISTANCE_METERS = 500;
const MIN_AVG_SPEED_KMH = 5;
const IGNITION_GAP_THRESHOLD_MS = 30 * 60 * 1000;
const MOVEMENT_START_SPEED_KMH = 5;
const MOVEMENT_STOP_SPEED_KMH = 2;
const MOVEMENT_STOP_END_MS = 10 * 60 * 1000;
const MIN_REFUEL_RISE_L = 3.0;
const BOUNDARY_MEDIAN_SAMPLES = 3;

export interface TripLocation {
  lat: number;
  lng: number;
  address?: string;
}

export interface Trip {
  tripId: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  startLocation: TripLocation;
  endLocation: TripLocation;
  distanceKm: number;
  fuelConsumed: number;
  fuelAtStart: number;
  fuelAtEnd: number;
  kmPerLiter: number | null;
  unit: string;
  maxSpeed: number;
  avgSpeed: number;
  idleDurationMinutes: number;
  movingDurationMinutes: number;
}

export interface TripAnalysisResult {
  imei: string;
  from: string;
  to: string;
  unit: string;
  trips: Trip[];
  totalTrips: number;
  totalDistanceKm: number;
  totalFuelConsumed: number;
  totalDurationMinutes: number;
  avgKmPerLiter: number | null;
}

export interface NormalizedTripFuel {
  trips: Trip[];
  totalFuelConsumed: number;
  tripFuelConsumed: number;
  unassignedFuelConsumed: number;
  avgKmPerLiter: number | null;
}

/**
 * Per-trip fuel comes from a drop-sum within each trip's time window, which —
 * like the whole-period drop sum — inflates under sensor oscillation. The
 * period-level mass balance (periodConsumed) is the reliable number, so when
 * the trips' raw total exceeds it, every trip is scaled down proportionally
 * to match. Never scales up: trips legitimately summing to less than the
 * period total (idle/unassigned consumption outside any trip) are left as-is.
 *
 * Used by both /reports/trips and the master report so a trip's fuel figure
 * never disagrees between the two.
 */
export function normalizeTripFuelToPeriod(
  analysis: Pick<TripAnalysisResult, 'trips' | 'totalFuelConsumed' | 'totalDistanceKm'>,
  consumption: Pick<ConsumptionResult, 'netDrop' | 'refueled' | 'consumed'>,
): NormalizedTripFuel {
  const periodFuelConsumed = periodConsumed(consumption);
  const rawTripFuelConsumed = analysis.totalFuelConsumed;
  const tripFuelScale =
    rawTripFuelConsumed > 0 && rawTripFuelConsumed > periodFuelConsumed
      ? periodFuelConsumed / rawTripFuelConsumed
      : 1;

  const trips =
    tripFuelScale < 1
      ? analysis.trips.map((t) => {
          const normalizedFuel =
            Math.round(t.fuelConsumed * tripFuelScale * 100) / 100;
          return {
            ...t,
            fuelConsumed: normalizedFuel,
            kmPerLiter:
              normalizedFuel > 0 && t.distanceKm > 0
                ? Math.round((t.distanceKm / normalizedFuel) * 100) / 100
                : null,
          };
        })
      : analysis.trips;

  const tripFuelConsumed = Math.min(rawTripFuelConsumed, periodFuelConsumed);
  const unassignedFuelConsumed = Math.max(
    0,
    periodFuelConsumed - tripFuelConsumed,
  );

  return {
    trips,
    totalFuelConsumed: Math.round(periodFuelConsumed * 100) / 100,
    tripFuelConsumed: Math.round(tripFuelConsumed * 100) / 100,
    unassignedFuelConsumed: Math.round(unassignedFuelConsumed * 100) / 100,
    avgKmPerLiter:
      tripFuelConsumed > 0 && analysis.totalDistanceKm > 0
        ? Math.round((analysis.totalDistanceKm / tripFuelConsumed) * 100) /
          100
        : null,
  };
}

interface EnrichedRow {
  ts: Date;
  fuel: number | null;
  lat: number;
  lng: number;
  speed: number;
  ignition: boolean;
}

@Injectable()
export class TripAnalyzerService {
  private readonly logger = new Logger(TripAnalyzerService.name);

  constructor(
    private readonly transform: FuelTransformService,
    private readonly dynQuery: DynamicTableQueryService,
  ) {}

  async analyzeTrips(
    imei: string,
    from: Date,
    to: Date,
    sensor: FuelSensor,
  ): Promise<TripAnalysisResult> {
    const rows = await this.dynQuery.getRowsInRange(imei, from, to);
    this.logger.log(
      `Trip analysis for IMEI ${imei}: processing ${rows.length} rows`,
    );

    if (rows.length === 0) {
      return {
        imei,
        from: from.toISOString(),
        to: to.toISOString(),
        unit: sensor.units || 'L',
        trips: [],
        totalTrips: 0,
        totalDistanceKm: 0,
        totalFuelConsumed: 0,
        totalDurationMinutes: 0,
        avgKmPerLiter: null,
      };
    }

    const enriched = this.enrichRows(rows, sensor, imei);
    const trips = this.detectTrips(enriched, sensor.units || 'L');

    const totalDistanceKm = trips.reduce((sum, t) => sum + t.distanceKm, 0);
    const totalFuelConsumed = trips.reduce((sum, t) => sum + t.fuelConsumed, 0);
    const totalDurationMinutes = trips.reduce(
      (sum, t) => sum + t.durationMinutes,
      0,
    );
    const avgKmPerLiter =
      totalFuelConsumed > 0 && totalDistanceKm > 0
        ? Math.round((totalDistanceKm / totalFuelConsumed) * 100) / 100
        : null;

    return {
      imei,
      from: from.toISOString(),
      to: to.toISOString(),
      unit: sensor.units || 'L',
      trips,
      totalTrips: trips.length,
      totalDistanceKm: Math.round(totalDistanceKm * 100) / 100,
      totalFuelConsumed: Math.round(totalFuelConsumed * 100) / 100,
      totalDurationMinutes: Math.round(totalDurationMinutes * 100) / 100,
      avgKmPerLiter,
    };
  }

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

      let ignition = false;
      try {
        const p = JSON.parse(row.params) as Record<string, string | number>;
        ignition =
          p['acc'] === '1' ||
          p['acc'] === 1 ||
          p['io1'] === '1' ||
          p['io1'] === 1;
      } catch {
        // no ignition data
      }

      return {
        ts,
        fuel,
        lat: row.lat,
        lng: row.lng,
        speed: row.speed,
        ignition,
      };
    });
  }

  private detectTrips(rows: EnrichedRow[], unit: string): Trip[] {
    const trips: Trip[] = [];
    const hasIgnitionSignal = rows.some((r) => r.ignition);
    let tripStart: EnrichedRow | null = null;
    let tripStartFuel: number | null = null;
    let tripRows: EnrichedRow[] = [];
    let stopStartTs: Date | null = null;
    let tripId = 1;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];

      const shouldStartByIgnition = row.ignition;
      const shouldStartByMovement =
        !hasIgnitionSignal && row.speed >= MOVEMENT_START_SPEED_KMH;

      if (
        (shouldStartByIgnition || shouldStartByMovement) &&
        tripStart === null
      ) {
        // Trip starts
        tripStart = row;
        tripStartFuel = row.fuel;
        tripRows = [row];
        stopStartTs = null;
      } else if (tripStart !== null) {
        // We're in a trip
        tripRows.push(row);

        // Check if trip ends (ignition off or gap in data > 30 min)
        const prevRow = tripRows[tripRows.length - 2];
        const gapMs = prevRow ? row.ts.getTime() - prevRow.ts.getTime() : 0;
        const ignitionJustTurnedOff = !row.ignition && prevRow?.ignition;
        const largeGap = gapMs > IGNITION_GAP_THRESHOLD_MS;
        const isStopped = row.speed <= MOVEMENT_STOP_SPEED_KMH;
        if (!hasIgnitionSignal) {
          if (isStopped) {
            if (!stopStartTs) stopStartTs = row.ts;
          } else {
            stopStartTs = null;
          }
        }
        const movementStopExceeded =
          !hasIgnitionSignal &&
          stopStartTs !== null &&
          row.ts.getTime() - stopStartTs.getTime() >= MOVEMENT_STOP_END_MS;

        if (
          ignitionJustTurnedOff ||
          largeGap ||
          movementStopExceeded ||
          i === rows.length - 1
        ) {
          // End the trip (exclude current row for ignition-off / large-gap endings)
          const includeCurrentRow =
            i === rows.length - 1 &&
            !ignitionJustTurnedOff &&
            !largeGap &&
            !movementStopExceeded;
          const effectiveTripRows = includeCurrentRow
            ? tripRows
            : tripRows.slice(0, -1);
          if (effectiveTripRows.length === 0) {
            tripStart = null;
            tripStartFuel = null;
            tripRows = [];
            stopStartTs = null;
            continue;
          }
          const tripEnd = effectiveTripRows[effectiveTripRows.length - 1];
          const tripEndFuel = tripEnd.fuel;

          if (tripStart && tripStartFuel !== null && tripEndFuel !== null) {
            const durationMinutes =
              (tripEnd.ts.getTime() - tripStart.ts.getTime()) / 60000;
            const distanceKm = this.calcTripDistance(effectiveTripRows);
            const idleAndMoving = this.calcIdleAndMovingTime(effectiveTripRows);
            const fuelMetrics = this.calcTripFuelMetrics(effectiveTripRows);

            // Calculate average speed only while moving (speed > 5 km/h)
            const movingSpeeds = effectiveTripRows
              .filter((r) => r.speed > 5)
              .map((r) => r.speed);
            const avgMovingSpeed =
              movingSpeeds.length > 0
                ? movingSpeeds.reduce((a, b) => a + b, 0) / movingSpeeds.length
                : 0;
            const maxSpeed =
              movingSpeeds.length > 0 ? Math.max(...movingSpeeds) : 0;

            // Filter criteria - must pass ALL:
            // 1. At least 5 minutes total duration
            // 2. At least 500 meters traveled
            // 3. Average moving speed at least 5 km/h
            // 4. Must have actually moved (distance > 0)
            const meetsDuration = durationMinutes >= MIN_TRIP_DURATION_MINUTES;
            const meetsDistance = distanceKm * 1000 >= MIN_TRIP_DISTANCE_METERS;
            const meetsSpeed = avgMovingSpeed >= MIN_AVG_SPEED_KMH;
            const actuallyMoved = distanceKm > 0.05; // At least 50 meters

            const isValidTrip =
              meetsDuration && meetsDistance && meetsSpeed && actuallyMoved;

            if (isValidTrip) {
              const trip: Trip = {
                tripId: `T${String(tripId).padStart(3, '0')}`,
                startTime: tripStart.ts.toISOString(),
                endTime: tripEnd.ts.toISOString(),
                durationMinutes: Math.round(durationMinutes * 10) / 10,
                startLocation: {
                  lat: tripStart.lat,
                  lng: tripStart.lng,
                },
                endLocation: {
                  lat: tripEnd.lat,
                  lng: tripEnd.lng,
                },
                distanceKm: Math.round(distanceKm * 100) / 100,
                fuelConsumed: Math.round(fuelMetrics.consumed * 100) / 100,
                fuelAtStart: Math.round(fuelMetrics.startFuel * 100) / 100,
                fuelAtEnd: Math.round(fuelMetrics.endFuel * 100) / 100,
                kmPerLiter:
                  fuelMetrics.consumed > 0 && distanceKm > 0
                    ? Math.round((distanceKm / fuelMetrics.consumed) * 100) /
                      100
                    : null,
                unit,
                maxSpeed: Math.round(maxSpeed * 10) / 10,
                avgSpeed: Math.round(avgMovingSpeed * 10) / 10,
                idleDurationMinutes:
                  Math.round(idleAndMoving.idleMinutes * 10) / 10,
                movingDurationMinutes:
                  Math.round(idleAndMoving.movingMinutes * 10) / 10,
              };

              trips.push(trip);
              tripId++;
            } else {
              // Log why trip was filtered out (for debugging)
              this.logger.debug(
                `Filtered out trip: duration=${durationMinutes.toFixed(1)}min, ` +
                  `distance=${(distanceKm * 1000).toFixed(0)}m, ` +
                  `avgSpeed=${avgMovingSpeed.toFixed(1)}km/h ` +
                  `(${meetsDuration ? '✓' : '✗'}duration, ${meetsDistance ? '✓' : '✗'}distance, ${meetsSpeed ? '✓' : '✗'}speed)`,
              );
            }
          }

          tripStart = null;
          tripStartFuel = null;
          tripRows = [];
          stopStartTs = null;
        }
      }
    }

    return trips;
  }

  private calcIdleAndMovingTime(rows: EnrichedRow[]): {
    idleMinutes: number;
    movingMinutes: number;
  } {
    let idleMinutes = 0;
    let movingMinutes = 0;

    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1];
      const curr = rows[i];
      const gapMinutes = (curr.ts.getTime() - prev.ts.getTime()) / 60000;

      // If speed > 5 km/h, count as moving time
      if (prev.speed > 5) {
        movingMinutes += gapMinutes;
      } else {
        idleMinutes += gapMinutes;
      }
    }

    return { idleMinutes, movingMinutes };
  }

  private calcTripDistance(rows: EnrichedRow[]): number {
    return trackDistanceKm(rows);
  }

  private calcTripFuelMetrics(rows: EnrichedRow[]): {
    startFuel: number;
    endFuel: number;
    consumed: number;
  } {
    const fuels = rows
      .map((r) => r.fuel)
      .filter((f): f is number => f !== null);

    if (fuels.length === 0) {
      return { startFuel: 0, endFuel: 0, consumed: 0 };
    }

    const startFuel = this.median(
      fuels.slice(0, Math.min(BOUNDARY_MEDIAN_SAMPLES, fuels.length)),
    );
    const endFuel = this.median(
      fuels.slice(Math.max(0, fuels.length - BOUNDARY_MEDIAN_SAMPLES)),
    );

    let refueled = 0;
    let prevFuel: number | null = null;

    for (const fuel of fuels) {
      if (prevFuel !== null) {
        const delta = fuel - prevFuel;
        if (delta < -NOISE_THRESHOLD) {
          // drop observed; consumed is derived from conservation below
          // to avoid under-counting on sparse telemetry where per-step drops can be >2L
        } else if (delta >= MIN_REFUEL_RISE_L) {
          refueled += delta;
        }
      }
      prevFuel = fuel;
    }

    // Physical conservation: consumed ~= refueled + (startFuel - endFuel).
    // This keeps trip totals aligned with tank boundaries and in-trip refuels.
    const conservationConsumed = Math.max(0, refueled + (startFuel - endFuel));

    return {
      startFuel,
      endFuel,
      consumed: conservationConsumed,
    };
  }

  private isValidCoordinatePair(lat: number, lng: number): boolean {
    return (
      Number.isFinite(lat) &&
      Number.isFinite(lng) &&
      Math.abs(lat) <= 90 &&
      Math.abs(lng) <= 180
    );
  }

  private median(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  }

  private haversineKm(
    lat1: number,
    lng1: number,
    lat2: number,
    lng2: number,
  ): number {
    const R = 6371;
    const dLat = this.toRad(lat2 - lat1);
    const dLng = this.toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(this.toRad(lat1)) *
        Math.cos(this.toRad(lat2)) *
        Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  private toRad(deg: number): number {
    return (deg * Math.PI) / 180;
  }
}
