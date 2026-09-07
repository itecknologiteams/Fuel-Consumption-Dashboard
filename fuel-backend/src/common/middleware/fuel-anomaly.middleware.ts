import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { FuelReading } from '../../fuel/services/fuel-drop-filter.util';

/**
 * Anomaly detection result for a single refuel event
 */
export interface RefuelAnomalyResult {
  isAnomaly: boolean;
  anomalyType:
    | 'fake_spike' // Rose then fell back immediately
    | 'sensor_reset' // Dip then recover pattern
    | 'unsustained_rise' // Didn't stay high long enough
    | 'movement_during_refuel' // Vehicle moving during refuel
    | 'no_stationary_period' // Never stopped moving
    | 'voltage_glitch' // Sudden voltage-based jump
    | 'none'; // Legitimate refuel

  confidence: number; // 0-100 confidence score
  reason: string; // Human-readable explanation
  details: {
    fuelBefore: number;
    peakFuel: number;
    fuelAfterWindow: number;
    hadMovementAfter: boolean;
    maxSpeedDuring: number;
    maxSpeedAfter: number;
    sustainedMinutes: number;
    fallbackAmount: number; // How much fuel fell back
  };
}

/**
 * Fuel Anomaly Detection Middleware
 *
 * Intercepts responses from fuel endpoints and:
 * 1. Detects fake refuel spikes (sensor noise, voltage glitches)
 * 2. Validates real refuels (stationary, sustained high level)
 * 3. Adds anomaly metadata to responses
 * 4. Can optionally filter out anomalous events
 */
@Injectable()
export class FuelAnomalyMiddleware implements NestMiddleware {
  private readonly logger = new Logger(FuelAnomalyMiddleware.name);

  // Thresholds (match your Python/frontend constants)
  private readonly RISE_THRESHOLD = 8.0;
  private readonly SPIKE_WINDOW_MINUTES = 7;
  private readonly POST_VERIFY_MINUTES = 7;
  private readonly RISE_GATING_MAX_SPEED_KMH = 10.0;
  private readonly SUSTAINED_MIN_MINUTES = 15;
  private readonly SUSTAINED_EPSILON_LITERS = 3.0;
  private readonly FALLBACK_EPSILON_LITERS = 3.5;
  /**
   * Fraction of a rise that must be retained for it to count as real —
   * mirrors RISE_RETENTION_FRACTION in fuel-drop-filter.util.ts.
   */
  private readonly RETENTION_FRACTION = 0.5;

  /**
   * Tolerance to use when validating one refuel — mirrors
   * eventToleranceLiters() in fuel-drop-filter.util.ts.
   *
   * A refuel at or above `cap` gets the full tolerance, exactly as before.
   * Below it — only reachable now that stationary refuels as small as 3 L are
   * detected — the tolerance shrinks with the event: a 3 L tolerance spans a
   * 3 L top-up entirely, so every check would pass no matter what the sensor
   * did afterwards.
   */
  private epsFor(added: number, cap: number): number {
    const size = Math.max(0, added);
    return size >= cap ? cap : size * this.RETENTION_FRACTION;
  }

  use(req: Request, res: Response, next: NextFunction) {
    // Capture the original json method
    const originalJson = res.json.bind(res);

    // Override json to intercept fuel data responses
    res.json = (body: any) => {
      // Check if this is a fuel consumption/history response
      if (this.isFuelResponse(body)) {
        const imei = body.imei || body.data?.imei || 'unknown';
        const refuelCount =
          body.refuels?.length || body.data?.refuels?.length || 0;
        this.logger.log(
          `[AnomalyMiddleware] Processing fuel response for IMEI=${imei}, refuels=${refuelCount}`,
        );

        try {
          const processedBody = this.processFuelResponse(body);
          const anomalousCount =
            processedBody._anomalyMeta?.summary?.anomalous || 0;
          if (anomalousCount > 0) {
            this.logger.warn(
              `[AnomalyMiddleware] ⚠️ Detected ${anomalousCount} anomalous refuel(s) for IMEI=${imei}`,
            );
          }
          return originalJson(processedBody);
        } catch (error: any) {
          this.logger.error(
            `[AnomalyMiddleware] Error processing response: ${error.message}`,
          );
          // Return original if processing fails
          return originalJson(body);
        }
      }

      // Not a fuel response, pass through unchanged
      return originalJson(body);
    };

    next();
  }

  /**
   * Check if response body contains fuel data we should analyze
   */
  private isFuelResponse(body: any): boolean {
    if (!body || typeof body !== 'object') return false;

    // Check for refuels array (from fuel-consumption.service)
    if (body.refuels && Array.isArray(body.refuels)) return true;

    // Check for wrapped response format
    if (body.data?.refuels && Array.isArray(body.data.refuels)) return true;

    // Check for fuel history buckets
    if (body.buckets && Array.isArray(body.buckets)) return true;

    return false;
  }

  /**
   * Process fuel response and add anomaly detection
   */
  private processFuelResponse(body: any): any {
    const refuels = body.refuels || body.data?.refuels || [];

    if (refuels.length === 0) return body;

    // Get readings from response or fetch them
    const readings = this.extractReadings(body);

    // Validate each refuel
    const validatedRefuels = refuels.map((refuel: any) => {
      const anomalyCheck = this.detectRefuelAnomaly(refuel, readings);

      return {
        ...refuel,
        // Add anomaly metadata
        _anomaly: anomalyCheck,
        // Flag for easy filtering
        isVerified: !anomalyCheck.isAnomaly,
        // Visual indicator
        reliabilityScore: anomalyCheck.isAnomaly ? 0 : anomalyCheck.confidence,
      };
    });

    // Calculate summary stats
    const anomalySummary = {
      total: validatedRefuels.length,
      verified: validatedRefuels.filter((r: any) => r.isVerified).length,
      anomalous: validatedRefuels.filter((r: any) => !r.isVerified).length,
      byType: this.categorizeAnomalies(validatedRefuels),
    };

    // Recalculate refueled total and event count excluding anomalous refuels.
    // The original body.refueled is computed by the service BEFORE anomaly
    // detection, so it may include fake spikes. We override it here with the
    // verified-only sum so the frontend always sees the corrected amount.
    const verifiedRefuels = validatedRefuels.filter((r: any) => r.isVerified);
    const verifiedRefueled =
      Math.round(
        verifiedRefuels.reduce(
          (sum: number, r: any) => sum + (r.added || 0),
          0,
        ) * 100,
      ) / 100;
    const anomalyMeta = {
      summary: anomalySummary,
      detectionVersion: '1.0.0',
      checkedAt: new Date().toISOString(),
    };

    if (anomalySummary.anomalous > 0) {
      this.logger.log(
        `[AnomalyMiddleware] Correcting refueled: ${body.refueled ?? body.data?.refueled}L → ${verifiedRefueled}L ` +
          `(removed ${anomalySummary.anomalous} anomalous event(s))`,
      );
    }

    // Build processed response
    const processed: any = {
      ...body,
      refuels: validatedRefuels,
      refueled: verifiedRefueled,
      refuelEvents: verifiedRefuels.length,
      _anomalyMeta: anomalyMeta,
    };

    // Also update wrapped data.refuels if present (response envelope format)
    if (body.data?.refuels) {
      processed.data = {
        ...body.data,
        refuels: validatedRefuels,
        refueled: verifiedRefueled,
        refuelEvents: verifiedRefuels.length,
        _anomalyMeta: anomalyMeta,
      };
    }

    // Log anomalies for debugging
    this.logAnomalies(
      body.imei || body.data?.imei || 'unknown',
      validatedRefuels,
    );

    return processed;
  }

  /**
   * Main anomaly detection logic for a single refuel event
   */
  private detectRefuelAnomaly(
    refuel: any,
    readings: FuelReading[],
  ): RefuelAnomalyResult {
    const fuelBefore = refuel.fuelBefore;
    const peakFuel = refuel.fuelAfter || refuel.added + fuelBefore;
    const riseAt = new Date(refuel.at);
    const added = refuel.added || peakFuel - fuelBefore;
    // Post-fill checks must start when the fill FINISHED. Anchoring them on
    // `at` (the baseline reading) puts their windows inside the fill itself,
    // where the level is still climbing — read as a fall-back from the peak,
    // which rejected every refuel that took more than a minute.
    const peakAt = refuel.peakAt ? new Date(refuel.peakAt) : riseAt;

    this.logger.log(
      `[AnomalyMiddleware] Analyzing refuel: +${added.toFixed(1)}L at ${riseAt.toISOString()} ` +
        `(before: ${fuelBefore.toFixed(1)}L, after: ${peakFuel.toFixed(1)}L), ` +
        `readings available: ${readings?.length || 0}`,
    );

    // Default result (assume legitimate)
    const result: RefuelAnomalyResult = {
      isAnomaly: false,
      anomalyType: 'none',
      confidence: 0,
      reason: 'Sustained fuel rise while stationary - legitimate refuel',
      details: {
        fuelBefore,
        peakFuel,
        fuelAfterWindow: peakFuel,
        hadMovementAfter: false,
        maxSpeedDuring: 0,
        maxSpeedAfter: 0,
        sustainedMinutes: 0,
        fallbackAmount: 0,
      },
    };

    // Need readings to perform analysis
    if (!readings || readings.length === 0) {
      this.logger.warn(
        `[AnomalyMiddleware] No readings available for refuel at ${riseAt.toISOString()} - marking as suspicious`,
      );
      return {
        ...result,
        isAnomaly: true,
        anomalyType: 'no_stationary_period',
        confidence: 50,
        reason: 'Insufficient data to validate refuel - treating as suspicious',
      };
    }

    // ─── CHECK 0: Quick Spike Detection (for fake 30-40L jerks) ─────────────────
    // Check if fuel dropped significantly within first 5 minutes after rise
    const quickSpikeCheck = this.checkQuickSpike(
      peakAt,
      fuelBefore,
      peakFuel,
      readings,
      added,
    );
    if (quickSpikeCheck.isQuickSpike) {
      this.logger.warn(
        `[AnomalyMiddleware] 🚨 QUICK SPIKE detected: +${added.toFixed(1)}L dropped ${quickSpikeCheck.fallbackAmount.toFixed(1)}L ` +
          `within ${quickSpikeCheck.minutes.toFixed(1)} minutes`,
      );
      return {
        ...result,
        isAnomaly: true,
        anomalyType: 'fake_spike',
        confidence: 90,
        reason:
          `Fuel spiked +${added.toFixed(1)}L but dropped ${quickSpikeCheck.fallbackAmount.toFixed(1)}L ` +
          `within ${Math.round(quickSpikeCheck.minutes)} minutes - sensor jerk detected`,
      };
    }

    // ─── CHECK 1: Movement Pattern ─────────────────────────────────────────────
    const movementCheck = this.analyzeMovementPattern(riseAt, readings);
    result.details.maxSpeedDuring = movementCheck.maxSpeedDuring;
    result.details.maxSpeedAfter = movementCheck.maxSpeedAfter;
    result.details.hadMovementAfter = movementCheck.hadMovementAfter;

    // If moving during refuel window, likely not a real station stop
    if (movementCheck.hadMovementDuring) {
      return {
        ...result,
        isAnomaly: true,
        anomalyType: 'movement_during_refuel',
        confidence: 75,
        reason:
          `Vehicle never stopped during the refuel window ` +
          `(peak ${movementCheck.maxSpeedDuring.toFixed(1)} km/h) - not at a station`,
      };
    }

    // ─── CHECK 2: Fuel Sustained? ──────────────────────────────────────────────
    const sustainedCheck = this.checkFuelSustained(
      peakAt,
      fuelBefore,
      peakFuel,
      readings,
      added,
    );
    result.details.sustainedMinutes = sustainedCheck.durationMin;

    if (!sustainedCheck.sustained) {
      return {
        ...result,
        isAnomaly: true,
        anomalyType: 'unsustained_rise',
        confidence: 80,
        reason:
          `Fuel did not sustain for ${this.SUSTAINED_MIN_MINUTES} minutes ` +
          `(only ${sustainedCheck.durationMin} min) - possible sensor glitch`,
      };
    }

    // ─── CHECK 3: Fallback After Rise ──────────────────────────────────────────
    const fallbackCheck = this.checkPostRefuelFallback(
      peakAt,
      fuelBefore,
      peakFuel,
      readings,
      added,
    );
    result.details.fuelAfterWindow = fallbackCheck.finalFuel;
    result.details.fallbackAmount = fallbackCheck.fallbackAmount;

    this.logger.debug(
      `[AnomalyMiddleware] Fallback check for +${added.toFixed(1)}L at ${riseAt.toISOString()}: ` +
        `window=${fallbackCheck.windowChecked}, ` +
        `fallback=${fallbackCheck.fallbackAmount.toFixed(1)}L, ` +
        `threshold=${this.epsFor(added, this.FALLBACK_EPSILON_LITERS)}L, ` +
        `didFallback=${fallbackCheck.didFallback}`,
    );

    if (fallbackCheck.didFallback) {
      // Check if it's a recovery rise (dip then recover to previous level)
      const isRecovery = this.isRecoveryRise(
        riseAt,
        fuelBefore,
        peakFuel,
        readings,
        added,
      );

      if (isRecovery) {
        return {
          ...result,
          isAnomaly: true,
          anomalyType: 'sensor_reset',
          confidence: 90,
          reason: `Fuel recovered from dip to previous high level - sensor reset, not real refuel`,
        };
      }

      return {
        ...result,
        isAnomaly: true,
        anomalyType: 'fake_spike',
        confidence: 85,
        reason:
          `Fuel rose ${added.toFixed(1)}L but fell back ${fallbackCheck.fallbackAmount.toFixed(
            1,
          )}L ` +
          `within ${this.SPIKE_WINDOW_MINUTES} minutes - fake spike detected`,
      };
    }

    // ─── CHECK 4: Speed Veto (Post-Event Movement) ────────────────────────────
    if (movementCheck.hadMovementAfter && sustainedCheck.durationMin < 5) {
      return {
        ...result,
        isAnomaly: true,
        anomalyType: 'no_stationary_period',
        confidence: 65,
        reason: `Vehicle started moving shortly after refuel - insufficient stationary time for fueling`,
      };
    }

    // All checks passed - this is a legitimate refuel
    result.confidence = Math.min(95, 70 + sustainedCheck.durationMin);

    this.logger.debug(
      `[AnomalyMiddleware] ✅ Verified refuel at ${riseAt.toISOString()}: ` +
        `+${added.toFixed(1)}L sustained for ${sustainedCheck.durationMin}min`,
    );

    return result;
  }

  /**
   * Analyze vehicle movement pattern around refuel time
   */
  private analyzeMovementPattern(
    riseAt: Date,
    readings: FuelReading[],
  ): {
    hadMovementDuring: boolean;
    hadMovementAfter: boolean;
    maxSpeedDuring: number;
    maxSpeedAfter: number;
  } {
    const windowMs = this.SPIKE_WINDOW_MINUTES * 60 * 1000;
    const windowStart = new Date(riseAt.getTime() - windowMs);
    const windowEnd = new Date(riseAt.getTime() + windowMs);

    const windowReadings = readings.filter(
      (r) => r.ts >= windowStart && r.ts <= windowEnd,
    );

    if (windowReadings.length === 0) {
      return {
        hadMovementDuring: false,
        hadMovementAfter: false,
        maxSpeedDuring: 0,
        maxSpeedAfter: 0,
      };
    }

    const beforeRise = windowReadings.filter((r) => r.ts <= riseAt);
    const afterRise = windowReadings.filter((r) => r.ts > riseAt);

    const speedsBefore = beforeRise.map((r) => r.speed ?? 0);
    const maxSpeedDuring = Math.max(...speedsBefore, 0);
    const maxSpeedAfter = Math.max(...afterRise.map((r) => r.speed ?? 0), 0);

    // The vehicle must have STOPPED for the rise to be a station refuel, so
    // judge on the slowest sample in the run-up, not the fastest. Using the
    // max vetoed every genuine mid-trip fill: the drive to the pump is almost
    // always inside the 7-minute look-back.
    const hadMovementDuring =
      speedsBefore.length > 0 &&
      Math.min(...speedsBefore) > this.RISE_GATING_MAX_SPEED_KMH;

    return {
      hadMovementDuring,
      hadMovementAfter: maxSpeedAfter > this.RISE_GATING_MAX_SPEED_KMH,
      maxSpeedDuring,
      maxSpeedAfter,
    };
  }

  /**
   * Check if fuel stayed at high level for minimum duration
   */
  private checkFuelSustained(
    peakAt: Date,
    fuelBefore: number,
    peakFuel: number,
    readings: FuelReading[],
    added: number,
  ): { sustained: boolean; durationMin: number } {
    const windowMs = this.SUSTAINED_MIN_MINUTES * 60 * 1000;
    const windowEnd = new Date(peakAt.getTime() + windowMs);

    const postRiseReadings = readings.filter(
      (r) => r.ts > peakAt && r.ts <= windowEnd,
    );

    if (postRiseReadings.length === 0) {
      return { sustained: false, durationMin: 0 };
    }

    // A reading counts as sustained when it is either still within epsilon of
    // the peak or still holding most of the fuel that was added.
    //
    // Proximity to the peak alone is not enough: `peakFuel` can be a
    // slosh-inflated overshoot, and the vehicle usually drives off within this
    // window, so a genuine refuel settles several litres below peak while
    // keeping nearly all of the fuel. Same retention rule as
    // isPostRefuelFallback in fuel-drop-filter.util.ts.
    const eps = this.epsFor(added, this.SUSTAINED_EPSILON_LITERS);
    const retentionFloor = fuelBefore + added * this.RETENTION_FRACTION;
    const withinTolerance = postRiseReadings.filter(
      (r) => r.fuel >= peakFuel - eps || r.fuel >= retentionFloor,
    );

    const sustainedRatio = withinTolerance.length / postRiseReadings.length;
    const lastReading = postRiseReadings[postRiseReadings.length - 1];
    const actualDuration =
      (lastReading.ts.getTime() - peakAt.getTime()) / (60 * 1000);

    return {
      sustained: sustainedRatio > 0.7 && actualDuration >= 10, // At least 10 min
      durationMin: Math.round(actualDuration),
    };
  }

  /**
   * Check if fuel fell back after the rise
   * IMPROVED: Check multiple windows to catch quick fallback patterns
   */
  private checkPostRefuelFallback(
    peakAt: Date,
    fuelBefore: number,
    peakFuel: number,
    readings: FuelReading[],
    added: number,
  ): {
    didFallback: boolean;
    finalFuel: number;
    fallbackAmount: number;
    windowChecked: string;
  } {
    const eps = this.epsFor(added, this.FALLBACK_EPSILON_LITERS);
    // Fell back only if it dropped more than eps below peak AND gave up most
    // of the fuel that was added — a real refuel can settle well below a
    // slosh-inflated peak while keeping nearly all of it.
    const retentionFloor = fuelBefore + added * this.RETENTION_FRACTION;
    const fellBack = (fuel: number): boolean =>
      peakFuel - fuel > eps && fuel < retentionFloor;
    // Check 1: Immediate fallback (within 2-7 minutes) - for quick spikes
    const immediateWindowMs = 2 * 60 * 1000; // Start after 2 min
    const immediateEndMs = 7 * 60 * 1000; // End at 7 min
    const immediateReadings = readings.filter(
      (r) =>
        r.ts > new Date(peakAt.getTime() + immediateWindowMs) &&
        r.ts <= new Date(peakAt.getTime() + immediateEndMs),
    );

    if (immediateReadings.length > 0) {
      const minFuelInWindow = Math.min(...immediateReadings.map((r) => r.fuel));
      const immediateFallback = peakFuel - minFuelInWindow;

      if (fellBack(minFuelInWindow)) {
        this.logger.debug(
          `[AnomalyMiddleware] ⚠️ Immediate fallback detected: ${immediateFallback.toFixed(1)}L drop within 2-7 min`,
        );
        return {
          didFallback: true,
          finalFuel: minFuelInWindow,
          fallbackAmount: immediateFallback,
          windowChecked: 'immediate (2-7min)',
        };
      }
    }

    // Check 2: Standard window (7-14 minutes) - original check
    const windowMs = this.POST_VERIFY_MINUTES * 60 * 1000;
    const postStart = new Date(peakAt.getTime() + windowMs);
    const postEnd = new Date(peakAt.getTime() + 2 * windowMs);

    const postReadings = readings.filter(
      (r) => r.ts > postStart && r.ts <= postEnd,
    );

    if (postReadings.length === 0) {
      // No readings in standard window, check any reading after 7 min
      const anyAfter = readings.filter((r) => r.ts > postStart);
      if (anyAfter.length > 0) {
        const finalFuel = anyAfter[anyAfter.length - 1].fuel;
        const fallbackAmount = peakFuel - finalFuel;
        return {
          didFallback: fellBack(finalFuel),
          finalFuel,
          fallbackAmount,
          windowChecked: 'any-after-7min',
        };
      }
      return {
        didFallback: false,
        finalFuel: peakFuel,
        fallbackAmount: 0,
        windowChecked: 'no-readings',
      };
    }

    const finalFuel = postReadings[postReadings.length - 1].fuel;
    const fallbackAmount = peakFuel - finalFuel;

    return {
      didFallback: fellBack(finalFuel),
      finalFuel,
      fallbackAmount,
      windowChecked: 'standard (7-14min)',
    };
  }

  /**
   * Check for recovery rise pattern (dip then recover to previous level)
   */
  private isRecoveryRise(
    riseAt: Date,
    baselineFuel: number,
    peakFuel: number,
    readings: FuelReading[],
    added: number,
  ): boolean {
    const lookbackMs = this.SPIKE_WINDOW_MINUTES * 60 * 1000;
    const lookStart = new Date(riseAt.getTime() - lookbackMs);

    const preReadings = readings
      .filter((r) => r.ts >= lookStart && r.ts < riseAt)
      .map((r) => r.fuel);

    if (preReadings.length === 0) return false;

    const preMax = Math.max(...preReadings);
    const preMin = Math.min(...preReadings);

    // Was fuel already near peak level before the "rise"?
    const wasAlreadyHigh = preMax >= peakFuel - 2.0;
    const hadDip = preMin <= baselineFuel + 2.0;
    // The pre-event swing has to be significant relative to the rise it would
    // explain — a fixed 8 L bar can never flag a 3 L dip-and-recover.
    const hadVariation =
      preMax - preMin >= this.epsFor(added, this.RISE_THRESHOLD);

    return wasAlreadyHigh && hadDip && hadVariation;
  }

  /**
   * Check for quick spike pattern - fuel rises then falls within minutes
   * This catches fake 30-40L spikes that are sensor glitches
   */
  private checkQuickSpike(
    peakAt: Date,
    fuelBefore: number,
    peakFuel: number,
    readings: FuelReading[],
    added: number,
  ): { isQuickSpike: boolean; fallbackAmount: number; minutes: number } {
    // Look at readings from 1 minute after the peak up to 5 minutes
    const startMs = 1 * 60 * 1000; // 1 minute after
    const endMs = 5 * 60 * 1000; // 5 minutes after

    const windowReadings = readings.filter(
      (r) =>
        r.ts > new Date(peakAt.getTime() + startMs) &&
        r.ts <= new Date(peakAt.getTime() + endMs),
    );

    if (windowReadings.length === 0) {
      return { isQuickSpike: false, fallbackAmount: 0, minutes: 0 };
    }

    // Find minimum fuel in this window
    const minFuel = Math.min(...windowReadings.map((r) => r.fuel));
    const fallbackAmount = peakFuel - minFuel;

    // Find when the minimum occurred
    const minReading = windowReadings.find((r) => r.fuel === minFuel);
    const minutes = minReading
      ? (minReading.ts.getTime() - peakAt.getTime()) / (60 * 1000)
      : 0;

    // A quick spike is a rise that GIVES THE FUEL BACK within minutes, so the
    // dip has to be both large and deep enough to break the retention floor.
    // Size alone is not enough: the vehicle is usually pulling away by now and
    // slosh on a full tank swings the reading 15-25 L while the fuel is all
    // still there. Same retention rule as the other two post-fill checks.
    const QUICK_SPIKE_THRESHOLD = 10.0;
    const retentionFloor = fuelBefore + added * this.RETENTION_FRACTION;
    const isQuickSpike =
      fallbackAmount > QUICK_SPIKE_THRESHOLD && minFuel < retentionFloor;

    if (isQuickSpike) {
      this.logger.debug(
        `[AnomalyMiddleware] Quick spike check: dropped ${fallbackAmount.toFixed(1)}L ` +
          `to ${minFuel.toFixed(1)}L within ${minutes.toFixed(1)} min ` +
          `(threshold: ${QUICK_SPIKE_THRESHOLD}L, retention floor: ${retentionFloor.toFixed(1)}L)`,
      );
    }

    return { isQuickSpike, fallbackAmount, minutes };
  }

  /**
   * Extract fuel readings from response body
   */
  private extractReadings(body: any): FuelReading[] {
    // Try to get from buckets if available
    if (body.buckets) {
      return this.bucketsToReadings(body.buckets);
    }

    // Try to get from data.buckets
    if (body.data?.buckets) {
      return this.bucketsToReadings(body.data.buckets);
    }

    // Try to reconstruct from readings if present (direct or wrapped in data)
    const readingsSource = body.readings || body.data?.readings;
    if (readingsSource && Array.isArray(readingsSource)) {
      return readingsSource.map((r: any) => ({
        ts: new Date(r.ts || r.timestamp || r.dt_tracker),
        fuel: r.fuel,
        speed: r.speed ?? 0,
        ignitionOn: r.ignitionOn,
      }));
    }

    // Return empty if no readings found
    return [];
  }

  /**
   * Convert fuel buckets to readings format
   */
  private bucketsToReadings(buckets: any[]): FuelReading[] {
    const readings: FuelReading[] = [];

    for (const bucket of buckets) {
      if (bucket.readings) {
        for (const r of bucket.readings) {
          readings.push({
            ts: new Date(r.timestamp || r.dt_tracker),
            fuel: r.fuel,
            speed: r.speed ?? 0,
            ignitionOn: r.ignitionOn,
          });
        }
      }
    }

    return readings.sort((a, b) => a.ts.getTime() - b.ts.getTime());
  }

  /**
   * Categorize anomalies by type for summary
   */
  private categorizeAnomalies(refuels: any[]): Record<string, number> {
    const byType: Record<string, number> = {};

    for (const refuel of refuels) {
      const type = refuel._anomaly?.anomalyType || 'none';
      byType[type] = (byType[type] || 0) + 1;
    }

    return byType;
  }

  /**
   * Log detected anomalies for monitoring
   */
  private logAnomalies(imei: string, refuels: any[]): void {
    const anomalies = refuels.filter((r) => r._anomaly?.isAnomaly);

    if (anomalies.length > 0) {
      this.logger.warn(
        `[AnomalyMiddleware] 🚨 Detected ${anomalies.length} anomalous refuel(s) for IMEI ${imei}:`,
      );

      for (const anomaly of anomalies) {
        this.logger.warn(
          `  - ${anomaly._anomaly.anomalyType}: ${anomaly._anomaly.reason} ` +
            `(confidence: ${anomaly._anomaly.confidence}%)`,
        );
      }
    }
  }
}
