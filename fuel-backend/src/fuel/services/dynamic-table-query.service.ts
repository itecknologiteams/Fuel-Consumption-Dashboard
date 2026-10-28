import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

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
   * The vehicle's live state exactly as the GPS server holds and displays it:
   * the gs_objects row, whose `params` carries the last known value of every
   * parameter (a packet that omits one doesn't blank it).
   *
   * "Current fuel" is quoted from here so the portal reads the same number as
   * the GPS server. It used to reach back to the last reading taken at rest
   * instead, which showed a pre-refill level on a stationary site whose GPS
   * speed jitters, and a blank gauge whenever that row lacked the fuel param.
   */
  async getLiveRow(imei: string): Promise<DataRow | null> {
    const rows: DataRow[] = await this.dataSource.query(
      `SELECT dt_tracker, dt_server, lat, lng, speed, params
       FROM gs_objects
       WHERE imei = ?
       LIMIT 1`,
      [imei],
    );
    return rows[0] ?? null;
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
