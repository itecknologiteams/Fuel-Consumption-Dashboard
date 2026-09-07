import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { FuelSensor } from './fuel-sensor-resolver.service';
import { FuelTransformService } from './fuel-transform.service';
import { DynamicTableQueryService } from './dynamic-table-query.service';

export type FuelInterval = '1min' | '5min' | '15min' | 'hour' | 'day';

export interface FuelHistoryPoint {
  dt: string;
  fuel: number | null;
  unit: string;
  /**
   * Vehicle speed (km/h) at the reading this bucket was taken from. Carried
   * through so client-side detection can tell a parked bucket from a moving
   * one and apply the same stationary/moving event thresholds the backend does
   * (STATIONARY_EVENT_THRESHOLD vs DROP_ALERT_THRESHOLD).
   */
  speed?: number;
}

export interface FuelHistoryResult {
  imei: string;
  from: string;
  to: string;
  interval: FuelInterval;
  unit: string;
  samples: number;
  buckets: FuelHistoryPoint[];
}

const INTERVAL_MINUTES: Record<FuelInterval, number> = {
  '1min': 1,
  '5min': 5,
  '15min': 15,
  hour: 60,
  day: 1440,
};

const INTERVAL_SECONDS: Record<FuelInterval, number> = {
  '1min': 60,
  '5min': 300,
  '15min': 900,
  hour: 3600,
  day: 86400,
};

const MAX_RANGE_DAYS: Record<FuelInterval, number> = {
  '1min': 3,
  '5min': 31,
  '15min': 31,
  hour: 365,
  day: 365,
};

@Injectable()
export class FuelHistoryService {
  private readonly logger = new Logger(FuelHistoryService.name);

  constructor(
    private readonly transform: FuelTransformService,
    private readonly dynQuery: DynamicTableQueryService,
  ) {}

  resolveInterval(
    from: Date,
    to: Date,
    requested?: FuelInterval,
  ): FuelInterval {
    const rangeDays = (to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24);

    if (requested) {
      const maxDays = MAX_RANGE_DAYS[requested];
      if (rangeDays > maxDays) {
        throw new BadRequestException(
          `Interval '${requested}' supports max ${maxDays} days range. Requested range is ${Math.ceil(rangeDays)} days.`,
        );
      }
      return requested;
    }

    // Auto-select interval based on range
    if (rangeDays > 30) return 'day';
    if (rangeDays > 7) return 'hour';
    if (rangeDays > 3) return '15min';
    return '1min';
  }

  async getHistory(
    imei: string,
    from: Date,
    to: Date,
    sensor: FuelSensor,
    requestedInterval?: FuelInterval,
    tz?: string,
  ): Promise<FuelHistoryResult> {
    const interval = this.resolveInterval(from, to, requestedInterval);
    const bucketSeconds = INTERVAL_SECONDS[interval];

    // Use DB-level bucketing: MySQL groups rows by time bucket and returns
    // the LAST record per bucket — no MAX_ROWS cap, any range works correctly.
    const bucketedRows = await this.dynQuery.getRowsInRangeBucketed(
      imei,
      from,
      to,
      bucketSeconds,
    );

    this.logger.log(
      `History for IMEI ${imei}: ${bucketedRows.length} buckets, interval=${interval} (${bucketSeconds}s)`,
    );

    const buckets: FuelHistoryPoint[] = [];

    for (const row of bucketedRows) {
      const ts = new Date(row.bucket_ts);

      const rawValue = this.transform.extractRawValue(
        row.params,
        sensor.param,
        imei,
        new Date(row.dt_tracker).toISOString(),
      );

      if (rawValue === null) continue;

      const { value } = this.transform.transform(rawValue, sensor);
      const dtStr = this.formatTimestamp(ts, tz);

      buckets.push({
        dt: dtStr,
        fuel: value,
        unit: sensor.units || 'L',
        speed: row.speed,
      });
    }

    return {
      imei,
      from: from.toISOString(),
      to: to.toISOString(),
      interval,
      unit: sensor.units || 'L',
      samples: bucketedRows.length,
      buckets,
    };
  }

  private formatTimestamp(date: Date, tz?: string): string {
    if (!tz) return date.toISOString();

    try {
      const localStr = date
        .toLocaleString('sv-SE', { timeZone: tz })
        .replace(' ', 'T');

      const localAsIfUtc = new Date(localStr + 'Z');
      const offsetMs = localAsIfUtc.getTime() - date.getTime();
      const offsetTotalMins = Math.round(offsetMs / 60000);
      const sign = offsetTotalMins >= 0 ? '+' : '-';
      const absMin = Math.abs(offsetTotalMins);
      const hh = String(Math.floor(absMin / 60)).padStart(2, '0');
      const mm = String(absMin % 60).padStart(2, '0');

      return `${localStr}${sign}${hh}:${mm}`;
    } catch {
      this.logger.warn(`Invalid timezone '${tz}', falling back to UTC`);
      return date.toISOString();
    }
  }
}
