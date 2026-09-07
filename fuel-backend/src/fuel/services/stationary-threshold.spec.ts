import { DataSource } from 'typeorm';
import {
  DataRow,
  DynamicTableQueryService,
} from './dynamic-table-query.service';
import { FuelConsumptionService } from './fuel-consumption.service';
import { FuelSensor } from './fuel-sensor-resolver.service';
import { FuelTransformService } from './fuel-transform.service';

/**
 * A 3 L change is a real event on a parked vehicle but noise on a moving one,
 * so the detection floor has to depend on speed. These drive the real
 * analysis over synthetic readings: a 4 L step is either found or ignored
 * purely on the strength of the speed recorded alongside it.
 */

const IMEI = '000000000000001';

const SENSOR: FuelSensor = {
  sensorId: 1,
  imei: IMEI,
  name: 'Fuel Level',
  type: 'fuel',
  param: 'fuel',
  resultType: 'value',
  units: 'Litres',
  formula: '', // no formula + no calibration → litres pass straight through
  calibration: [],
};

/**
 * One reading per minute spanning [-30 min, +45 min] around `stepAt`, at
 * `before` litres until the step and `after` litres from then on.
 */
function buildRows(opts: { before: number; after: number; speed: number }): {
  rows: DataRow[];
  from: Date;
  to: Date;
  stepAt: Date;
} {
  const origin = new Date('2026-03-01T10:00:00.000Z');
  const stepAt = new Date(origin.getTime() + 30 * 60_000);
  const rows: DataRow[] = [];

  for (let minute = 0; minute <= 75; minute++) {
    const ts = new Date(origin.getTime() + minute * 60_000);
    const fuel = ts >= stepAt ? opts.after : opts.before;
    rows.push({
      dt_tracker: ts,
      dt_server: ts,
      lat: 0,
      lng: 0,
      speed: opts.speed,
      params: JSON.stringify({ fuel: String(fuel) }),
    });
  }

  // `from` starts after the warm-up readings so they only prime the median
  // filter, exactly as a real query behaves.
  return {
    rows,
    from: new Date(origin.getTime() + 10 * 60_000),
    to: rows[rows.length - 1].dt_tracker,
    stepAt,
  };
}

function buildService(rows: DataRow[]): FuelConsumptionService {
  const dynQuery = {
    getRowsInRange: jest.fn().mockResolvedValue(rows),
  } as unknown as DynamicTableQueryService;

  return new FuelConsumptionService(
    new FuelTransformService(),
    dynQuery,
    {} as DataSource, // only used by getPythonAlerts, not by getConsumption
  );
}

async function analyse(opts: { before: number; after: number; speed: number }) {
  const { rows, from, to } = buildRows(opts);
  const service = buildService(rows);
  return service.getConsumption(IMEI, from, to, SENSOR, '');
}

describe('stationary event threshold (3 L parked / 8 L moving)', () => {
  it('reports a 4 L drop as a confirmed drop while parked', async () => {
    const result = await analyse({ before: 100, after: 96, speed: 0 });

    const confirmed = result.drops.filter((d) => d.isConfirmedDrop);
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0].consumed).toBeCloseTo(4, 1);
  });

  it('ignores the same 4 L drop while moving', async () => {
    const result = await analyse({ before: 100, after: 96, speed: 50 });

    expect(result.drops.filter((d) => d.isConfirmedDrop)).toHaveLength(0);
    // Below the moving floor it stays a sub-threshold single-reading jump and
    // never reaches the consumption total.
    expect(result.consumed).toBe(0);
  });

  it('still counts an 11 L drop while moving', async () => {
    const result = await analyse({ before: 100, after: 89, speed: 50 });

    // Over the 8 L moving floor, so it is analysed as an event and counted.
    // It is not a CONFIRMED drop — a drop with the vehicle driving throughout
    // is consumption, not theft, and isFakeSpike's movement veto says so.
    expect(result.consumed).toBeCloseTo(11, 1);
    expect(result.drops.filter((d) => d.isConfirmedDrop)).toHaveLength(0);
  });

  it('reports a 4 L rise as a refuel while parked', async () => {
    const result = await analyse({ before: 100, after: 104, speed: 0 });

    expect(result.refuels).toHaveLength(1);
    expect(result.refuels[0].added).toBeCloseTo(4, 1);
    expect(result.refueled).toBeCloseTo(4, 1);
  });

  it('ignores the same 4 L rise while moving', async () => {
    const result = await analyse({ before: 100, after: 104, speed: 50 });

    expect(result.refuels).toHaveLength(0);
    expect(result.refueled).toBe(0);
  });

  it('records the peak time on a refuel so post-fill checks can anchor there', async () => {
    const result = await analyse({ before: 100, after: 104, speed: 0 });

    expect(result.refuels[0].peakAt).toBeDefined();
    expect(
      new Date(result.refuels[0].peakAt as string).getTime(),
    ).toBeGreaterThanOrEqual(new Date(result.refuels[0].at).getTime());
  });
});
