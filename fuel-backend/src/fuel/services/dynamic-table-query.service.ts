import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  STATIONARY_MAX_SPEED_KMH,
  STATIONARY_SETTLE_MINUTES,
} from './fuel-drop-filter.util';

export interface DataRow {
  dt_tracker: Date;
  dt_server: Date;
  lat: number;
  lng: number;
  speed: number;
  params: string;
}

export interface BucketedRow {
  bucket_ts: Date;
  dt_tracker: Date;
  lat: number;
  lng: number;
  speed: number;
  params: string;
}

// Raised from 50,000 → 500,000 to handle high-frequency trackers (vehicles reporting
// every 30–60 s can generate ~3,900 rows/day; a 31-day month + 2h warmup needs ~121k rows).
// 500k safely covers ~128 days at 3,900 rows/day, or ~6 months of typical 5-min data.
const MAX_ROWS = 500000;

@Injectable()
export class DynamicTableQueryService {
  private readonly logger = new Logger(DynamicTableQueryService.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  getTableName(imei: string): string {
    const sanitized = imei.replace(/[^a-zA-Z0-9_]/g, '');
    return `gs_object_data_${sanitized}`;
  }

  async tableExists(imei: string): Promise<boolean> {
    const tableName = this.getTableName(imei);
    const rows: Array<{ cnt: number }> = await this.dataSource.query(
      `SELECT COUNT(*) AS cnt
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
      [tableName],
    );
    return rows[0]?.cnt > 0;
  }

  async assertTableExists(imei: string): Promise<void> {
    const exists = await this.tableExists(imei);
    if (!exists) {
      this.logger.warn(`Dynamic table not found for IMEI ${imei}`);
      throw new NotFoundException(
        `No tracking data table found for vehicle ${imei}`,
      );
    }
  }

  async getLatestRow(imei: string): Promise<DataRow | null> {
    await this.assertTableExists(imei);
    const tableName = this.getTableName(imei);

    const rows: DataRow[] = await this.dataSource.query(
      `SELECT dt_tracker, dt_server, lat, lng, speed, params
       FROM \`${tableName}\`
       ORDER BY dt_tracker DESC
       LIMIT 1`,
    );

    return rows[0] ?? null;
  }

  /**
   * The newest reading taken with the vehicle standing still — the last
   * trustworthy fuel level.
   *
   * A level read in motion is worth ±15 L of slosh, so "current fuel" has to
   * come from a reading at rest even when that means reaching back to before
   * the vehicle set off. At rest means under `maxSpeedKmh` with nothing moving
   * in the `settleSeconds` before it, because fuel keeps sloshing for a while
   * after a stop.
   *
   * Runs as a narrow scan of timestamps and speeds, then one fetch of the row
   * that wins. Expressing the settling rule as a correlated NOT EXISTS instead
   * measured 8-14 s per vehicle on a busy tracker — unusable in the dashboard's
   * per-vehicle loop, where this costs ~35 ms.
   *
   * Returns null when the vehicle has not stood still within the scanned
   * window; callers fall back to the reading as taken.
   */
  async getLatestStationaryRow(
    imei: string,
    maxSpeedKmh: number,
    settleSeconds: number,
    lookbackHours = 24,
    maxScanRows = 2000,
  ): Promise<DataRow | null> {
    await this.assertTableExists(imei);
    const tableName = this.getTableName(imei);
    const since = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);

    const recent: Array<{ dt_tracker: Date; speed: number }> =
      await this.dataSource.query(
        `SELECT dt_tracker, speed
         FROM \`${tableName}\`
         WHERE dt_tracker >= ?
         ORDER BY dt_tracker DESC
         LIMIT ?`,
        [since, maxScanRows],
      );

    if (!recent.length) return null;

    // Oldest → newest so the settling margin can be applied as we go.
    const settleMs = settleSeconds * 1000;
    let lastMovingMs: number | null = null;
    let settledAt: Date | null = null;

    for (let i = recent.length - 1; i >= 0; i--) {
      const ts = new Date(recent[i].dt_tracker);
      const tsMs = ts.getTime();

      if (recent[i].speed > maxSpeedKmh) {
        lastMovingMs = tsMs;
      } else if (lastMovingMs === null || lastMovingMs < tsMs - settleMs) {
        settledAt = ts;
      }
    }

    if (!settledAt) return null;

    const rows: DataRow[] = await this.dataSource.query(
      `SELECT dt_tracker, dt_server, lat, lng, speed, params
       FROM \`${tableName}\`
       WHERE dt_tracker = ?
       LIMIT 1`,
      [settledAt],
    );

    return rows[0] ?? null;
  }

  /**
   * The reading a fuel level should be quoted from.
   *
   * Prefers the newest reading taken at rest, because a level sampled in
   * motion is worth ±15 L of slosh. Falls back to the newest reading as taken
   * when the vehicle has not stood still recently — a rough level beats a
   * blank gauge.
   */
  async getLatestRestingRow(imei: string): Promise<DataRow | null> {
    const resting = await this.getLatestStationaryRow(
      imei,
      STATIONARY_MAX_SPEED_KMH,
      STATIONARY_SETTLE_MINUTES * 60,
    );
    if (resting) return resting;

    this.logger.debug(
      `IMEI ${imei}: no stationary reading in the recent window — quoting the fuel level as taken`,
    );
    return this.getLatestRow(imei);
  }

  /**
   * Range fetch, forcing the dt_tracker index. For wide ranges MySQL's
   * optimizer otherwise picks a full table scan + filesort (measured ~2x
   * slower than the index range scan). Falls back to an unhinted query if a
   * table somehow lacks that index, so this never breaks a query.
   */
  private async runRangeQuery(
    tableName: string,
    from: Date,
    to: Date,
  ): Promise<DataRow[]> {
    const cols = 'dt_tracker, dt_server, lat, lng, speed, params';
    const tail =
      'WHERE dt_tracker >= ? AND dt_tracker <= ? ORDER BY dt_tracker ASC LIMIT ?';
    try {
      return await this.dataSource.query(
        `SELECT ${cols} FROM \`${tableName}\` FORCE INDEX (dt_tracker) ${tail}`,
        [from, to, MAX_ROWS],
      );
    } catch {
      return await this.dataSource.query(
        `SELECT ${cols} FROM \`${tableName}\` ${tail}`,
        [from, to, MAX_ROWS],
      );
    }
  }

  async getRowsInRange(imei: string, from: Date, to: Date): Promise<DataRow[]> {
    await this.assertTableExists(imei);
    const tableName = this.getTableName(imei);

    const rows = await this.runRangeQuery(tableName, from, to);

    if (!rows.length) {
      throw new NotFoundException(
        `No data found for vehicle ${imei} in the requested date range`,
      );
    }

    if (rows.length === MAX_ROWS) {
      this.logger.warn(
        `IMEI ${imei}: getRowsInRange hit MAX_ROWS limit (${MAX_ROWS}). ` +
          `Data may be truncated — consider reducing the query range or increasing MAX_ROWS further.`,
      );
    }

    return rows;
  }

  async getRowsInRangeOrEmpty(
    imei: string,
    from: Date,
    to: Date,
  ): Promise<DataRow[]> {
    const exists = await this.tableExists(imei);
    if (!exists) {
      this.logger.warn(`Dynamic table not found for IMEI ${imei}`);
      return [];
    }

    const tableName = this.getTableName(imei);
    const rows = await this.runRangeQuery(tableName, from, to);

    if (rows.length === MAX_ROWS) {
      this.logger.warn(
        `IMEI ${imei}: getRowsInRangeOrEmpty hit MAX_ROWS limit (${MAX_ROWS}). ` +
          `Data may be truncated — consider reducing the query range or increasing MAX_ROWS further.`,
      );
    }

    return rows;
  }

  /**
   * Finds the GPS row closest to targetTs within ±windowMinutes.
   * Only fetches lat/lng/dt_tracker — no params — so it's very lightweight.
   * Returns null if no row exists within the window.
   */
  async getNearestGpsPoint(
    imei: string,
    targetTs: Date,
    windowMinutes = 10,
  ): Promise<{ lat: number; lng: number; dt_tracker: Date } | null> {
    const exists = await this.tableExists(imei);
    if (!exists) return null;

    const tableName = this.getTableName(imei);
    const windowMs = windowMinutes * 60 * 1000;
    const fromTs = new Date(targetTs.getTime() - windowMs);
    const toTs = new Date(targetTs.getTime() + windowMs);

    const rows: Array<{ lat: number; lng: number; dt_tracker: Date }> =
      await this.dataSource.query(
        `SELECT lat, lng, dt_tracker
         FROM \`${tableName}\`
         WHERE dt_tracker BETWEEN ? AND ?
         ORDER BY ABS(TIMESTAMPDIFF(SECOND, dt_tracker, ?))
         LIMIT 1`,
        [fromTs, toTs, targetTs],
      );

    return rows[0] ?? null;
  }

  /**
   * DB-level bucketing: returns the LAST row in each time bucket.
   * bucketSeconds: 300 (5min), 900 (15min), 3600 (1h), 86400 (1day)
   * This avoids pulling millions of raw rows for long date ranges.
   */
  async getRowsInRangeBucketed(
    imei: string,
    from: Date,
    to: Date,
    bucketSeconds: number,
  ): Promise<BucketedRow[]> {
    await this.assertTableExists(imei);
    const tableName = this.getTableName(imei);

    const rows: BucketedRow[] = await this.dataSource.query(
      `SELECT
         FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(t.dt_tracker) / ?) * ?) AS bucket_ts,
         t.dt_tracker,
         t.lat,
         t.lng,
         t.speed,
         t.params
       FROM \`${tableName}\` t
       INNER JOIN (
         SELECT MAX(dt_tracker) AS max_dt
         FROM \`${tableName}\`
         WHERE dt_tracker >= ? AND dt_tracker <= ?
         GROUP BY FLOOR(UNIX_TIMESTAMP(dt_tracker) / ?)
       ) sub ON t.dt_tracker = sub.max_dt
       WHERE t.dt_tracker >= ? AND t.dt_tracker <= ?
       ORDER BY t.dt_tracker ASC`,
      [bucketSeconds, bucketSeconds, from, to, bucketSeconds, from, to],
    );

    return rows;
  }

  /**
   * DB-level bucketing that returns empty array if no data (no exception thrown).
   */
  async getRowsInRangeBucketedOrEmpty(
    imei: string,
    from: Date,
    to: Date,
    bucketSeconds: number,
  ): Promise<BucketedRow[]> {
    const exists = await this.tableExists(imei);
    if (!exists) {
      this.logger.warn(`Dynamic table not found for IMEI ${imei}`);
      return [];
    }

    const tableName = this.getTableName(imei);

    const rows: BucketedRow[] = await this.dataSource.query(
      `SELECT
         FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(t.dt_tracker) / ?) * ?) AS bucket_ts,
         t.dt_tracker,
         t.lat,
         t.lng,
         t.speed,
         t.params
       FROM \`${tableName}\` t
       INNER JOIN (
         SELECT MAX(dt_tracker) AS max_dt
         FROM \`${tableName}\`
         WHERE dt_tracker >= ? AND dt_tracker <= ?
         GROUP BY FLOOR(UNIX_TIMESTAMP(dt_tracker) / ?)
       ) sub ON t.dt_tracker = sub.max_dt
       WHERE t.dt_tracker >= ? AND t.dt_tracker <= ?
       ORDER BY t.dt_tracker ASC`,
      [bucketSeconds, bucketSeconds, from, to, bucketSeconds, from, to],
    );

    return rows;
  }
}
