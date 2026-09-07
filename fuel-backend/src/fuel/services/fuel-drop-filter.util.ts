/**
 * Shared fuel-drop/rise filtering utilities that mirror the Python aysis-latest.py logic.
 *
 * Python constants mirrored here:
 *   FUEL_MEDIAN_SAMPLES              = 5     (Layer 1: median filter)
 *   DROP_THRESHOLD                   = 8.0   (min drop size for a drop alert)
 *   RISE_THRESHOLD                   = 8.0   (min rise size for a refuel alert)
 *   SPIKE_WINDOW_MINUTES             = 7     (Layer 3: ±7 min fake-spike / fake-rise window)
 *   DROP_GATING_MAX_SPEED_KMH        = 10.0  (drop speed veto)
 *   RISE_GATING_MAX_SPEED_KMH        = 10.0  (rise speed veto)
 *   POST_DROP_VERIFY_EPS_LITERS      = 1.5   (Layer 4: drop recovery epsilon)
 *   POST_REFUEL_VERIFY_EPS_LITERS    = 3.5   (refuel post-verify epsilon)
 *   REFUEL_CONSOLIDATION_MINUTES     = 15    (merge multiple step-rises into one refuel)
 *   RISE_RECOVERY_EPS_LITERS         = 2.0   (refuel: recovery-rise epsilon)
 *   RISE_RECOVERY_LOOKBACK_MINUTES   = 7     (refuel: lookback for recovery rise)
 */

// ─── Constants ────────────────────────────────────────────────────────────────

/** Mirrors Python FUEL_MEDIAN_SAMPLES = 5 */
export const FUEL_MEDIAN_SAMPLES = 5;

/** Mirrors Python DROP_THRESHOLD = 8.0 */
export const DROP_ALERT_THRESHOLD = 8.0;

/** Mirrors Python SPIKE_WINDOW_MINUTES = 7 */
export const SPIKE_WINDOW_MINUTES = 7;

/**
 * Mirrors Python DROP_GATING_MAX_SPEED_KMH = 10.0
 *
 * Used in two places:
 *  1. is_fake_spike(): if any post-event reading has speed > this, the drop is
 *     treated as driving consumption (spike/noise) — not a real theft.
 *  2. handle_fuel_drop() verify delay: if the vehicle is moving at re-read time,
 *     the alert is cancelled.
 */
export const DROP_GATING_MAX_SPEED_KMH = 10.0;

/**
 * Mirrors Python POST_DROP_VERIFY_EPS_LITERS = 1.5
 * If fuel recovers within this many liters of baseline after the drop window,
 * treat the drop as a fake jerk / sensor glitch.
 */
export const POST_DROP_VERIFY_EPS_LITERS = 1.5;

/** Mirrors Python RISE_RECOVERY_EPS_LITERS = 2.0 */
export const RISE_RECOVERY_EPS_LITERS = 2.0;

/** Mirrors Python RISE_RECOVERY_LOOKBACK_MINUTES (= SPIKE_WINDOW_MINUTES = 7) */
export const RISE_RECOVERY_LOOKBACK_MINUTES = 7;

/**
 * Mirrors Python RISE_THRESHOLD = 8.0.
 * Minimum fuel increase (litres) for a rise to be counted as a real refuel.
 * Anything below this is sensor oscillation.
 */
export const RISE_THRESHOLD = 8.0;

/**
 * Mirrors Python RISE_GATING_MAX_SPEED_KMH = 10.0.
 * Post-event readings above this speed veto the refuel alert (vehicle is driving,
 * not parked at a station).
 */
export const RISE_GATING_MAX_SPEED_KMH = 10.0;

/**
 * Mirrors Python REFUEL_MAX_TRACK_SECONDS = 15 * 60.
 * After the initial rise, scan forward up to this many minutes to find the
 * true peak (consolidates multiple step-rises into one refuel event).
 */
export const REFUEL_CONSOLIDATION_MINUTES = 15;

/**
 * Mirrors Python POST_REFUEL_VERIFY_EPS_LITERS = 3.5 but raised to 8.0 here.
 *
 * The post-verify window starts AFTER consolidation ends (15 min after the
 * first rise reading). During those 15 + 7 = 22 min of post-peak time a
 * parked vehicle with its engine idling can consume 2–4 L and sensor noise
 * can add another ±3–4 L, so a 3.5 L epsilon causes false rejections for
 * genuine large refuels. 8.0 L provides a safe margin while still catching
 * fake spikes that fall back by 8 L or more from their peak.
 */
export const POST_REFUEL_VERIFY_EPS_LITERS = 8.0;

/**
 * Minimum fraction of the total rise (peakFuel − baselineFuel) that must
 * still be present after the post-verify window for a rise to count as a
 * genuine refuel. Guards against the case where `peakFuel` itself is a
 * noisy overshoot recorded while the vehicle was still moving (fuel slosh
 * can spike a reading 10-15 L above where the tank actually settles) — an
 * eps-from-peak check alone then falsely rejects a real refuel just because
 * it settled below that inflated peak, even though most of the added fuel
 * was retained.
 */
export const RISE_RETENTION_FRACTION = 0.5;

/**
 * Minimum drop/rise (litres) that counts as a real event.
 *
 * Events are only ever read off a stationary vehicle, where the sensor is
 * steady to a few tenths of a litre — so 3 L sits well clear of the noise
 * floor and small siphons and top-ups are no longer invisible. In motion the
 * same sensor swings 10-15 L on slosh alone, which is why no threshold makes a
 * moving reading meaningful and those readings are left for the graph.
 *
 * DROP_ALERT_THRESHOLD / RISE_THRESHOLD (8 L) survive as the cap in
 * eventToleranceLiters(), not as detection floors.
 */
export const STATIONARY_EVENT_THRESHOLD = 3.0;

/**
 * Speed (km/h) at or below which the vehicle counts as stationary for the
 * STATIONARY_EVENT_THRESHOLD. Matches the dispatch module's "at rest" gate:
 * GPS speed jitters by a km/h or two on a parked vehicle, so a strict 0 would
 * reject genuine stops. Deliberately well below DROP_GATING_MAX_SPEED_KMH
 * (10 km/h) — that gate means "not driving", this one means "standing still".
 */
export const STATIONARY_MAX_SPEED_KMH = 5.0;

/**
 * Minutes of stillness required BEFORE an event for the stationary threshold
 * to apply. Fuel keeps sloshing after a vehicle stops and the level settles
 * by several litres; without this delay every stop would manufacture a 3 L
 * "drop" or "refuel". Matches the 2-minute pre-event lookback that
 * isFakeSpike / isFakeRise already use.
 */
export const STATIONARY_SETTLE_MINUTES = 2;

/**
 * Constant-time tests for whether the vehicle was standing still, over one
 * reading series.
 *
 * A fuel sensor is only trustworthy on a stationary vehicle: in motion slosh
 * swings the same sensor 10-15 L between consecutive readings. Every reported
 * figure — levels, drops, refuels — is therefore taken at rest, and moving
 * readings are left for the graph alone.
 *
 * "At rest" means the reading itself is under the speed gate AND nothing in
 * the STATIONARY_SETTLE_MINUTES before it was moving. The settling margin
 * matters because fuel keeps sloshing after a vehicle stops and the level
 * settles by several litres; without it, every stop would manufacture a drop
 * or a refuel.
 *
 * Built once per series rather than rescanning per reading: the analysis walk
 * visits every reading, so a scan each time is quadratic and unusable over a
 * month of 1-minute data (~45k readings).
 */
export interface StationaryTester {
  /** True when reading `index` is at rest and has settled. */
  isSettled(index: number): boolean;
  /**
   * True when the vehicle stood still across a pair of readings — from the
   * settling margin before `prevIndex` through `currIndex` — so the change
   * between them is a real fuel movement rather than slosh.
   */
  spansRest(prevIndex: number, currIndex: number): boolean;
}

export function stationaryTester(
  readings: FuelReading[],
  maxSpeedKmh: number = STATIONARY_MAX_SPEED_KMH,
  settleMinutes: number = STATIONARY_SETTLE_MINUTES,
): StationaryTester {
  const settleMs = settleMinutes * 60 * 1000;

  // lastMovingMs[i] = timestamp of the newest reading at or before i where the
  // vehicle was moving; null while it has been at rest for the whole series.
  const lastMovingMs: Array<number | null> = readings.map(() => null);
  let newestMoving: number | null = null;
  for (let i = 0; i < readings.length; i++) {
    if ((readings[i].speed ?? 0) > maxSpeedKmh) {
      newestMoving = readings[i].ts.getTime();
    }
    lastMovingMs[i] = newestMoving;
  }

  const inRange = (index: number): boolean =>
    index >= 0 && index < readings.length;

  const restingSince = (index: number, windowStart: number): boolean => {
    const moving = lastMovingMs[index];
    return moving === null || moving < windowStart;
  };

  return {
    isSettled(index: number): boolean {
      if (!inRange(index)) return false;
      return restingSince(index, readings[index].ts.getTime() - settleMs);
    },

    spansRest(prevIndex: number, currIndex: number): boolean {
      if (!inRange(prevIndex) || !inRange(currIndex)) return false;
      return restingSince(
        currIndex,
        readings[prevIndex].ts.getTime() - settleMs,
      );
    },
  };
}

/**
 * Index of the reading where a change reported by the median filter actually
 * happened.
 *
 * A causal median filter only reports a step once it reaches the middle of its
 * window, so a change shows up two or three readings after the fact. Asking
 * whether the vehicle was standing still at the reported index therefore asks
 * about the wrong moment — and a GPS speed spike landing in those few seconds
 * hides a real parked siphon, while the sensor was in fact steady at zero when
 * the fuel actually went.
 *
 * Returns the index j whose step from j-1 is the largest in `direction` within
 * the filter's reach, so callers can judge stillness across the readings that
 * produced the change. Falls back to `reportedIndex` when nothing moved that
 * way.
 */
export function rawChangeIndex(
  raw: FuelReading[],
  reportedIndex: number,
  direction: 'drop' | 'rise',
  lookback: number = FUEL_MEDIAN_SAMPLES - 1,
): number {
  const sign = direction === 'drop' ? -1 : 1;
  const start = Math.max(1, reportedIndex - lookback);

  let bestIndex = reportedIndex;
  let bestStep = 0;

  for (let j = start; j <= reportedIndex && j < raw.length; j++) {
    const step = (raw[j].fuel - raw[j - 1].fuel) * sign;
    if (step > bestStep) {
      bestStep = step;
      bestIndex = j;
    }
  }

  return bestIndex;
}

/**
 * How much fuel movement is significant when VALIDATING an event of the given
 * magnitude — the scale the fake-spike / fake-rise / fall-back checks measure
 * recovery against.
 *
 * Distinct from STATIONARY_EVENT_THRESHOLD, which decides whether a change
 * qualifies as an event at all. Feeding that 3 L floor into the validation
 * checks instead breaks them: their "did it stay down / stay up" tests scan
 * for the first sub-move at or above the scale given, so a small scale latches
 * onto sensor noise and rejects genuine large events.
 *
 * At or above `cap` the event gets the full tolerance, exactly as before this
 * function existed. Below it — only reachable now that stationary events as
 * small as 3 L are detected — the tolerance shrinks with the event, so a 3 L
 * top-up is verified as strictly as a tank fill instead of sailing through
 * checks whose epsilon is wider than the event itself.
 */
export function eventToleranceLiters(
  magnitude: number,
  cap: number = POST_REFUEL_VERIFY_EPS_LITERS,
): number {
  const size = Math.max(0, magnitude);
  return size >= cap ? cap : size * RISE_RETENTION_FRACTION;
}

// ─── Typed row ────────────────────────────────────────────────────────────────

export interface FuelReading {
  ts: Date;
  fuel: number;
  /** Vehicle speed at this reading (km/h). Used for speed-veto in isFakeSpike. */
  speed?: number;
  /**
   * True when the ignition key is on (io239 = 1).
   * Used in isDropConfirmedAfterDelay to mirror Python's
   * _is_allowed_for_fuel_drop_alarm: a drop is only confirmed when
   * the engine is off OR the vehicle is stationary (speed ≤ gate).
   * Spread by applyMedianFilter (via { ...r, fuel: median }) so it
   * automatically flows to the filtered array without extra wiring.
   */
  ignitionOn?: boolean;
}

// ─── Layer 1: Median Filter ───────────────────────────────────────────────────

/**
 * Mirrors Python _filter_fuel_for_alarms() — CAUSAL (backward-only) median filter.
 *
 * Python uses a deque(maxlen=n) that only keeps the N most recent samples,
 * i.e. a backward-looking window.  This is a CAUSAL filter: each output
 * sample is the median of the current reading and the (n-1) readings before
 * it — future readings are NOT included.
 *
 * This directly mirrors Python's behaviour:
 *   dq.append((dt_tracker, fv))  ← causal: only past samples
 *   vals = [v for (_t, v) in dq if v is not None]
 *   return median(vals)
 *
 * All other fields (ts, speed, …) are preserved from the original reading.
 */
export function applyMedianFilter(
  readings: FuelReading[],
  windowSize: number = FUEL_MEDIAN_SAMPLES,
): FuelReading[] {
  if (windowSize < 2 || readings.length === 0) return readings;

  return readings.map((r, i) => {
    // Backward-only window: [i - windowSize + 1 … i]
    const start = Math.max(0, i - windowSize + 1);
    const window = readings
      .slice(start, i + 1)
      .map((x) => x.fuel)
      .sort((a, b) => a - b);
    const median = window[Math.floor(window.length / 2)];
    return { ...r, fuel: median };
  });
}

// ─── Layer 2: Verify Delay Check ─────────────────────────────────────────────

/**
 * Mirrors Python handle_fuel_drop()'s verify delay (VERIFY_DELAY_SECONDS = 80s).
 *
 * Python waits 80 s then re-reads the CURRENT fuel from gs_objects and checks:
 *   1. Drop is still >= DROP_THRESHOLD below baseline (drop_confirmed).
 *   2. Vehicle is still stationary (speed <= DROP_GATING_MAX_SPEED_KMH).
 * If either fails → skip alert.
 *
 * For historical data we replicate this by inspecting the NEXT available
 * reading after the drop.  Returns true when the drop is still confirmed
 * (both checks pass), false when Python would have cancelled the alert.
 *
 * Special case: if no subsequent reading is found within maxGapMinutes
 * (data gap), we conservatively assume the drop is sustained (return true).
 */
export function isDropConfirmedAfterDelay(
  dropTs: Date,
  baselineFuel: number,
  allRows: FuelReading[],
  dropThreshold: number = DROP_ALERT_THRESHOLD,
  maxSpeedKmh: number = DROP_GATING_MAX_SPEED_KMH,
  maxGapMinutes: number = 10,
): boolean {
  const maxGapMs = maxGapMinutes * 60 * 1000;
  const deadlineTs = new Date(dropTs.getTime() + maxGapMs);

  // Find the first reading AFTER the drop timestamp within the gap window.
  const verifyRow = allRows.find((r) => r.ts > dropTs && r.ts <= deadlineTs);

  if (!verifyRow) {
    // No new data within gap → assume still dropped (Python: gs_objects still shows old value)
    return true;
  }

  // Check 1: drop is still >= DROP_THRESHOLD (Python: drop_confirmed)
  const stillDropped =
    verifyRow.fuel < baselineFuel &&
    Math.abs(baselineFuel - verifyRow.fuel) >= dropThreshold;

  // Check 2: vehicle is stationary — mirrors Python _is_allowed_for_fuel_drop_alarm.
  //
  // Python gates on ignition (io239) AND speed:
  //   • ignition OFF  → vehicle is parked → allow drop alert regardless of speed
  //   • ignition ON + speed > DROP_GATING_MAX_SPEED_KMH → driving consumption → cancel
  //   • ignition ON + speed ≤ threshold → idling/parked → allow
  //
  // If ignitionOn is undefined (caller didn't supply it) we fall back to the
  // speed-only check so existing callers (fuel-consumption, fuel-stats) are unaffected.
  const isMovingWithIgnitionOn =
    verifyRow.ignitionOn === true && (verifyRow.speed ?? 0) > maxSpeedKmh;
  const vehicleStationary = !isMovingWithIgnitionOn;

  return stillDropped && vehicleStationary;
}

/** How far back the movement veto looks before a candidate event point. */
const MOVEMENT_VETO_LOOKBACK_MINUTES = 2;

/**
 * True when the vehicle was continuously moving in the run-up to EVERY point
 * in `candidates` — the condition for writing a fuel change off as slosh.
 *
 * Every candidate, not just the first: the median filter lags the detected
 * event, so the window is scanned for the reading where fuel actually crossed
 * the threshold. A vehicle sloshing on its way to a stop crosses that
 * threshold on the move and again once parked, and judging only the first
 * crossing vetoed the parked event that followed it. If any candidate had a
 * stationary run-up, the change is not slosh.
 */
function continuouslyMovingBefore(
  candidates: Date[],
  readings: FuelReading[],
  maxSpeedKmh: number,
): boolean {
  const lookbackMs = MOVEMENT_VETO_LOOKBACK_MINUTES * 60 * 1000;
  let sawEvidence = false;

  for (const candidate of candidates) {
    const runUp = readings.filter(
      (r) =>
        r.ts < candidate && r.ts.getTime() >= candidate.getTime() - lookbackMs,
    );
    if (!runUp.length) continue; // no evidence either way for this candidate

    sawEvidence = true;
    if (runUp.some((r) => (r.speed ?? 0) <= maxSpeedKmh)) {
      return false; // came to a stop before this one → not slosh
    }
  }

  return sawEvidence;
}

// ─── Layer 3: Fake-Spike Detection ───────────────────────────────────────────

/**
 * Mirrors Python is_fake_spike() from aysis-latest.py — including the
 * MOVEMENT VETO that was previously missing.
 *
 * Looks at a ±SPIKE_WINDOW_MINUTES window around `dropAt` and decides whether
 * the observed drop is a real sustained loss or a transient sensor oscillation.
 *
 * Returns true  → fake spike (sensor noise / continuous fluctuation / movement)
 *                  → suppress alert
 * Returns false → fuel stayed low → real confirmed drop → allow alert
 *
 * ── Speed veto (mirrors Python lines 2096-2109) ──────────────────────────────
 * If ANY reading in the post-event window (ts > dropAt) has speed
 * > DROP_GATING_MAX_SPEED_KMH, the drop is treated as driving consumption
 * noise, not a real theft/leak. Python comment:
 *   "Rows BEFORE dt_tracker are from the vehicle approaching/driving — that is
 *    normal and should not disqualify a real fuel drop that happened after parking."
 *
 * ── Fuel-pattern checks (mirrors Python lines 2128-2146) ────────────────────
 * 1. finalFuel >= startFuel → fully recovered → fake
 * 2. |finalFuel - startFuel| <= DROP_THRESHOLD → nearly recovered → fake
 * 3. Finds first large sub-drop and checks if it stays low
 */
export function isFakeSpike(
  dropAt: Date,
  allRows: FuelReading[],
  spikeWindowMinutes: number = SPIKE_WINDOW_MINUTES,
  dropThreshold: number = DROP_ALERT_THRESHOLD,
  maxSpeedKmh: number = DROP_GATING_MAX_SPEED_KMH,
): boolean {
  const windowMs = spikeWindowMinutes * 60 * 1000;
  const winStart = new Date(dropAt.getTime() - windowMs);
  const winEnd = new Date(dropAt.getTime() + windowMs);

  const readings = allRows.filter((r) => r.ts >= winStart && r.ts <= winEnd);
  if (readings.length < 2) return false; // not enough data → assume real

  // ── Speed veto ───────────────────────────────────────────────────────────
  // The median filter delays the filtered dropAt by 2-3 readings (~1-2 min)
  // relative to the actual raw drop. Checking post-dropAt movement therefore
  // catches the vehicle DRIVING AWAY after a real theft, not just sloshing.
  //
  // Correct approach: find the raw drop point (first reading in the window
  // where fuel crosses below startFuel - threshold) and check whether the
  // vehicle was CONTINUOUSLY MOVING in the 2 minutes BEFORE that raw drop.
  //   • Continuously moving before drop → sloshing → fake
  //   • Parked before drop (even if driving away after) → theft → real
  const startFuel = readings[0].fuel;
  const rawDropCandidates = readings
    .filter((r, i) => i > 0 && r.fuel < startFuel - dropThreshold)
    .map((r) => r.ts);
  if (!rawDropCandidates.length) rawDropCandidates.push(dropAt);

  if (continuouslyMovingBefore(rawDropCandidates, readings, maxSpeedKmh)) {
    return true;
  }

  // ── Fuel-pattern checks ───────────────────────────────────────────────────
  const finalFuel = readings[readings.length - 1].fuel;

  // Condition 1: fuel fully recovered (or exceeded baseline)
  if (finalFuel >= startFuel) return true;

  // Condition 2: nearly recovered (within DROP_THRESHOLD)
  if (Math.abs(finalFuel - startFuel) <= dropThreshold) return true;

  // Condition 3: scan ALL large sub-drops in the window.
  // A single recovered sub-drop (driving sloshing) must not suppress detection
  // of a later sustained theft drop in the same window.
  // → Only declare "fake" when EVERY large sub-drop recovered.
  // → "real" if at least one large sub-drop stayed low, OR if no large
  //    sub-drop was found at all (gradual drop, already cleared by conditions 1-2).
  let foundLargeSubdrop = false;
  for (let j = 0; j < readings.length - 1; j++) {
    const delta = readings[j].fuel - readings[j + 1].fuel;
    if (delta >= dropThreshold) {
      foundLargeSubdrop = true;
      const stayedLow = readings
        .slice(j + 1)
        .every((r) => Math.abs(r.fuel - readings[j].fuel) > dropThreshold);
      if (stayedLow) return false; // sustained drop found → real
      // this sub-drop recovered → keep scanning for a sustained one
    }
  }

  // All large sub-drops recovered → fake.
  // No large sub-drops at all → real (gradual drop already vetted by conditions 1-2).
  return foundLargeSubdrop;
}

// ─── Layer 4: Post-Drop Verification ─────────────────────────────────────────

/**
 * Mirrors Python's post-drop verify step (POST_DROP_VERIFY_SECONDS = 420 s / 7 min).
 *
 * After the ±SPIKE_WINDOW_MINUTES window, Python waits a further
 * POST_DROP_VERIFY_SECONDS and re-reads the live fuel value.
 * If the fuel snapped back to within POST_DROP_VERIFY_EPS_LITERS of the
 * baseline, the drop is treated as a sensor glitch and no email is sent.
 *
 * For historical data we replicate this by looking at readings in the
 * "post window" — the 7 minutes AFTER the spike window (i.e. from
 * +SPIKE_WINDOW_MINUTES to +2×SPIKE_WINDOW_MINUTES from `dropAt`).
 *
 * Returns true  → fuel recovered in post window → treat as fake jerk
 * Returns false → fuel stayed low in post window → confirmed real drop
 */
export function isPostDropRecovery(
  dropAt: Date,
  baselineFuel: number,
  allRows: FuelReading[],
  spikeWindowMinutes: number = SPIKE_WINDOW_MINUTES,
  eps: number = POST_DROP_VERIFY_EPS_LITERS,
): boolean {
  const windowMs = spikeWindowMinutes * 60 * 1000;
  const postStart = new Date(dropAt.getTime() + windowMs);
  const postEnd = new Date(dropAt.getTime() + 2 * windowMs);

  const postReadings = allRows.filter(
    (r) => r.ts > postStart && r.ts <= postEnd,
  );
  if (postReadings.length === 0) return false;

  // Python: if v_fuel >= float(last_val) - eps → skip as fake jerk
  const lastPostFuel = postReadings[postReadings.length - 1].fuel;
  return lastPostFuel >= baselineFuel - eps;
}

// ─── Recovery-Rise Detection (for refuels) ────────────────────────────────────

/**
 * Mirrors Python is_recovery_rise() from aysis-latest.py.
 *
 * Detects "dip then recover" patterns where the fuel was already near
 * `peakFuel` BEFORE `dropAt`, then temporarily dipped to `baselineFuel`,
 * then came back up.  That's usually a sensor jerk, not a real refuel.
 *
 * Returns true  → looks like a recovery (skip refuel alert)
 * Returns false → real refuel
 */
export function isRecoveryRise(
  dropAt: Date,
  baselineFuel: number,
  peakFuel: number,
  allRows: FuelReading[],
  lookbackMinutes: number = RISE_RECOVERY_LOOKBACK_MINUTES,
  riseThreshold: number = DROP_ALERT_THRESHOLD,
  eps: number = RISE_RECOVERY_EPS_LITERS,
): boolean {
  const lookbackMs = lookbackMinutes * 60 * 1000;
  const lookStart = new Date(dropAt.getTime() - lookbackMs);

  const preReadings = allRows
    .filter((r) => r.ts >= lookStart && r.ts < dropAt)
    .map((r) => r.fuel);

  if (preReadings.length === 0) return false;

  const preMax = Math.max(...preReadings);
  const preMin = Math.min(...preReadings);

  if (
    preMax >= peakFuel - eps &&
    preMin <= baselineFuel + eps &&
    preMax - preMin >= riseThreshold
  ) {
    return true;
  }

  return false;
}

// ─── Refuel: Fake-Rise Detection ─────────────────────────────────────────────

/**
 * Mirrors Python is_fake_rise() from aysis-latest.py.
 *
 * Inverse of isFakeSpike: looks at a ±SPIKE_WINDOW_MINUTES window around
 * `riseAt` and decides whether the observed rise is a real sustained refuel
 * or a transient sensor oscillation.
 *
 * Returns true  → fake rise (sensor noise / brief jerk / vehicle moving)
 *                  → suppress refuel alert
 * Returns false → fuel stayed high → real confirmed refuel → allow alert
 *
 * ── Speed veto (mirrors Python is_fake_rise lines 2182-2195) ─────────────────
 * If ANY post-event reading (ts > riseAt) has speed > RISE_GATING_MAX_SPEED_KMH
 * the rise is treated as a sensor transient during driving — not a parked refuel.
 * Note: Python only applies the speed veto to post-event rows (vehicle driving
 * TO the station before the event is normal and must not veto a real refuel).
 *
 * ── Fuel-pattern checks (mirrors Python is_fake_rise lines 2213-2231) ────────
 * 1. finalFuel <= startFuel → rose then fell back → fake
 * 2. |finalFuel - startFuel| <= RISE_THRESHOLD → did not sustain → fake
 * 3. Finds first large sub-rise and checks if fuel stayed high afterwards
 */
export function isFakeRise(
  riseAt: Date,
  allRows: FuelReading[],
  spikeWindowMinutes: number = SPIKE_WINDOW_MINUTES,
  riseThreshold: number = RISE_THRESHOLD,
  maxSpeedKmh: number = RISE_GATING_MAX_SPEED_KMH,
): boolean {
  const windowMs = spikeWindowMinutes * 60 * 1000;
  const winStart = new Date(riseAt.getTime() - windowMs);
  const winEnd = new Date(riseAt.getTime() + windowMs);

  const readings = allRows.filter((r) => r.ts >= winStart && r.ts <= winEnd);
  if (readings.length < 2) return false; // not enough data → assume real

  // ── Speed veto: check movement BEFORE the raw rise, not after ───────────
  //
  // The 5-point causal median filter delays the detected riseAt by 2-3 readings
  // (~1-2 min) relative to the actual refuel moment. Checking post-riseAt speed
  // therefore catches the vehicle DRIVING AWAY after a legitimate refuel, not
  // just sloshing noise. This would suppress real refuels.
  //
  // Correct approach: find the raw rise point (first reading in the window where
  // fuel crosses above baseline + threshold) and check whether the vehicle was
  // CONTINUOUSLY MOVING in the 2 minutes BEFORE that raw rise.
  //   • Continuously moving before rise → sloshing → fake
  //   • Parked before rise (even if driving away after) → real refuel
  const startFuelForRise = readings[0].fuel;
  const rawRiseCandidates = readings
    .filter((r, i) => i > 0 && r.fuel > startFuelForRise + riseThreshold)
    .map((r) => r.ts);
  if (!rawRiseCandidates.length) rawRiseCandidates.push(riseAt);

  if (continuouslyMovingBefore(rawRiseCandidates, readings, maxSpeedKmh)) {
    return true;
  }

  // ── Fuel-pattern checks ───────────────────────────────────────────────────
  const startFuel = readings[0].fuel;
  const finalFuel = readings[readings.length - 1].fuel;

  // Rose then fell back to or below start → fake
  if (finalFuel <= startFuel) return true;

  // Did not sustain the rise → fake
  if (Math.abs(finalFuel - startFuel) <= riseThreshold) return true;

  // Scan ALL large sub-rises in the window — mirroring the same fix already
  // made to isFakeSpike's sub-drop scan.
  //
  // Returning on the FIRST sub-rise made a real refuel look fake whenever the
  // window also caught the drive to the station: fuel slosh throws up 8-15 L
  // sub-rises that immediately fall back, and the scan judged the whole window
  // on one of those. The refuel that followed was never looked at.
  // → fake only when EVERY large sub-rise fell back.
  let foundLargeSubrise = false;
  for (let i = 0; i < readings.length - 1; i++) {
    const delta = readings[i + 1].fuel - readings[i].fuel;
    if (delta >= riseThreshold) {
      foundLargeSubrise = true;
      const stayedHigh = readings
        .slice(i + 1)
        .every((r) => Math.abs(r.fuel - readings[i].fuel) > riseThreshold);
      if (stayedHigh) return false; // sustained rise found → real
      // this sub-rise fell back → keep scanning for a sustained one
    }
  }

  // All large sub-rises fell back → fake.
  // No large sub-rise at all → real (gradual rise already vetted above).
  return foundLargeSubrise;
}

// ─── Refuel: Stationary-Drop Recovery Detection ──────────────────────────────

/**
 * Detects the "sensor glitch while parked → brief movement → recovery" pattern:
 *
 *   1. Vehicle is parked at ~X litres (speed = 0).
 *   2. Sensor drops suddenly by ≥ RISE_THRESHOLD while vehicle is STILL parked
 *      (both the reading before and after the drop have speed = 0).
 *   3. Vehicle moves briefly.
 *   4. After re-parking, sensor reads back up to ~X litres.
 *   5. The rise detector sees the gap between the post-glitch low and the
 *      recovered level as a "refuel", but no fuel was actually added.
 *
 * Returns true  → rise is a recovery from a parked sensor drop → suppress
 * Returns false → not this pattern → treat as normal rise
 *
 * lookbackMinutes: how far back to scan for the stationary drop (default 90 min).
 * 90 minutes covers cases where the sensor glitch drop and the recovery rise
 * are separated by up to ~1.5 hours of parked/idle time after a real refuel.
 * The condition curr.fuel >= peakFuel - eps (near full-tank level) combined
 * with speed=0 on both readings prevents false positives from normal driving
 * consumption.
 */
export function isStationaryDropRecovery(
  riseAt: Date,
  peakFuel: number,
  allRows: FuelReading[],
  lookbackMinutes: number = 90,
  dropThreshold: number = RISE_THRESHOLD,
  eps: number = RISE_RECOVERY_EPS_LITERS,
): boolean {
  const lookbackMs = lookbackMinutes * 60 * 1000;
  const lookStart = new Date(riseAt.getTime() - lookbackMs);

  const preReadings = allRows.filter((r) => r.ts >= lookStart && r.ts < riseAt);
  if (preReadings.length < 2) return false;

  for (let i = 0; i < preReadings.length - 1; i++) {
    const curr = preReadings[i];
    const next = preReadings[i + 1];
    const drop = curr.fuel - next.fuel;

    if (
      drop >= dropThreshold &&
      (curr.speed ?? 0) === 0 &&
      (next.speed ?? 0) === 0 &&
      curr.fuel >= peakFuel - eps
    ) {
      return true;
    }
  }

  return false;
}

// ─── Refuel: Post-Verify Fallback ────────────────────────────────────────────

/**
 * Mirrors Python's post-refuel verify step (POST_REFUEL_VERIFY_SECONDS = 420 s / 7 min).
 *
 * After the consolidation window Python waits POST_REFUEL_VERIFY_SECONDS and
 * re-reads the live fuel.  If it fell back notably from the tracked peak the
 * refuel is treated as a fake jerk/spike.
 *
 * For historical data we replicate this by looking at the period from
 * +SPIKE_WINDOW_MINUTES to +2×SPIKE_WINDOW_MINUTES after `riseAt` (same
 * approach as isPostDropRecovery does for drops).
 *
 * Returns true  → fuel fell back from peak → fake jerk → suppress refuel
 * Returns false → fuel stayed high → real refuel confirmed
 */
export function isPostRefuelFallback(
  riseAt: Date,
  baselineFuel: number,
  peakFuel: number,
  allRows: FuelReading[],
  spikeWindowMinutes: number = SPIKE_WINDOW_MINUTES,
  eps: number = POST_REFUEL_VERIFY_EPS_LITERS,
  retentionFraction: number = RISE_RETENTION_FRACTION,
): boolean {
  const windowMs = spikeWindowMinutes * 60 * 1000;
  const postStart = new Date(riseAt.getTime() + windowMs);
  const postEnd = new Date(riseAt.getTime() + 2 * windowMs);

  const totalRise = peakFuel - baselineFuel;

  // Fake only if BOTH the reading fell more than eps below peak AND most of
  // the rise from baseline was lost — a genuine refuel can settle well below
  // a motion-noise-inflated peak while still keeping most of the added fuel.
  const isFake = (fuel: number): boolean => {
    if (fuel >= peakFuel - eps) return false;
    if (totalRise <= 0) return true;
    return (fuel - baselineFuel) / totalRise < retentionFraction;
  };

  const postReadings = allRows.filter(
    (r) => r.ts > postStart && r.ts <= postEnd,
  );

  if (postReadings.length === 0) {
    // Sparse data: no readings in the standard [+7, +14] min window.
    // Extend the search up to +30 min and use the FIRST reading found.
    // A real refuel keeps fuel near peak; a fake spike will show fuel near
    // the original baseline regardless of how far out the next reading is.
    const extendedEnd = new Date(riseAt.getTime() + 30 * 60 * 1000);
    const firstExtended = allRows.find(
      (r) => r.ts > postStart && r.ts <= extendedEnd,
    );
    if (!firstExtended) return false; // still no data → assume sustained
    return isFake(firstExtended.fuel);
  }

  const lastPostFuel = postReadings[postReadings.length - 1].fuel;
  return isFake(lastPostFuel);
}
