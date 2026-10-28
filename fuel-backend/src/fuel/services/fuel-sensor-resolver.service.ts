import {
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

export interface FuelSensor {
  sensorId: number;
  imei: string;
  name: string;
  type: string;
  param: string;
  resultType: string;
  units: string;
  formula: string;
  calibration: Array<{ x: number; y: number }>;
}

// Fuel-named sensors that report something other than the tank level.
const AUXILIARY_SENSOR_NAME =
  /temp|batt|volt|rate|econom|used|disconnect|consum/i;

@Injectable()
export class FuelSensorResolverService {
  private readonly logger = new Logger(FuelSensorResolverService.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Returns ALL fuel sensors for a vehicle, ordered by priority (type=fuel first).
   * Use this when you need to handle multi-tank vehicles.
   */
  async resolveAllFuelSensors(imei: string): Promise<FuelSensor[]> {
    const rows: Array<{
      sensor_id: number;
      imei: string;
      name: string;
      type: string;
      param: string;
      result_type: string;
      units: string;
      formula: string;
      calibration: string;
    }> = await this.dataSource.query(
      `SELECT sensor_id, imei, name, type, param, result_type, units, formula, calibration
       FROM gs_object_sensors
       WHERE imei = ? AND (type = 'fuel' OR name LIKE '%fuel%' OR name LIKE '%Fuel%')
       ORDER BY FIELD(type, 'fuel', 'cust') ASC`,
      [imei],
    );

    // The name match also catches auxiliary readings off the fuel probe
    // ("Fuel Sensor Temp" °C, "Fuel Sensor Battery" %, "Fuel Rate" l/h…).
    // Treating those as tanks summed 32 °C + 100 % into "current fuel" and
    // counted their swings as consumption/refuels. Real tanks are typed
    // 'fuel'; the name match is only a fallback for vehicles that have none.
    const tanks = rows.filter((row) => row.type === 'fuel');
    const levelRows = tanks.length
      ? tanks
      : rows.filter((row) => !AUXILIARY_SENSOR_NAME.test(row.name));

    if (!levelRows.length) {
      this.logger.warn(`No fuel sensor configured for IMEI ${imei}`);
      throw new UnprocessableEntityException(
        `No fuel sensor configured for vehicle ${imei}`,
      );
    }

    return levelRows.map((row) => ({
      sensorId: row.sensor_id,
      imei: row.imei,
      name: row.name,
      type: row.type,
      param: row.param,
      resultType: row.result_type,
      units: row.units,
      formula: row.formula,
      calibration: this.parseCalibration(row.calibration, imei, row.sensor_id),
    }));
  }

  /**
   * Returns a single sensor by sensorId. Used when caller explicitly picks one tank.
   */
  async resolveSensorById(imei: string, sensorId: number): Promise<FuelSensor> {
    const all = await this.resolveAllFuelSensors(imei);
    const found = all.find((s) => s.sensorId === sensorId);
    if (!found) {
      throw new NotFoundException(
        `Sensor ${sensorId} not found for vehicle ${imei}`,
      );
    }
    return found;
  }

  /**
   * Returns the primary sensor (first by priority).
   * Falls back to this when no specific sensorId is requested.
   */
  async resolveFuelSensor(imei: string): Promise<FuelSensor> {
    const all = await this.resolveAllFuelSensors(imei);
    return all[0];
  }

  private parseCalibration(
    raw: string,
    imei: string,
    sensorId: number,
  ): Array<{ x: number; y: number }> {
    if (!raw || raw === '[]') return [];

    try {
      const parsed = JSON.parse(raw) as Array<{
        x: string | number;
        y: string | number;
      }>;
      const points = parsed.map((p) => ({
        x: parseFloat(String(p.x)),
        y: parseFloat(String(p.y)),
      }));
      points.sort((a, b) => a.x - b.x);
      return points;
    } catch {
      this.logger.error(
        `Invalid calibration JSON for IMEI ${imei}, sensor_id ${sensorId}: ${raw}`,
      );
      return [];
    }
  }
}
