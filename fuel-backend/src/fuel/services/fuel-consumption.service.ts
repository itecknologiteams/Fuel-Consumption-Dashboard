import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { FuelSensor } from './fuel-sensor-resolver.service';
import { FuelTransformService } from './fuel-transform.service';
import { DynamicTableQueryService } from './dynamic-table-query.service';
import { DataRow } from './dynamic-table-query.service';
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
  SPIKE_WINDOW_MINUTES,
  FUEL_MEDIAN_SAMPLES,
  REFUEL_CONSOLIDATION_MINUTES,
  POST_REFUEL_VERIFY_EPS_LITERS,
  RISE_RECOVERY_LOOKBACK_MINUTES,
  eventToleranceLiters,
  STATIONARY_EVENT_THRESHOLD,
  StationaryTester,
  rawChangeIndex,
  stationaryTester,
} from './fuel-drop-filter.util';

/**
 * How many hours of data to fetch BEFORE the requested `from` date in order to
 * warm up the causal median filter.  Without this, the first few readings in
 * any query window are smoothed from an incomplete window, producing different
 * median values for the same sensor readings depending on the query range —
 * causing "This Week" and "This Month" to disagree on the same refuel events.
 *
 * With a full 5-sample causal filter and data arriving every ~1–2 min,
 * 2 hours is more than enough to saturate the window even for sparse datasets.
 */
const WARMUP_HOURS = 2;

const NOISE_THRESHOLD = 0.5;
/** Used ONLY inside the drop window scan to detect a mid-window refuel and break early. */
const REFUEL_THRESHOLD = 3.0;
const REFUEL_MOVEMENT_MAX_SPEED_KMH = 10.0;
const REFUEL_WINDOW_BOUNDARY_MINUTES = 5;

// Mirrors Python's MILEAGE_MAX_LITER_DROP_PER_READING = 2.0
const MAX_SINGLE_READING_DROP = 2.0;

export interface RefuelEvent {
  /** Baseline reading — the last one before the level started climbing. */
  at: string;
  /**
   * When the level actually peaked, i.e. when the fill finished.
   *
   * Post-fill verification has to be anchored here, not at `at`: a tanker fill
   * takes minutes, so a window measured from the baseline lands mid-fill and
   * reads the climb as a fall-back from the peak.
   */
  peakAt?: string;
  fuelBefore: number;
  fuelAfter: number;
  added: number;
  unit: string;
}

export interface DropEvent {
  at: string;
  fuelBefore: number;
  fuelAfter: number;
  consumed: number;
  unit: string;
  /** True when a single-reading drop exceeds MAX_SINGLE_READING_DROP — likely a sensor glitch, not real consumption (mirrors Python's MILEAGE_MAX_LITER_DROP_PER_READING check). */
  isSensorJump?: boolean;
  /**
   * True when ALL three conditions hold, mirroring Python's is_fake_spike() logic:
   *   1. consumed >= DROP_ALERT_THRESHOLD (8 L)
   *   2. The fuel level does NOT recover within ±SPIKE_WINDOW_MINUTES (7 min)
   *   3. Fuel stays consistently low after the drop
   * Only confirmed drops are shown as "Fuel Drop Alert" events in the UI.
   */
  isConfirmedDrop?: boolean;
}

export interface ConsumptionResult {
  imei: string;
  from: string;
  to: string;
  /** Cumulative small-drop consumption (excludes sensor jumps > MAX_SINGLE_READING_DROP). */
  consumed: number;
  refueled: number;
  estimatedCost: number | null;
  unit: string;
  refuelEvents: number;
  samples: number;
  refuels: RefuelEvent[];
  drops: DropEvent[];
  /** First valid fuel reading in the period (liters). */
  firstFuel: number | null;
  /** Last valid fuel reading in the period (liters). */
  lastFuel: number | null;
  /**
   * Net fuel change = firstFuel − lastFuel.
   * Positive = net decrease (fuel was consumed / stolen).
   * This is the most accurate single-number representation of "how much fuel
   * was lost" because it does NOT double-count sensor oscillations.
   */
  netDrop: number | null;
  /**
   * Raw fuel readings (for anomaly detection middleware).
   * Optional - only included if readings are available.
   */
  readings?: FuelReading[];
}

/**
 * Fuel actually burned over a period, by mass balance:
 *   consumed = (firstFuel + refueled) − lastFuel  ==  netDrop + refueled
 *
 * This is the number the Routes "Period Summary" shows, and it is preferred
 * over summing individual drop events because sensor oscillation inflates the
 * drop sum badly on a moving vehicle.
 *
 * Falls back to the drop sum when the balance is unusable:
 *   • no period boundaries (netDrop === null), or
 *   • a balance of zero or less — the tank ended fuller than it started, which
 *     only happens via a refuel, so a non-positive balance means the fill was
 *     missed by refuel detection (or clipped by a calibration table that
 *     saturates below the tank's real capacity). Without this fallback the
 *     clamp at zero reports "no fuel used" for a period that plainly had some.
 */
export function periodConsumed(
  result: Pick<ConsumptionResult, 'netDrop' | 'refueled' | 'consumed'>,
): number {
  if (result.netDrop === null) return result.consumed;
  const balance = result.netDrop + result.refueled;
  return balance > 0 ? balance : result.consumed;
}

export interface FcrConfig {
  source?: string;
  measurement?: string;
  cost?: string;
  summer?: string;
  winter?: string;
}

export interface PythonDropAlert {
  at: string;
  fuelBefore: number;
  fuelAfter: number;
  consumed: number;
  unit: string;
  isConfirmedDrop: true;
}

@Injectable()
export class FuelConsumptionService {
  private readonly logger = new Logger(FuelConsumptionService.name);

  // Short-lived cache of consumption results keyed by imei+range+sensor. It
  // dedupes the dashboard's burst of overlapping/duplicate requests (fleet
  // summary + per-vehicle panels) and reuses the result within the TTL, so the
  // same rows aren't re-fetched and re-analysed several times per page load.
  private readonly consumptionCache = new Map<
    string,
    { at: number; ttl: number; promise: Promise<ConsumptionResult> }
  >();
  private readonly CONSUMPTION_TTL_MS = 60_000;
  // A range that ends safely in the past is immutable, so its result can be
  // cached far longer (repeat views of a past month become instant).
  private readonly CONSUMPTION_HISTORICAL_TTL_MS = 30 * 60_000;

  constructor(
    private readonly transform: FuelTransformService,
    private readonly dynQuery: DynamicTableQueryService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /**
   * Query fuel_drop_alerts (written by the Python monitoring script) for
   * confirmed theft/drop events in the given UTC range.
   *
   * Python stores dt_tracker as raw UTC DATETIME. TypeORM uses timezone:'Z'
   * which sets the MySQL session to UTC, so stored UTC values are read back
   * correctly as UTC JavaScript Dates.
   */
  async getPythonAlerts(
    imei: string,
    from: Date,
    to: Date,
    unit = 'Liters',
  ): Promise<PythonDropAlert[]> {
    try {
      const rows = await this.dataSource.query<
        {
          alert_id: number;
          imei: string;
          previous_fuel: number;
          current_fuel: number;
          drop_amount: number;
          dt_tracker: Date;
        }[]
      >(
        `SELECT alert_id, imei, previous_fuel, current_fuel, drop_amount, dt_tracker
         FROM fuel_drop_alerts
         WHERE imei = ? AND dt_tracker BETWEEN ? AND ?
         ORDER BY dt_tracker ASC`,
        [imei, from, to],
      );

      return rows.map((r) => ({
        at:
          r.dt_tracker instanceof Date
            ? r.dt_tracker.toISOString()
            : new Date(r.dt_tracker).toISOString(),
        fuelBefore: Math.round(r.previous_fuel * 100) / 100,
        fuelAfter: Math.round(r.current_fuel * 100) / 100,
        consumed: Math.round(r.drop_amount * 100) / 100,
        unit,
        isConfirmedDrop: true as const,
      }));
    } catch (err) {
      this.logger.warn(`getPythonAlerts error for IMEI ${imei}: ${err}`);
      return [];
    }
  }

  /**
   * Consumption for a vehicle over a range. Cached briefly (and de-duplicated
   * while in flight) so the dashboard's overlapping requests reuse one
   * computation instead of each re-fetching + re-analysing the same rows.
   */
  async getConsumption(
    imei: string,
    from: Date,
    to: Date,
    sensor: FuelSensor,
    fcrJson: string,
  ): Promise<ConsumptionResult> {
    const key = `${imei}|${from.toISOString()}|${to.toISOString()}|${sensor.sensorId}|${fcrJson}`;
    const now = Date.now();
    const hit = this.consumptionCache.get(key);
    if (hit && now - hit.at < hit.ttl) return hit.promise;

    // Immutable (fully-past) ranges can be cached far longer than live ones.
    const ttl =
      to.getTime() < now - 5 * 60_000
        ? this.CONSUMPTION_HISTORICAL_TTL_MS
        : this.CONSUMPTION_TTL_MS;
    const promise = this.computeConsumption(imei, from, to, sensor, fcrJson);
    this.consumptionCache.set(key, { at: now, ttl, promise });
    // Never cache a failure — let the next caller retry.
    promise.catch(() => {
      const cur = this.consumptionCache.get(key);
      if (cur && cur.promise === promise) this.consumptionCache.delete(key);
    });
    // Bound memory: drop the oldest entries once the cache grows large.
    if (this.consumptionCache.size > 300) {
      const oldest = [...this.consumptionCache.entries()]
        .sort((a, b) => a[1].at - b[1].at)
        .slice(0, 100);
      for (const [k] of oldest) this.consumptionCache.delete(k);
    }
    return promise;
  }

  private async computeConsumption(
    imei: string,
    from: Date,
    to: Date,
    sensor: FuelSensor,
    fcrJson: string,
  ): Promise<ConsumptionResult> {
    // Fetch extra data before `from` to warm up the causal median filter so
    // that readings at the boundary of any query window are smoothed
    // consistently regardless of which preset (week / month / custom) is used.
    const warmupFrom = new Date(from.getTime() - WARMUP_HOURS * 60 * 60 * 1000);
    const allRows = await this.dynQuery.getRowsInRange(imei, warmupFrom, to);
    this.logger.log(
      `Consumption for IMEI ${imei}: fetched ${allRows.length} rows (${WARMUP_HOURS}h warmup from ${warmupFrom.toISOString()})`,
    );

    // Run analysis on the full (warmup + actual) dataset so the median filter
    // has proper context for readings near the `from` boundary.
    const {
      drops: allDrops,
      refuels: allRefuels,
      readings,
      filtered,
      atRest,
    } = this.analyzeRows(allRows, sensor, imei);

    // Filter events to only those that fall within the actual requested range.
    const fromIso = from.toISOString();
    const drops = allDrops.filter((d) => d.at >= fromIso);
    const refuels = allRefuels.filter((r) => r.at >= fromIso);

    // Indices of the readings inside [from, to] — the warmup only exists to
    // prime the median filter and must not contribute figures.
    const periodIndices: number[] = [];
    for (let i = 0; i < filtered.length; i++) {
      if (filtered[i].ts >= from) periodIndices.push(i);
    }
    const restIndices = periodIndices.filter((i) => atRest.isSettled(i));

    // Every reported level is read off a stationary vehicle. A level sampled
    // in motion is worth ±15 L of slosh, which lands straight in netDrop and
    // from there in "Total Fuel Used" and its cost.
    //
    // Fall back to the plain boundary readings when the vehicle never stopped
    // inside the period: a rough figure beats a blank one, and the log below
    // records that it is the weaker kind.
    const levelIndices = restIndices.length > 0 ? restIndices : periodIndices;
    const firstFuel =
      levelIndices.length > 0 ? filtered[levelIndices[0]].fuel : null;
    const lastFuel =
      levelIndices.length > 0
        ? filtered[levelIndices[levelIndices.length - 1]].fuel
        : null;

    if (restIndices.length === 0 && periodIndices.length > 0) {
      this.logger.warn(
        `IMEI ${imei}: no stationary reading between ${fromIso} and ` +
          `${to.toISOString()} — levels fall back to the readings as taken, ` +
          `which carry motion noise`,
      );
    }

    const consumed = this.restToRestConsumed(filtered, restIndices);
    const refueled = refuels.reduce((sum, r) => sum + r.added, 0);
    const pricePerLiter = this.extractPricePerLiter(fcrJson, from);

    // netDrop = firstFuel - lastFuel: the single most reliable "how much fuel
    // was lost" metric. It does not inflate from sensor oscillations unlike
    // summing individual drop events.
    const netDrop =
      firstFuel !== null && lastFuel !== null
        ? Math.round((firstFuel - lastFuel) * 100) / 100
        : null;

    const roundedConsumed = Math.round(consumed * 100) / 100;
    const roundedRefueled = Math.round(refueled * 100) / 100;

    // Cost must track the same figure callers get from periodConsumed(result)
    // (mass balance, falling back to the drop sum) — not a separately-derived
    // number, or the dashboard can show a cost that doesn't match its own
    // "fuel used" total once a refuel changes which branch periodConsumed picks.
    const effectiveConsumed = periodConsumed({
      netDrop,
      refueled: roundedRefueled,
      consumed: roundedConsumed,
    });
    const estimatedCost =
      pricePerLiter !== null
        ? Math.round(effectiveConsumed * pricePerLiter * 100) / 100
        : null;

    return {
      imei,
      from: from.toISOString(),
      to: to.toISOString(),
      consumed: roundedConsumed,
      refueled: roundedRefueled,
      estimatedCost,
      unit: sensor.units || 'L',
      refuelEvents: refuels.length,
      samples: periodIndices.length,
      refuels,
      drops,
      firstFuel: firstFuel !== null ? Math.round(firstFuel * 100) / 100 : null,
      lastFuel: lastFuel !== null ? Math.round(lastFuel * 100) / 100 : null,
      netDrop,
      readings, // Include readings for anomaly detection middleware
    };
  }

  /**
   * Fuel burned over the period, measured stop to stop: the level at each rest
   * point minus the level at the next, summed over every fall.
   *
   * Only readings taken at rest are used, so slosh never enters the total —
   * and a trip's burn is still counted in full, as the fall between the stop
   * before it and the stop after it. Rises are refuels and are skipped.
   */
  private restToRestConsumed(
    filtered: FuelReading[],
    restIndices: number[],
  ): number {
    let consumed = 0;
    let previousLevel: number | null = null;

    for (const index of restIndices) {
      const level = filtered[index].fuel;
      if (previousLevel !== null) {
        const fall = previousLevel - level;
        if (fall > NOISE_THRESHOLD) consumed += fall;
      }
      previousLevel = level;
    }

    return consumed;
  }

  private analyzeRows(
    rows: DataRow[],
    sensor: FuelSensor,
    imei: string,
  ): {
    drops: DropEvent[];
    refuels: RefuelEvent[];
    readings: FuelReading[];
    /** Median-filtered series, index-aligned with `readings`. */
    filtered: FuelReading[];
    atRest: StationaryTester;
  } {
    // ── Step 1: transform every row ──────────────────────────────────────────
    const raw: FuelReading[] = [];
    for (const row of rows) {
      const ts = new Date(row.dt_tracker);
      const rawValue = this.transform.extractRawValue(
        row.params,
        sensor.param,
        imei,
        ts.toISOString(),
      );
      if (rawValue === null) continue;
      const { value } = this.transform.transform(rawValue, sensor);
      if (value === null) continue;
      raw.push({ ts, fuel: value, speed: row.speed });
    }

    this.logger.log(
      `[DEBUG] IMEI ${imei} sensor param="${sensor.param}": ${rows.length} rows → ${raw.length} valid readings`,
    );

    // ── Layer 1: Median Filter ────────────────────────────────────────────────
    // Mirrors Python _filter_fuel_for_alarms() / FUEL_MEDIAN_SAMPLES = 5.
    const transformed = applyMedianFilter(raw, FUEL_MEDIAN_SAMPLES);

    // Speeds come from the unfiltered readings; the median filter maps 1:1 so
    // the two arrays share indices.
    const atRest = stationaryTester(raw);

    const drops: DropEvent[] = [];
    const refuels: RefuelEvent[] = [];
    // ── Step 2: index-based walk so we can skip forward after consolidation ──
    let i = 0;
    while (i < transformed.length) {
      const { fuel } = transformed[i];

      if (i === 0) {
        i++;
        continue;
      }

      const prev = transformed[i - 1];
      const delta = fuel - prev.fuel;
      const singleConsumed = Math.abs(delta);

      // Fuel events are read ONLY off a vehicle standing still. In motion the
      // sensor swings 10-15 L on slosh alone, so a change measured there says
      // nothing about the tank — those readings are left for the graph. What
      // the vehicle burns while driving is not lost: it shows up as the fall
      // between the stop before the trip and the stop after it, which is how
      // restToRestConsumed() measures consumption.
      //
      // Judged at the raw reading that produced the change, not at the index
      // the median filter reported it on — see rawChangeIndex().
      const changeAt = rawChangeIndex(raw, i, delta < 0 ? 'drop' : 'rise');
      if (!atRest.spansRest(changeAt - 1, changeAt)) {
        i++;
        continue;
      }

      // Standing still the sensor is steady to a few tenths of a litre, so a
      // 3 L change is already a real event.
      const dropThreshold = STATIONARY_EVENT_THRESHOLD;
      const riseThreshold = STATIONARY_EVENT_THRESHOLD;

      if (delta < -NOISE_THRESHOLD) {
        if (singleConsumed >= dropThreshold) {
          // ── Large drop: mirrors Python's handle_fuel_drop thread ──────────────
          const baselineFuel = prev.fuel;
          const dropTs = transformed[i].ts; // anchor for all checks: the drop reading
          // Scan window anchored on the DROP reading (curr.ts), not on prev.ts.
          // Python's is_fake_spike uses dt_tracker = the LOW reading timestamp.
          const windowEndMs =
            dropTs.getTime() + SPIKE_WINDOW_MINUTES * 60 * 1000;

          // Scan forward within SPIKE_WINDOW_MINUTES to find the lowest
          // sustained fuel level (equivalent to Python re-reading after 80 s).
          let verifiedFuel = fuel;
          let j = i + 1;
          while (
            j < transformed.length &&
            transformed[j].ts.getTime() <= windowEndMs
          ) {
            const nextFuel = transformed[j].fuel;
            if (nextFuel > baselineFuel - dropThreshold) break; // recovered → fake
            if (nextFuel - verifiedFuel > REFUEL_THRESHOLD) break; // refuel inside window
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
          // Mirrors Python handle_fuel_drop():
          //   1. Re-reads fuel after VERIFY_DELAY_SECONDS (80 s):
          //      drop_confirmed = new_fuel < last_val AND |last_val - new_fuel| >= 8 L
          //   2. Checks vehicle is stationary (speed <= DROP_GATING_MAX_SPEED_KMH)
          //      before confirming — if moving, alert is cancelled.
          const verifyPassed = isDropConfirmedAfterDelay(
            dropTs,
            baselineFuel,
            transformed,
            dropThreshold,
          );

          // ── Layer 3: Fake-spike check (includes speed veto) ──────────────────
          // Python's is_fake_spike queries RAW DB data (not filtered) for the
          // ±SPIKE_WINDOW_MINUTES window.  Pass `raw` here to match that exactly.
          const fake =
            !verifyPassed ||
            isFakeSpike(dropTs, raw, SPIKE_WINDOW_MINUTES, dropTolerance);

          // ── Layer 4: Post-drop verify ─────────────────────────────────────────
          // Python anchors the post-drop wait to dt_tracker (the DROP time).
          const postRecovery =
            !fake &&
            isPostDropRecovery(dropTs, baselineFuel, raw, SPIKE_WINDOW_MINUTES);

          const isConfirmedDrop =
            totalConsumed >= dropThreshold && !fake && !postRecovery;

          this.logger.log(
            `[DROP] IMEI ${imei} at ${transformed[i].ts.toISOString()}: ` +
              `baseline=${baselineFuel.toFixed(2)} verified=${verifiedFuel.toFixed(2)} ` +
              `consumed=${totalConsumed.toFixed(2)} minLiters=${dropThreshold} ` +
              `verifyPassed=${verifyPassed} fake=${fake} ` +
              `postRecovery=${postRecovery} → confirmed=${isConfirmedDrop}`,
          );

          drops.push({
            at: prev.ts.toISOString(),
            fuelBefore: Math.round(baselineFuel * 100) / 100,
            fuelAfter: Math.round(verifiedFuel * 100) / 100,
            consumed: Math.round(totalConsumed * 100) / 100,
            unit: sensor.units || 'L',
            isSensorJump: false, // consolidated big-drop events are never sensor jumps
            isConfirmedDrop,
          });

          // Skip past every reading that was merged into this consolidated event.
          i = j;
          continue;
        } else {
          // Below the threshold: record as-is, flag big single jumps.
          drops.push({
            at: prev.ts.toISOString(),
            fuelBefore: Math.round(prev.fuel * 100) / 100,
            fuelAfter: Math.round(fuel * 100) / 100,
            consumed: Math.round(singleConsumed * 100) / 100,
            unit: sensor.units || 'L',
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

        // Consolidation: scan forward for up to REFUEL_CONSOLIDATION_MINUTES to
        // find the true peak (Python polls every 20 s and tracks peak_fuel until
        // fuel stabilises or max-track time elapses).
        let peakFuel = fuel;
        // Timestamp at which the peak was actually reached. The fill itself
        // ends here — everything after is settling / driving away — so this is
        // the right upper bound for the stationary check below.
        let peakTs = transformed[i].ts;
        let k = i + 1;
        // Track whether fuel fell back below the rise threshold WITHIN the
        // consolidation window — a strong indicator of a sensor fake-spike
        // (e.g. a 30-40 L jerk that recovers in seconds/minutes).
        let falledBackInConsolidation = false;
        while (
          k < transformed.length &&
          transformed[k].ts.getTime() <= consolidationEndMs
        ) {
          const nextFuel = transformed[k].fuel;
          if (nextFuel > peakFuel) {
            peakFuel = nextFuel;
            peakTs = transformed[k].ts;
          } else if (nextFuel < baselineFuel + riseThreshold) {
            // Fuel fell back below the rise threshold within the window.
            // Only flag as fake if the drop from peak exceeds the post-refuel
            // epsilon (guards against tiny sensor oscillations on a real refuel).
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
          // Short-circuit with consolidation fallback flag first: if fuel fell
          // back significantly within the 15-min window, it is already confirmed
          // as a fake spike regardless of what isFakeRise sees in its ±7-min window.
          if (falledBackInConsolidation) {
            this.logger.warn(
              `[RISE] IMEI ${imei} at ${baselineTs.toISOString()}: ` +
                `FAKE SPIKE — fuel rose ${totalAdded.toFixed(2)}L to peak=${peakFuel.toFixed(2)} ` +
                `but fell back within consolidation window (< baselineFuel + ${riseThreshold}L)`,
            );
          }
          const fakeRise =
            falledBackInConsolidation ||
            isFakeRise(
              baselineTs,
              transformed,
              SPIKE_WINDOW_MINUTES,
              riseTolerance,
            );

          // ── Layer B: isRecoveryRise (mirrors Python is_recovery_rise) ─────────
          // "Dip then recover" pattern: fuel was already near peak BEFORE the rise
          // (sensor jerk, not real refueling).
          const recoveryRise =
            !fakeRise &&
            isRecoveryRise(
              baselineTs,
              baselineFuel,
              peakFuel,
              transformed,
              RISE_RECOVERY_LOOKBACK_MINUTES,
              riseTolerance,
            );

          // ── Layer C: isPostRefuelFallback (mirrors Python post-refuel verify) ──
          // Anchored to the END of the consolidation window so the post-verify
          // window [+7 min, +14 min] starts AFTER peak tracking is complete.
          // Using baselineTs here was wrong: that put the post window inside the
          // consolidation window where fuel is still rising / settling.
          const consolidationEndTs = new Date(consolidationEndMs);
          const postFallback =
            !fakeRise &&
            !recoveryRise &&
            isPostRefuelFallback(
              consolidationEndTs,
              baselineFuel,
              peakFuel,
              transformed,
              SPIKE_WINDOW_MINUTES,
              riseTolerance,
            );
          // ── Layer D: movement veto (shared with dashboard/reports paths) ──────
          // A station refuel happens while the vehicle is standing still, so a
          // rise the vehicle never stopped for is a sloshing artefact.
          // Scoped to the fill itself — [baselineTs, peakTs] — NOT the padded
          // consolidation window: that spanned ~29 min (7 min + 15 min + 7 min)
          // and therefore always caught the driving before/after a mid-trip
          // refuel, vetoing every genuine station stop.
          const movementDuringRefuel =
            !fakeRise &&
            !recoveryRise &&
            !postFallback &&
            this.hasMovementDuringRefuelWindow(baselineTs, peakTs, raw);

          this.logger.log(
            `[RISE] IMEI ${imei} at ${baselineTs.toISOString()}: ` +
              `added=${totalAdded.toFixed(2)}L peak=${peakFuel.toFixed(2)}L ` +
              `minLiters=${riseThreshold} ` +
              `fakeRise=${fakeRise} recoveryRise=${recoveryRise} postFallback=${postFallback} ` +
              `movementDuringRefuel=${movementDuringRefuel}`,
          );

          if (
            !fakeRise &&
            !recoveryRise &&
            !postFallback &&
            !movementDuringRefuel
          ) {
            const adjustedRefuel = this.calculateRefuelWindowBounds(
              transformed,
              baselineTs,
              consolidationEndTs,
              baselineFuel,
              peakFuel,
            );
            refuels.push({
              at: baselineTs.toISOString(),
              peakAt: peakTs.toISOString(),
              fuelBefore: Math.round(adjustedRefuel.fuelBefore * 100) / 100,
              fuelAfter: Math.round(adjustedRefuel.fuelAfter * 100) / 100,
              added: Math.round(adjustedRefuel.added * 100) / 100,
              unit: sensor.units || 'L',
            });
          }
        }

        // Skip past the consolidation window (all merged into this one event).
        i = k;
        continue;
      }

      i++;
    }

    return { drops, refuels, readings: raw, filtered: transformed, atRest };
  }

  /**
   * True when the vehicle never stood still while the fuel level rose —
   * i.e. the rise cannot be a station refuel.
   *
   * Uses the SLOWEST reading in the fill window, not the fastest: a real
   * refuel starts with the vehicle pulling in and ends with it pulling away,
   * so a single moving sample either side must not veto the event. What
   * matters is whether it came to a stop at all while the level climbed.
   */
  private hasMovementDuringRefuelWindow(
    riseAt: Date,
    peakAt: Date,
    readings: FuelReading[],
  ): boolean {
    const speeds = readings
      .filter((r) => r.ts >= riseAt && r.ts <= peakAt)
      .map((r) =>
        typeof r.speed === 'number' && Number.isFinite(r.speed) ? r.speed : 0,
      );

    if (!speeds.length) return false; // no speed data → cannot veto

    return Math.min(...speeds) > REFUEL_MOVEMENT_MAX_SPEED_KMH;
  }

  private calculateRefuelWindowBounds(
    readings: FuelReading[],
    riseAt: Date,
    consolidationEndAt: Date,
    fallbackBefore: number,
    fallbackAfter: number,
  ): { fuelBefore: number; fuelAfter: number; added: number } {
    const windowMs = REFUEL_WINDOW_BOUNDARY_MINUTES * 60 * 1000;
    const beforeStart = new Date(riseAt.getTime() - windowMs);
    const afterEnd = new Date(consolidationEndAt.getTime() + windowMs);

    const beforeWindow = readings
      .filter((r) => r.ts >= beforeStart && r.ts <= riseAt)
      .map((r) => r.fuel);
    const afterWindow = readings
      .filter((r) => r.ts >= consolidationEndAt && r.ts <= afterEnd)
      .map((r) => r.fuel);

    const fuelBefore =
      beforeWindow.length > 0 ? Math.min(...beforeWindow) : fallbackBefore;
    const afterFromWindow =
      afterWindow.length > 0 ? Math.max(...afterWindow) : fallbackAfter;
    // Keep at least the consolidation peak so we do not undercount sparse data.
    const fuelAfter = Math.max(afterFromWindow, fallbackAfter);
    const added = Math.max(0, fuelAfter - fuelBefore);

    return { fuelBefore, fuelAfter, added };
  }

  private extractPricePerLiter(fcrJson: string, from: Date): number | null {
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

      const obj = parsed as FcrConfig;
      const cost = parseFloat(obj.cost ?? '0');
      return cost > 0 ? cost : null;
    } catch {
      this.logger.warn(`Failed to parse FCR JSON: ${fcrJson}`);
      return null;
    }
  }
}
