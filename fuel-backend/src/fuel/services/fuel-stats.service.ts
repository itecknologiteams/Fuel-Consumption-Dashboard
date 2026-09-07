import { Injectable, Logger } from '@nestjs/common';
import { FuelSensor } from './fuel-sensor-resolver.service';
import { FuelTransformService } from './fuel-transform.service';
import {
  DynamicTableQueryService,
  DataRow,
} from './dynamic-table-query.service';
import {
  DropEvent,
  RefuelEvent,
  periodConsumed,
} from './fuel-consumption.service';
import {
  FuelReading,
  applyMedianFilter,
  isFakeSpike,
  isFakeRise,
  isDropConfirmedAfterDelay,
  isPostDropRecovery,
  isRecoveryRise,
  isPostRefuelFallback,
  DROP_ALERT_THRESHOLD,
  RISE_THRESHOLD,
  SPIKE_WINDOW_MINUTES,
  FUEL_MEDIAN_SAMPLES,
  REFUEL_CONSOLIDATION_MINUTES,
  RISE_RECOVERY_LOOKBACK_MINUTES,
  POST_REFUEL_VERIFY_EPS_LITERS,
  eventToleranceLiters,
  minEventLiters,
  stationaryEventTester,
} from './fuel-drop-filter.util';

/**
 * Extra hours of data fetched before the requested `from` date to warm up
 * the causal median filter. Mirrors the same constant in fuel-consumption.service.ts.
 */
const WARMUP_HOURS = 2;

const NOISE_THRESHOLD = 0.5;
/** Used ONLY inside the drop window scan to detect a mid-window refuel and break early. */
const REFUEL_THRESHOLD = 3.0;
const MAX_SINGLE_READING_DROP = 2.0;

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
  ) {}

  async getStats(
    imei: string,
    from: Date,
    to: Date,
    sensor: FuelSensor,
    pricePerLiter: number | null,
  ): Promise<FuelStatsResult> {
    // Fetch extra data before `from` to warm up the causal median filter so
    // that readings at the boundary of any query window are smoothed
    // consistently regardless of which preset (week / month / custom) is used.
    const warmupFrom = new Date(from.getTime() - WARMUP_HOURS * 60 * 60 * 1000);
    const allRows = await this.dynQuery.getRowsInRange(imei, warmupFrom, to);
    this.logger.log(
      `Stats for IMEI ${imei}: fetched ${allRows.length} rows (${WARMUP_HOURS}h warmup from ${warmupFrom.toISOString()})`,
    );

    // Run event detection on ALL rows (warmup + actual) so the median filter
    // has full context for readings near the `from` boundary.
    const allTransformedRows = this.transformRows(allRows, sensor, imei);
    const {
      drops: allDrops,
      refuels: allRefuels,
      readings: allReadings,
    } = this.detectEvents(allTransformedRows, sensor.units || 'L');

    // Filter events and readings to the actual requested [from, to] range.
    const fromIso = from.toISOString();
    const drops = allDrops.filter((d) => d.at >= fromIso);
    const refuels = allRefuels.filter((r) => r.at >= fromIso);
    const readings = allReadings.filter((r) => r.ts >= from);

    // Restrict row-level arrays to the actual range for distance / idle calc.
    const rows = allRows.filter((r) => new Date(r.dt_tracker) >= from);
    const transformedRows = allTransformedRows.filter((r) => r.ts >= from);

    const dropSumConsumed =
      Math.round(
        drops
          .filter((d) => !d.isSensorJump)
          .reduce((s, d) => s + d.consumed, 0) * 100,
      ) / 100;
    const refueled =
      Math.round(refuels.reduce((s, r) => s + r.added, 0) * 100) / 100;

    // Mass-balance the same way fuel-consumption.service.ts does: prefer
    // (firstFuel - lastFuel) + refueled over the raw drop sum, which zeroes
    // out when sensor-jump filtering or the median filter smooths away every
    // drop event even though fuel was actually consumed.
    const firstFuel = readings.length > 0 ? readings[0].fuel : null;
    const lastFuel =
      readings.length > 0 ? readings[readings.length - 1].fuel : null;
    const netDrop =
      firstFuel !== null && lastFuel !== null
        ? Math.round((firstFuel - lastFuel) * 100) / 100
        : null;
    const consumed = periodConsumed({
      netDrop,
      refueled,
      consumed: dropSumConsumed,
    });

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
    const idleDrain = this.calcIdleDrain(
      rows,
      transformedRows,
      sensor,
      imei,
      consumed,
    );
    const fuelTimeline = this.calcTimeline(
      drops,
      refuels,
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
      refuelEvents: refuels.length,
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

  // ─── Drop & Refuel Detection ─────────────────────────────────────────────────

  private detectEvents(
    rows: Array<{ ts: Date; fuel: number | null; speed?: number }>,
    unit: string,
  ): { drops: DropEvent[]; refuels: RefuelEvent[]; readings: FuelReading[] } {
    const drops: DropEvent[] = [];
    const refuels: RefuelEvent[] = [];

    const rawValid = rows.filter(
      (r): r is { ts: Date; fuel: number; speed?: number } => r.fuel !== null,
    );

    // ── Layer 1: Median Filter ──────────────────────────────────────────────
    // Mirrors Python _filter_fuel_for_alarms() / FUEL_MEDIAN_SAMPLES = 5.
    // Speed is preserved unchanged (spread by applyMedianFilter).
    const fuelReadings: FuelReading[] = rawValid.map((r) => ({
      ts: r.ts,
      fuel: r.fuel,
      speed: r.speed,
    }));
    const validRows = applyMedianFilter(fuelReadings, FUEL_MEDIAN_SAMPLES);

    // Speeds come from the unfiltered readings; the median filter maps 1:1 so
    // the two arrays share indices.
    const isStationaryEvent = stationaryEventTester(fuelReadings);

    let i = 0;
    while (i < validRows.length) {
      if (i === 0) {
        i++;
        continue;
      }

      const row = validRows[i];
      const prev = validRows[i - 1];
      const delta = row.fuel - prev.fuel;
      const singleConsumed = Math.abs(delta);

      // 3 L is a real event on a parked vehicle; in motion, slosh needs the
      // full 8 L. Mirrors fuel-consumption.service.ts so the stats panel and
      // the consumption figures agree on what counts as an event.
      const stationary = isStationaryEvent(i - 1, i);
      const dropThreshold = minEventLiters(stationary, DROP_ALERT_THRESHOLD);
      const riseThreshold = minEventLiters(stationary, RISE_THRESHOLD);

      if (delta < -NOISE_THRESHOLD) {
        if (singleConsumed >= dropThreshold) {
          // ── Large drop: mirrors Python's handle_fuel_drop thread ──────────────
          const baselineFuel = prev.fuel;
          const baselineTs = prev.ts;
          const windowEndMs =
            baselineTs.getTime() + SPIKE_WINDOW_MINUTES * 60 * 1000;

          let verifiedFuel = row.fuel;
          let j = i + 1;
          while (
            j < validRows.length &&
            validRows[j].ts.getTime() <= windowEndMs
          ) {
            const nextFuel = validRows[j].fuel;
            if (nextFuel > baselineFuel - dropThreshold) break;
            if (nextFuel - verifiedFuel > REFUEL_THRESHOLD) break;
            verifiedFuel = nextFuel;
            j++;
          }

          const totalConsumed = baselineFuel - verifiedFuel;
          // Scale the recovery checks to the drop being validated — see
          // eventToleranceLiters(); unchanged (8 L) for any drop ≥ 8 L.
          const dropTolerance = eventToleranceLiters(
            totalConsumed,
            DROP_ALERT_THRESHOLD,
          );

          // ── Layer 2: Verify delay + speed gate ────────────────────────────────
          // Mirrors Python: re-read after 80 s, check still dropped >= 8 L AND stationary.
          const verifyPassed = isDropConfirmedAfterDelay(
            row.ts, // drop timestamp
            baselineFuel,
            validRows,
            dropThreshold,
          );

          // ── Layer 3: Fake-spike check (includes speed veto) ───────────────────
          const fake =
            !verifyPassed ||
            isFakeSpike(
              baselineTs,
              validRows,
              SPIKE_WINDOW_MINUTES,
              dropTolerance,
            );

          // ── Layer 4: Post-drop verify ─────────────────────────────────────────
          const postRecovery =
            !fake &&
            isPostDropRecovery(
              baselineTs,
              baselineFuel,
              validRows,
              SPIKE_WINDOW_MINUTES,
            );

          const isConfirmedDrop =
            totalConsumed >= dropThreshold && !fake && !postRecovery;

          drops.push({
            at: baselineTs.toISOString(),
            fuelBefore: Math.round(baselineFuel * 100) / 100,
            fuelAfter: Math.round(verifiedFuel * 100) / 100,
            consumed: Math.round(totalConsumed * 100) / 100,
            unit,
            isSensorJump: false,
            isConfirmedDrop,
          });

          i = j;
          continue;
        } else {
          drops.push({
            at: prev.ts.toISOString(),
            fuelBefore: Math.round(prev.fuel * 100) / 100,
            fuelAfter: Math.round(row.fuel * 100) / 100,
            consumed: Math.round(singleConsumed * 100) / 100,
            unit,
            isSensorJump: singleConsumed > MAX_SINGLE_READING_DROP,
            isConfirmedDrop: false,
          });
        }
      } else if (delta >= riseThreshold) {
        // ── Large rise: mirrors Python's handle_fuel_rise thread ───────────────
        const baselineFuel = prev.fuel;
        const baselineTs = prev.ts;
        const consolidationEndMs =
          baselineTs.getTime() + REFUEL_CONSOLIDATION_MINUTES * 60 * 1000;

        // Consolidation: find the true peak within the stabilisation window.
        let peakFuel = row.fuel;
        // When the fill finished — post-fill verification anchors here, not on
        // the baseline reading. See RefuelEvent.peakAt.
        let peakTs = row.ts;
        let k = i + 1;
        // Track whether fuel fell back below the rise threshold WITHIN the
        // consolidation window — strong indicator of a sensor fake-spike.
        let falledBackInConsolidation = false;
        while (
          k < validRows.length &&
          validRows[k].ts.getTime() <= consolidationEndMs
        ) {
          const nextFuel = validRows[k].fuel;
          if (nextFuel > peakFuel) {
            peakFuel = nextFuel;
            peakTs = validRows[k].ts;
          } else if (nextFuel < baselineFuel + riseThreshold) {
            if (
              peakFuel - nextFuel >
              eventToleranceLiters(
                peakFuel - baselineFuel,
                POST_REFUEL_VERIFY_EPS_LITERS,
              )
            ) {
              falledBackInConsolidation = true;
            }
            break;
          }
          k++;
        }

        const totalAdded = peakFuel - baselineFuel;
        // Scale the verification checks to the rise being validated — see
        // eventToleranceLiters(); unchanged (8 L) for any rise ≥ 8 L.
        const riseTolerance = eventToleranceLiters(
          totalAdded,
          POST_REFUEL_VERIFY_EPS_LITERS,
        );

        if (totalAdded >= riseThreshold) {
          // ── Layer A: isFakeRise (mirrors Python is_fake_rise) ────────────────
          // Short-circuit: if fuel fell back significantly within the 15-min
          // consolidation window, treat it as a fake spike immediately.
          const fakeRise =
            falledBackInConsolidation ||
            isFakeRise(
              baselineTs,
              validRows,
              SPIKE_WINDOW_MINUTES,
              riseTolerance,
            );

          // ── Layer B: isRecoveryRise (mirrors Python is_recovery_rise) ─────────
          const recoveryRise =
            !fakeRise &&
            isRecoveryRise(
              baselineTs,
              baselineFuel,
              peakFuel,
              validRows,
              RISE_RECOVERY_LOOKBACK_MINUTES,
              riseTolerance,
            );

          // ── Layer C: isPostRefuelFallback (mirrors Python post-refuel verify) ──
          const postFallback =
            !fakeRise &&
            !recoveryRise &&
            isPostRefuelFallback(
              baselineTs,
              baselineFuel,
              peakFuel,
              validRows,
              SPIKE_WINDOW_MINUTES,
              riseTolerance,
            );

          if (!fakeRise && !recoveryRise && !postFallback) {
            refuels.push({
              at: baselineTs.toISOString(),
              peakAt: peakTs.toISOString(),
              fuelBefore: Math.round(baselineFuel * 100) / 100,
              fuelAfter: Math.round(peakFuel * 100) / 100,
              added: Math.round(totalAdded * 100) / 100,
              unit,
            });
          }
        }

        // Skip past the consolidation window.
        i = k;
        continue;
      }

      i++;
    }

    return { drops, refuels, readings: fuelReadings };
  }

  // ─── Efficiency: Haversine distance ─────────────────────────────────────────

  private calcEfficiency(rows: DataRow[], consumed: number): EfficiencyStats {
    let totalDistanceKm = 0;

    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1];
      const curr = rows[i];

      // Skip GPS invalid rows (0,0 coordinates)
      if (!prev.lat || !prev.lng || !curr.lat || !curr.lng) continue;

      totalDistanceKm += this.haversineKm(
        prev.lat,
        prev.lng,
        curr.lat,
        curr.lng,
      );
    }

    totalDistanceKm = Math.round(totalDistanceKm * 100) / 100;

    const kmPerLiter =
      consumed > 0 && totalDistanceKm > 0
        ? Math.round((totalDistanceKm / consumed) * 100) / 100
        : null;

    const litersPer100km =
      consumed > 0 && totalDistanceKm > 0
        ? Math.round((consumed / totalDistanceKm) * 100 * 100) / 100
        : null;

    return { totalDistanceKm, kmPerLiter, litersPer100km };
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

  // ─── Idle Drain ──────────────────────────────────────────────────────────────

  private calcIdleDrain(
    rows: DataRow[],
    transformedRows: Array<{
      ts: Date;
      fuel: number | null;
      speed: number;
      params: string;
    }>,
    sensor: FuelSensor,
    imei: string,
    totalConsumed: number,
  ): IdleDrainStats {
    let idleLiters = 0;
    let prevFuel: number | null = null;
    let prevSpeed: number | null = null;
    let prevIgnition: boolean | null = null;

    for (const row of transformedRows) {
      const fuel = row.fuel;

      // Parse ignition from params (acc field = 1 means ON)
      let ignition = false;
      try {
        const p = JSON.parse(row.params) as Record<string, string | number>;
        ignition =
          p['acc'] === '1' ||
          p['acc'] === 1 ||
          p['io1'] === '1' ||
          p['io1'] === 1;
      } catch {
        // no ignition info
      }

      if (
        prevFuel !== null &&
        prevSpeed !== null &&
        prevIgnition !== null &&
        fuel !== null
      ) {
        const delta = fuel - prevFuel;
        const isIdle = prevSpeed < 2 && prevIgnition;

        if (isIdle && delta < -NOISE_THRESHOLD) {
          idleLiters += Math.abs(delta);
        }
      }

      prevFuel = fuel ?? prevFuel;
      prevSpeed = row.speed;
      prevIgnition = ignition;
    }

    idleLiters = Math.round(idleLiters * 100) / 100;
    const percentage =
      totalConsumed > 0
        ? Math.round((idleLiters / totalConsumed) * 100 * 10) / 10
        : 0;

    return { liters: idleLiters, percentage };
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
