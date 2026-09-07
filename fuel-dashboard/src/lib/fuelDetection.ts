/**
 * Fuel Detection Engine - TypeScript Implementation
 * Mirrors the Python logic from aysis-latest.py
 *
 * Key Features:
 * - Median filtering for noise suppression
 * - Drop/Rise detection with thresholds
 * - Fake spike detection (drop then recover patterns)
 * - Speed gating (only alert when vehicle stationary)
 * - Verification delays (confirm drops after waiting)
 * - Post-verification recovery checks
 */

import { FuelBucket, FuelDropDetail, FuelRefuelDetail } from "./types";

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS - Matching Python thresholds exactly
// ═══════════════════════════════════════════════════════════════════════════════

/** Minimum fuel drop to trigger alert (liters) */
export const DROP_THRESHOLD = 8.0;

/** Minimum fuel rise to trigger alert (liters) */
export const RISE_THRESHOLD = 8.0;

/**
 * Minimum fuel drop/rise to trigger an alert while the vehicle is STATIONARY
 * (liters). Parked, the sensor is steady to a few tenths of a litre, so 3 L is
 * already a real event — a small siphon or a small top-up. Moving, fuel slosh
 * swings the same sensor by 10-15 L between readings, which is why
 * DROP_THRESHOLD / RISE_THRESHOLD (8 L) still apply in motion.
 *
 * Mirrors STATIONARY_EVENT_THRESHOLD in the backend's fuel-drop-filter.util.ts.
 */
export const STATIONARY_EVENT_THRESHOLD = 3.0;

/**
 * Speed (km/h) at or below which the vehicle counts as stationary for
 * STATIONARY_EVENT_THRESHOLD. Deliberately well below the 10 km/h gating
 * speeds: those mean "not driving", this means "standing still".
 */
export const STATIONARY_MAX_SPEED_KMH = 5.0;

/**
 * Minimum litres for a drop/rise to count: 3 L standing still, the moving
 * threshold otherwise.
 */
export function minEventLiters(
  stationary: boolean,
  movingThreshold: number
): number {
  return stationary ? STATIONARY_EVENT_THRESHOLD : movingThreshold;
}

/** Low fuel warning threshold (liters) */
export const LOW_FUEL_THRESHOLD = 50.0;

/** Max speed for drop alerts when ignition on (km/h) */
export const DROP_GATING_MAX_SPEED_KMH = 10.0;

/** Max speed for rise alerts (km/h) */
export const RISE_GATING_MAX_SPEED_KMH = 10.0;

/** Idle speed threshold (km/h) */
export const IDLE_SPEED_KMH = 10.0;

/** Time to wait before confirming suspected drop (seconds) */
export const VERIFY_DELAY_SECONDS = 80;

/** Window to detect "drop then recover" patterns (minutes) */
export const SPIKE_WINDOW_MINUTES = 7;

/** Post-drop verification wait time (seconds) - checks if fuel recovers */
export const POST_DROP_VERIFY_SECONDS = 420; // 7 minutes

/** Tolerance for post-drop recovery detection (liters) */
export const POST_DROP_VERIFY_EPS_LITERS = 1.5;

/** Median filter sample count */
export const FUEL_MEDIAN_SAMPLES = 5;

/** Max age of samples in median filter (seconds) */
export const FUEL_MEDIAN_MAX_AGE_SECONDS = 900; // 15 minutes

/** Max drop between readings before treating as sensor noise (liters) */
export const MILEAGE_MAX_LITER_DROP_PER_READING = 2.0;

/** Deduplication window for alerts (seconds) */
export const ALERT_DEDUPE_SECONDS = 300; // 5 minutes

/** Fuel difference threshold for duplicate detection (liters) */
export const ALERT_DEDUPE_FUEL_EPS = 0.5;

/** Max time to hold baseline for cumulative drop detection (seconds) */
export const BASELINE_HOLD_SECONDS = 600; // 10 minutes

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface FuelReading {
  timestamp: Date;
  fuel: number;
  speed: number;
  ignitionOn?: boolean;
  movementBit?: number;
  lat?: number;
  lng?: number;
}

export interface DropDetectionResult {
  isDrop: boolean;
  dropAmount: number;
  fuelBefore: number;
  fuelAfter: number;
  isFakeSpike: boolean;
  isConfirmed: boolean;
  reason: string;
  severity: "low" | "medium" | "high" | "critical";
}

export interface RiseDetectionResult {
  isRise: boolean;
  riseAmount: number;
  fuelBefore: number;
  fuelAfter: number;
  isFakeSpike: boolean;
  isConfirmed: boolean;
  reason: string;
}

export interface DetectionAlert {
  id: string;
  type: "drop" | "rise" | "low_fuel";
  imei: string;
  param?: string;
  fuelBefore: number;
  fuelAfter: number;
  amount: number;
  timestamp: Date;
  location?: { lat: number; lng: number };
  speed: number;
  ignitionOn: boolean;
  severity: "low" | "medium" | "high" | "critical";
  reason: string;
  isConfirmed: boolean;
  verifiedAt?: Date;
}

export interface FuelHistory {
  imei: string;
  param: string;
  samples: FuelReading[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// MEDIAN FILTER - Mirrors _filter_fuel_for_alarms()
// ═══════════════════════════════════════════════════════════════════════════════

class MedianFilter {
  private samples: { timestamp: Date; value: number }[] = [];
  private readonly maxSamples: number;
  private readonly maxAgeMs: number;

  constructor(maxSamples = FUEL_MEDIAN_SAMPLES, maxAgeSeconds = FUEL_MEDIAN_MAX_AGE_SECONDS) {
    this.maxSamples = Math.max(1, maxSamples);
    this.maxAgeMs = maxAgeSeconds * 1000;
  }

  addSample(timestamp: Date, value: number): number {
    // Add new sample
    this.samples.push({ timestamp, value });

    // Remove stale samples
    const cutoff = new Date(timestamp.getTime() - this.maxAgeMs);
    this.samples = this.samples.filter((s) => s.timestamp >= cutoff);

    // Keep only last N samples
    if (this.samples.length > this.maxSamples) {
      this.samples = this.samples.slice(-this.maxSamples);
    }

    // Return median if enough samples, otherwise raw value
    if (this.samples.length < Math.min(2, this.maxSamples)) {
      return value;
    }

    return this.calculateMedian();
  }

  private calculateMedian(): number {
    const values = this.samples.map((s) => s.value).sort((a, b) => a - b);
    const mid = Math.floor(values.length / 2);

    if (values.length % 2 === 0) {
      return (values[mid - 1] + values[mid]) / 2;
    }
    return values[mid];
  }

  getFilteredValue(): number | null {
    if (this.samples.length === 0) return null;
    return this.calculateMedian();
  }

  clear(): void {
    this.samples = [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// FUEL DETECTOR CLASS - Main detection engine
// ═══════════════════════════════════════════════════════════════════════════════

export class FuelDetector {
  private imei: string;
  private param: string;
  private medianFilter: MedianFilter;
  private history: FuelReading[] = [];
  private lastAlert: DetectionAlert | null = null;
  private lastFuelValue: number | null = null;
  private lastReadingTime: Date | null = null;
  private baselineFuel: number | null = null;
  private baselineTime: Date | null = null;

  // Processing flags to prevent duplicate threads
  private isProcessingDrop = false;
  private isProcessingRise = false;

  constructor(imei: string, param: string) {
    this.imei = imei;
    this.param = param;
    this.medianFilter = new MedianFilter();
  }

  /**
   * Process a new fuel reading through the detection pipeline
   * Mirrors: monitor_fuel_drop() in Python
   */
  processReading(reading: FuelReading): {
    dropResult: DropDetectionResult | null;
    riseResult: RiseDetectionResult | null;
    alert: DetectionAlert | null;
  } {
    const rawFuel = reading.fuel;
    const filteredFuel = this.medianFilter.addSample(reading.timestamp, rawFuel);

    // Store history
    this.history.push({ ...reading, fuel: filteredFuel });
    this.cleanupHistory();

    // Update baseline logic (hold for cumulative drops)
    this.updateBaseline(filteredFuel, reading.timestamp);

    let dropResult: DropDetectionResult | null = null;
    let riseResult: RiseDetectionResult | null = null;
    let alert: DetectionAlert | null = null;

    // Check for drops (need previous value)
    if (this.lastFuelValue !== null && this.lastReadingTime !== null) {
      const timeDiff = reading.timestamp.getTime() - this.lastReadingTime.getTime();
      const timeDiffMinutes = timeDiff / (1000 * 60);

      // Only process if within 35 minutes (matching Python)
      if (timeDiffMinutes <= 35) {
        const drop = this.lastFuelValue - filteredFuel;
        const rise = filteredFuel - this.lastFuelValue;

        // A parked vehicle's sensor is steady, so 3 L is already a real event;
        // in motion, slosh needs the full 8 L. Both this reading and the one
        // before it must be at rest — fuel keeps settling for a while after a
        // stop, and that settling must not manufacture events.
        const stationary =
          reading.speed <= STATIONARY_MAX_SPEED_KMH &&
          (this.history[this.history.length - 2]?.speed ??
            reading.speed) <= STATIONARY_MAX_SPEED_KMH;

        // Check for drop
        if (drop >= minEventLiters(stationary, DROP_THRESHOLD)) {
          dropResult = this.checkDrop(
            this.lastFuelValue,
            filteredFuel,
            reading,
            this.baselineFuel ?? this.lastFuelValue
          );

          if (dropResult.isDrop && !dropResult.isFakeSpike && !this.isProcessingDrop) {
            this.isProcessingDrop = true;
            alert = this.createDropAlert(dropResult, reading);
          }
        }

        // Check for rise
        if (rise >= minEventLiters(stationary, RISE_THRESHOLD)) {
          riseResult = this.checkRise(this.lastFuelValue, filteredFuel, reading);

          if (riseResult.isRise && !riseResult.isFakeSpike && !this.isProcessingRise) {
            this.isProcessingRise = true;
            // Only create alert if not already tracking a refuel
            if (!alert) {
              alert = this.createRiseAlert(riseResult, reading);
            }
          }
        }
      }
    }

    // Update last values
    this.lastFuelValue = filteredFuel;
    this.lastReadingTime = reading.timestamp;

    return { dropResult, riseResult, alert };
  }

  /**
   * Check if a drop is valid or a fake spike
   * Mirrors: is_fake_spike() in Python
   */
  private checkDrop(
    fuelBefore: number,
    fuelAfter: number,
    reading: FuelReading,
    baselineFuel: number
  ): DropDetectionResult {
    const dropAmount = fuelBefore - fuelAfter;

    // Check speed gating (drop only when stationary)
    const isAllowed = this.isAllowedForDropAlarm(reading);
    if (!isAllowed) {
      return {
        isDrop: true,
        dropAmount,
        fuelBefore,
        fuelAfter,
        isFakeSpike: true,
        isConfirmed: false,
        reason: `Drop ignored: vehicle moving at ${reading.speed.toFixed(1)} km/h (max ${DROP_GATING_MAX_SPEED_KMH})`,
        severity: "low",
      };
    }

    // Check for fake spike (drop then recover)
    const isFakeSpike = this.isFakeSpikePattern(reading.timestamp, fuelBefore, fuelAfter);

    if (isFakeSpike) {
      return {
        isDrop: true,
        dropAmount,
        fuelBefore,
        fuelAfter,
        isFakeSpike: true,
        isConfirmed: false,
        reason: "Fuel dropped but recovered within spike window - likely sensor noise",
        severity: "low",
      };
    }

    // Determine severity based on drop amount
    let severity: "low" | "medium" | "high" | "critical" = "medium";
    if (dropAmount >= 30) severity = "critical";
    else if (dropAmount >= 20) severity = "high";
    else if (dropAmount >= 10) severity = "medium";
    else severity = "low";

    return {
      isDrop: true,
      dropAmount,
      fuelBefore,
      fuelAfter,
      isFakeSpike: false,
      isConfirmed: true,
      reason: `Confirmed fuel drop of ${dropAmount.toFixed(2)}L while vehicle stationary`,
      severity,
    };
  }

  /**
   * Check for fake spike pattern (drop then recover)
   * Mirrors: is_fake_spike() lines 2075-2154 in Python
   */
  private isFakeSpikePattern(dropTime: Date, startFuel: number, _endFuel: number): boolean {
    const windowStart = new Date(dropTime.getTime() - SPIKE_WINDOW_MINUTES * 60 * 1000);
    const windowEnd = new Date(dropTime.getTime() + SPIKE_WINDOW_MINUTES * 60 * 1000);

    // Get readings in window
    const readings = this.history.filter(
      (r) => r.timestamp >= windowStart && r.timestamp <= windowEnd
    );

    if (readings.length < 2) return false;

    const firstFuel = readings[0].fuel;
    const lastFuel = readings[readings.length - 1].fuel;

    // If fuel recovered to original or higher, it's a spike
    if (lastFuel >= firstFuel) {
      return true;
    }

    // If fuel nearly recovered (within DROP_THRESHOLD), it's a spike
    if (Math.abs(lastFuel - firstFuel) <= DROP_THRESHOLD) {
      return true;
    }

    // Check if any single drop exceeds threshold and then recovers
    for (let i = 0; i < readings.length - 1; i++) {
      const f1 = readings[i].fuel;
      const f2 = readings[i + 1].fuel;
      const delta = f1 - f2;

      if (delta >= DROP_THRESHOLD) {
        // Check if fuel stayed low after this drop
        const remaining = readings.slice(i + 1);
        const stayedLow = remaining.every((r) => Math.abs(r.fuel - f1) > DROP_THRESHOLD);

        if (!stayedLow) {
          // Fuel returned near previous level - fake spike
          return true;
        }
      }
    }

    // No recovery pattern found - this is a real drop
    return false;
  }

  /**
   * Check if rise is valid
   * Mirrors: is_fake_rise() in Python
   */
  private checkRise(
    fuelBefore: number,
    fuelAfter: number,
    reading: FuelReading
  ): RiseDetectionResult {
    const riseAmount = fuelAfter - fuelBefore;

    // Check speed gating
    if (reading.speed > RISE_GATING_MAX_SPEED_KMH) {
      return {
        isRise: true,
        riseAmount,
        fuelBefore,
        fuelAfter,
        isFakeSpike: true,
        isConfirmed: false,
        reason: `Rise ignored: vehicle moving at ${reading.speed.toFixed(1)} km/h`,
      };
    }

    // Check for fake rise pattern
    const isFakeSpike = this.isFakeRisePattern(reading.timestamp, fuelBefore, fuelAfter);

    if (isFakeSpike) {
      return {
        isRise: true,
        riseAmount,
        fuelBefore,
        fuelAfter,
        isFakeSpike: true,
        isConfirmed: false,
        reason: "Fuel rose but fell back - likely sensor noise",
      };
    }

    return {
      isRise: true,
      riseAmount,
      fuelBefore,
      fuelAfter,
      isFakeSpike: false,
      isConfirmed: true,
      reason: `Confirmed fuel rise of ${riseAmount.toFixed(2)}L`,
    };
  }

  /**
   * Check for fake rise pattern (rise then fall)
   * Mirrors: is_fake_rise() in Python
   */
  private isFakeRisePattern(riseTime: Date, startFuel: number, _endFuel: number): boolean {
    const windowStart = new Date(riseTime.getTime() - SPIKE_WINDOW_MINUTES * 60 * 1000);
    const windowEnd = new Date(riseTime.getTime() + SPIKE_WINDOW_MINUTES * 60 * 1000);

    const readings = this.history.filter(
      (r) => r.timestamp >= windowStart && r.timestamp <= windowEnd
    );

    if (readings.length < 2) return false;

    const firstFuel = readings[0].fuel;
    const lastFuel = readings[readings.length - 1].fuel;

    // If fuel fell back to original or lower, it's a spike
    if (lastFuel <= firstFuel) {
      return true;
    }

    // If fuel nearly returned to original, it's a spike
    if (Math.abs(lastFuel - firstFuel) <= RISE_THRESHOLD) {
      return true;
    }

    return false;
  }

  /**
   * Check if drop alarm is allowed based on speed/ignition
   * Mirrors: _is_allowed_for_fuel_drop_alarm() in Python
   */
  private isAllowedForDropAlarm(reading: FuelReading): boolean {
    // If ignition is off (when implemented), always allow
    // If ignition on, only allow when speed <= threshold
    return reading.speed <= DROP_GATING_MAX_SPEED_KMH;
  }

  /**
   * Update baseline for cumulative drop detection
   * Mirrors: lines 2882-2895 in Python
   */
  private updateBaseline(fuelValue: number, timestamp: Date): void {
    if (this.baselineFuel === null || this.baselineTime === null) {
      this.baselineFuel = fuelValue;
      this.baselineTime = timestamp;
      return;
    }

    const ageMs = timestamp.getTime() - this.baselineTime.getTime();

    // If fuel dropped slightly within 10 minutes, hold old baseline
    // to detect cumulative drops
    if (
      this.lastFuelValue !== null &&
      fuelValue < this.lastFuelValue &&
      this.lastFuelValue - fuelValue < DROP_THRESHOLD &&
      ageMs <= BASELINE_HOLD_SECONDS * 1000
    ) {
      // Hold baseline - don't update
      return;
    }

    // Update baseline
    this.baselineFuel = fuelValue;
    this.baselineTime = timestamp;
  }

  /**
   * Create drop alert
   */
  private createDropAlert(result: DropDetectionResult, reading: FuelReading): DetectionAlert {
    return {
      id: `${this.imei}-${this.param}-${Date.now()}`,
      type: "drop",
      imei: this.imei,
      param: this.param,
      fuelBefore: result.fuelBefore,
      fuelAfter: result.fuelAfter,
      amount: result.dropAmount,
      timestamp: reading.timestamp,
      location: reading.lat && reading.lng ? { lat: reading.lat, lng: reading.lng } : undefined,
      speed: reading.speed,
      ignitionOn: reading.ignitionOn ?? true,
      severity: result.severity,
      reason: result.reason,
      isConfirmed: false, // Will be confirmed after verification delay
    };
  }

  /**
   * Create rise alert
   */
  private createRiseAlert(result: RiseDetectionResult, reading: FuelReading): DetectionAlert {
    return {
      id: `${this.imei}-${this.param}-${Date.now()}`,
      type: "rise",
      imei: this.imei,
      param: this.param,
      fuelBefore: result.fuelBefore,
      fuelAfter: result.fuelAfter,
      amount: result.riseAmount,
      timestamp: reading.timestamp,
      location: reading.lat && reading.lng ? { lat: reading.lat, lng: reading.lng } : undefined,
      speed: reading.speed,
      ignitionOn: reading.ignitionOn ?? true,
      severity: "low",
      reason: result.reason,
      isConfirmed: false,
    };
  }

  /**
   * Cleanup old history entries
   */
  private cleanupHistory(): void {
    const cutoff = new Date(Date.now() - SPIKE_WINDOW_MINUTES * 2 * 60 * 1000);
    this.history = this.history.filter((r) => r.timestamp >= cutoff);
  }

  /**
   * Verify a pending alert after delay
   * Mirrors: handle_fuel_drop() verification phase in Python
   */
  verifyAlert(alert: DetectionAlert, currentReading: FuelReading): DetectionAlert | null {
    // Check if this is a duplicate alert
    if (this.isDuplicateAlert(alert)) {
      return null;
    }

    // For drop alerts, check if fuel recovered (fake drop)
    if (alert.type === "drop") {
      const recoveryThreshold = alert.fuelBefore - POST_DROP_VERIFY_EPS_LITERS;

      if (currentReading.fuel >= recoveryThreshold) {
        // Fuel recovered - this was a fake drop
        return null;
      }
    }

    // Alert confirmed
    const confirmedAlert: DetectionAlert = {
      ...alert,
      isConfirmed: true,
      verifiedAt: new Date(),
    };

    this.lastAlert = confirmedAlert;
    this.isProcessingDrop = false;
    this.isProcessingRise = false;

    return confirmedAlert;
  }

  /**
   * Check if alert is a duplicate
   * Mirrors: duplicate alert check in Python
   */
  private isDuplicateAlert(alert: DetectionAlert): boolean {
    if (!this.lastAlert) return false;

    const timeDiff = Math.abs(
      alert.timestamp.getTime() - this.lastAlert.timestamp.getTime()
    );
    const fuelDiff = Math.abs(alert.fuelAfter - this.lastAlert.fuelAfter);

    // Duplicate if within 5 minutes AND fuel difference < 0.5L
    if (timeDiff < ALERT_DEDUPE_SECONDS * 1000 && fuelDiff < ALERT_DEDUPE_FUEL_EPS) {
      return true;
    }

    return false;
  }

  /**
   * Get current detection state
   */
  getState(): {
    lastFuel: number | null;
    lastReadingTime: Date | null;
    baselineFuel: number | null;
    historyCount: number;
    lastAlert: DetectionAlert | null;
  } {
    return {
      lastFuel: this.lastFuelValue,
      lastReadingTime: this.lastReadingTime,
      baselineFuel: this.baselineFuel,
      historyCount: this.history.length,
      lastAlert: this.lastAlert,
    };
  }

  /**
   * Reset detector state
   */
  reset(): void {
    this.medianFilter.clear();
    this.history = [];
    this.lastAlert = null;
    this.lastFuelValue = null;
    this.lastReadingTime = null;
    this.baselineFuel = null;
    this.baselineTime = null;
    this.isProcessingDrop = false;
    this.isProcessingRise = false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// FLEET DETECTION MANAGER - Manages detectors for multiple vehicles
// ═══════════════════════════════════════════════════════════════════════════════

export class FleetDetectionManager {
  private detectors: Map<string, FuelDetector> = new Map();

  private getKey(imei: string, param: string): string {
    return `${imei}-${param}`;
  }

  getDetector(imei: string, param: string): FuelDetector {
    const key = this.getKey(imei, param);

    if (!this.detectors.has(key)) {
      this.detectors.set(key, new FuelDetector(imei, param));
    }

    return this.detectors.get(key)!;
  }

  processReading(imei: string, param: string, reading: FuelReading): ReturnType<
    FuelDetector["processReading"]
  > {
    const detector = this.getDetector(imei, param);
    return detector.processReading(reading);
  }

  removeDetector(imei: string, param: string): void {
    const key = this.getKey(imei, param);
    this.detectors.delete(key);
  }

  getAllDetectors(): Map<string, FuelDetector> {
    return new Map(this.detectors);
  }

  clear(): void {
    this.detectors.clear();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS - For analyzing fuel history
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * True when both buckets were sampled with the vehicle standing still, so the
 * pair can be judged against STATIONARY_EVENT_THRESHOLD.
 *
 * Returns false when either bucket carries no speed (older API responses had
 * no `speed` field): with no evidence the vehicle had stopped, the stricter
 * moving threshold is the safe default.
 */
function bucketsStationary(prev: FuelBucket, curr: FuelBucket): boolean {
  if (prev.speed == null || curr.speed == null) return false;
  return (
    prev.speed <= STATIONARY_MAX_SPEED_KMH &&
    curr.speed <= STATIONARY_MAX_SPEED_KMH
  );
}

/**
 * Detect fuel drops from historical data
 * Mirrors the Python logic for batch analysis
 * 
 * IMPROVED: Now also detects cumulative drops across multiple consecutive buckets
 * to catch sudden drops that get averaged out in aggregation
 */
export function detectDropsFromHistory(
  buckets: FuelBucket[],
  _speedData?: { timestamp: Date; speed: number }[]
): FuelDropDetail[] {
  const drops: FuelDropDetail[] = [];

  if (buckets.length < 2) return drops;

  // PASS 1: Detect single-bucket drops
  for (let i = 1; i < buckets.length; i++) {
    const prev = buckets[i - 1];
    const curr = buckets[i];

    const fuelBefore = prev.fuel;
    const fuelAfter = curr.fuel;
    const consumed = fuelBefore - fuelAfter;

    // Skip if not a drop
    if (consumed <= 0) continue;

    // Check for sensor jump (>2L single reading)
    // NOTE: In aggregated data, this might not work well - rely on other checks
    const isSensorJump = consumed > MILEAGE_MAX_LITER_DROP_PER_READING * 3; // Relaxed for aggregated data

    // 3 L standing still, 8 L in motion — matches the backend.
    const dropThreshold = minEventLiters(
      bucketsStationary(prev, curr),
      DROP_THRESHOLD
    );
    const meetsThreshold = consumed >= dropThreshold;

    // Check if it's a confirmed drop (not a spike)
    let isConfirmedDrop = false;

    if (meetsThreshold && !isSensorJump) {
      // Look ahead to check for recovery (within ~20 minutes)
      const windowEnd = Math.min(i + 4, buckets.length);
      let recovered = false;

      for (let j = i + 1; j < windowEnd; j++) {
        // If fuel recovered close to the original level, it's a spike/fake
        if (buckets[j].fuel >= fuelBefore - dropThreshold) {
          recovered = true;
          break;
        }
      }

      isConfirmedDrop = !recovered;
    }

    drops.push({
      at: curr.dt,
      fuelBefore,
      fuelAfter,
      consumed,
      unit: curr.unit,
      isSensorJump,
      isConfirmedDrop,
    });
  }

  // PASS 2: Detect cumulative drops (step drops across multiple buckets)
  // This catches drops like 182 -> 176 -> 170 that get averaged out
  let i = 0;
  while (i < buckets.length - 1) {
    const startBucket = buckets[i];
    let cumulativeDrop = 0;
    let lowestFuel = startBucket.fuel;
    let lowestIndex = i;
    let j = i + 1;

    // Look for consecutive drops within a 30-minute window
    const windowEnd = Math.min(i + 6, buckets.length); // Up to 6 buckets (30 min for 5min intervals)
    
    while (j < windowEnd) {
      const drop = buckets[j - 1].fuel - buckets[j].fuel;
      
      // If it's a rise or flat, stop the cumulative tracking
      if (buckets[j].fuel > buckets[j - 1].fuel - 0.5) break;
      
      cumulativeDrop += Math.max(0, drop);
      
      if (buckets[j].fuel < lowestFuel) {
        lowestFuel = buckets[j].fuel;
        lowestIndex = j;
      }
      
      j++;
    }

    // Stationary only if the whole run was at rest — a cumulative drop that
    // spans a departure is driving consumption, not a siphon.
    const runStationary = buckets
      .slice(i, Math.max(i + 1, lowestIndex + 1))
      .every((b) => b.speed != null && b.speed <= STATIONARY_MAX_SPEED_KMH);
    const cumulativeThreshold = minEventLiters(runStationary, DROP_THRESHOLD);

    // If cumulative drop meets threshold and spans multiple buckets, add as a single drop
    if (cumulativeDrop >= cumulativeThreshold && lowestIndex > i + 1) {
      // Check if this cumulative drop is already captured
      const alreadyCaptured = drops.some(
        (d) => Math.abs(new Date(d.at).getTime() - new Date(buckets[lowestIndex].dt).getTime()) < 60000
      );

      if (!alreadyCaptured) {
        // Check for recovery
        const recoveryWindow = Math.min(lowestIndex + 4, buckets.length);
        let recovered = false;
        for (let k = lowestIndex + 1; k < recoveryWindow; k++) {
          if (buckets[k].fuel >= startBucket.fuel - cumulativeThreshold) {
            recovered = true;
            break;
          }
        }

        drops.push({
          at: buckets[lowestIndex].dt,
          fuelBefore: startBucket.fuel,
          fuelAfter: lowestFuel,
          consumed: cumulativeDrop,
          unit: startBucket.unit,
          isSensorJump: false,
          isConfirmedDrop: !recovered,
        });
      }
    }

    i = j > i + 1 ? j : i + 1;
  }

  // Sort by timestamp
  drops.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  // Remove duplicates (same timestamp)
  const uniqueDrops: FuelDropDetail[] = [];
  const seen = new Set<string>();
  for (const drop of drops) {
    const key = `${drop.at}-${drop.consumed.toFixed(1)}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueDrops.push(drop);
    }
  }

  return uniqueDrops;
}

/**
 * Detect fuel refuels from historical data
 */
export function detectRefuelsFromHistory(buckets: FuelBucket[]): FuelRefuelDetail[] {
  const refuels: FuelRefuelDetail[] = [];

  if (buckets.length < 2) return refuels;

  for (let i = 1; i < buckets.length; i++) {
    const prev = buckets[i - 1];
    const curr = buckets[i];

    const fuelBefore = prev.fuel;
    const fuelAfter = curr.fuel;
    const added = fuelAfter - fuelBefore;

    // Skip if not a rise
    if (added <= 0) continue;

    // Only include if meets threshold — 3 L standing still, 8 L in motion.
    if (added >= minEventLiters(bucketsStationary(prev, curr), RISE_THRESHOLD)) {
      refuels.push({
        at: curr.dt,
        fuelBefore,
        fuelAfter,
        added,
        unit: curr.unit,
      });
    }
  }

  return refuels;
}

/**
 * Calculate net fuel change (first - last)
 * This is the most reliable metric per Python comments
 */
export function calculateNetDrop(buckets: FuelBucket[]): number | null {
  if (buckets.length < 2) return null;

  const first = buckets[0].fuel;
  const last = buckets[buckets.length - 1].fuel;

  return first - last;
}

/**
 * Filter confirmed theft events from drops
 */
export function filterTheftEvents(
  drops: FuelDropDetail[],
  options: {
    minDropAmount?: number;
    requireStationary?: boolean;
  } = {}
): FuelDropDetail[] {
  const { minDropAmount = DROP_THRESHOLD, requireStationary = true } = options;

  return drops.filter((drop) => {
    // Must be confirmed (not a spike)
    if (!drop.isConfirmedDrop) return false;

    // Must meet minimum threshold
    if (drop.consumed < minDropAmount) return false;

    // Must not be a sensor jump
    if (drop.isSensorJump) return false;

    return true;
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SINGLETON INSTANCE - For app-wide detection
// ═══════════════════════════════════════════════════════════════════════════════

let globalFleetManager: FleetDetectionManager | null = null;

export function getGlobalFleetManager(): FleetDetectionManager {
  if (!globalFleetManager) {
    globalFleetManager = new FleetDetectionManager();
  }
  return globalFleetManager;
}

export function resetGlobalFleetManager(): void {
  globalFleetManager = null;
}
