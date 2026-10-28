/**
 * Shared attribution of a period's fuel burn to driving conditions.
 *
 * Idle and high-speed drain used to be computed separately on every page by
 * summing each reading-to-reading fall. Sensor oscillation inflates that sum
 * several-fold (a vehicle that burned 0.8 L "idled away" 3.6 L), and dividing
 * it by the properly filtered total produced idle shares above 100 %.
 *
 * Now the raw falls are only used to apportion: each condition's share of the
 * raw falls is applied to the period's real consumption (periodConsumed), so
 * idle + moving always adds up to the same total every page shows.
 */

/** Falls smaller than this between consecutive readings are sensor noise. */
export const DRAIN_NOISE_THRESHOLD_L = 0.5;

export interface DrainSample {
  fuel: number | null;
  speed: number;
  ignition: boolean;
}

export interface DrainShares {
  /** Fraction (0–1) of the burn that happened idling: ignition on, under 2 km/h. */
  idle: number;
  /** Fraction (0–1) of the burn that happened above `highSpeedKmh`. */
  highSpeed: number;
  /** Number of falls recorded above `highSpeedKmh`. */
  highSpeedEvents: number;
}

export function drainShares(
  samples: DrainSample[],
  highSpeedKmh: number,
): DrainShares {
  let all = 0;
  let idle = 0;
  let highSpeed = 0;
  let highSpeedEvents = 0;
  let prev: DrainSample | null = null;

  for (const s of samples) {
    if (s.fuel === null) continue;
    if (prev !== null && prev.fuel !== null) {
      const fall = prev.fuel - s.fuel;
      if (fall > DRAIN_NOISE_THRESHOLD_L) {
        all += fall;
        if (prev.speed < 2 && prev.ignition) idle += fall;
        if (prev.speed > highSpeedKmh) {
          highSpeed += fall;
          highSpeedEvents++;
        }
      }
    }
    prev = s;
  }

  return {
    idle: all > 0 ? idle / all : 0,
    highSpeed: all > 0 ? highSpeed / all : 0,
    highSpeedEvents,
  };
}

/** Litres and percentage of `consumed` for a share. */
export function drainOf(
  consumed: number,
  share: number,
): { liters: number; percentage: number } {
  return {
    liters: Math.round(consumed * share * 100) / 100,
    percentage: consumed > 0 ? Math.round(share * 100 * 10) / 10 : 0,
  };
}

/** Ignition state from a tracker params blob (acc / io1). */
export function ignitionOn(paramsJson: string): boolean {
  try {
    const p = JSON.parse(paramsJson) as Record<string, string | number>;
    return (
      p['acc'] === '1' || p['acc'] === 1 || p['io1'] === '1' || p['io1'] === 1
    );
  } catch {
    return false;
  }
}
