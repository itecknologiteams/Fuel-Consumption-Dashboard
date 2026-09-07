import { DataSource } from 'typeorm';
import {
  DataRow,
  DynamicTableQueryService,
} from './dynamic-table-query.service';
import { FuelConsumptionService } from './fuel-consumption.service';
import { FuelSensor } from './fuel-sensor-resolver.service';
import { FuelTransformService } from './fuel-transform.service';

/**
 * A fuel sensor is only trustworthy on a stationary vehicle — in motion slosh
 * swings it 10-15 L between readings — so every reported figure is taken at
 * rest and moving readings are left for the graph. These drive the real
 * analysis over synthetic readings to pin that down end to end.
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

interface Segment {
  /** How many one-minute readings this segment contributes. */
  minutes: number;
  fuel: number;
  speed: number;
}

const ORIGIN = new Date('2026-03-01T10:00:00.000Z');

/**
 * One reading per minute across the given segments. The first 10 minutes sit
 * before `from` so they only prime the median filter, exactly as a real query
 * behaves.
 */
function buildRows(segments: Segment[]): {
  rows: DataRow[];
  from: Date;
  to: Date;
} {
  const rows: DataRow[] = [];
  let minute = 0;

  for (const segment of segments) {
    for (let n = 0; n < segment.minutes; n++, minute++) {
      const ts = new Date(ORIGIN.getTime() + minute * 60_000);
      rows.push({
        dt_tracker: ts,
        dt_server: ts,
        lat: 0,
        lng: 0,
        speed: segment.speed,
        params: JSON.stringify({ fuel: String(segment.fuel) }),
      });
    }
  }

  return {
    rows,
    from: new Date(ORIGIN.getTime() + 10 * 60_000),
    to: rows[rows.length - 1].dt_tracker,
  };
}

async function analyse(segments: Segment[]) {
  const { rows, from, to } = buildRows(segments);
  const dynQuery = {
    getRowsInRange: jest.fn().mockResolvedValue(rows),
  } as unknown as DynamicTableQueryService;

  const service = new FuelConsumptionService(
    new FuelTransformService(),
    dynQuery,
    {} as DataSource, // only used by getPythonAlerts, not by getConsumption
  );

  return service.getConsumption(IMEI, from, to, SENSOR, '');
}

const PARKED = 0;
const DRIVING = 50;

describe('fuel events are read only off a stationary vehicle', () => {
  it('reports a 4 L drop while parked', async () => {
    const result = await analyse([
      { minutes: 30, fuel: 100, speed: PARKED },
      { minutes: 45, fuel: 96, speed: PARKED },
    ]);

    const confirmed = result.drops.filter((d) => d.isConfirmedDrop);
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0].consumed).toBeCloseTo(4, 1);
  });

  it('raises no event for the same 4 L change while moving', async () => {
    const result = await analyse([
      { minutes: 30, fuel: 100, speed: DRIVING },
      { minutes: 45, fuel: 96, speed: DRIVING },
    ]);

    expect(result.drops).toHaveLength(0);
  });

  it('raises no event for an 11 L change while moving', async () => {
    // Well over the old 8 L bar, but a moving reading says nothing about the
    // tank however large the swing.
    const result = await analyse([
      { minutes: 30, fuel: 100, speed: DRIVING },
      { minutes: 45, fuel: 89, speed: DRIVING },
    ]);

    expect(result.drops).toHaveLength(0);
  });

  it('reports a 4 L refuel while parked', async () => {
    const result = await analyse([
      { minutes: 30, fuel: 100, speed: PARKED },
      { minutes: 45, fuel: 104, speed: PARKED },
    ]);

    expect(result.refuels).toHaveLength(1);
    expect(result.refuels[0].added).toBeCloseTo(4, 1);
    expect(result.refueled).toBeCloseTo(4, 1);
  });

  it('raises no refuel for the same 4 L rise while moving', async () => {
    const result = await analyse([
      { minutes: 30, fuel: 100, speed: DRIVING },
      { minutes: 45, fuel: 104, speed: DRIVING },
    ]);

    expect(result.refuels).toHaveLength(0);
    expect(result.refueled).toBe(0);
  });

  it('records the peak time on a refuel so post-fill checks can anchor there', async () => {
    const result = await analyse([
      { minutes: 30, fuel: 100, speed: PARKED },
      { minutes: 45, fuel: 104, speed: PARKED },
    ]);

    expect(result.refuels[0].peakAt).toBeDefined();
    expect(
      new Date(result.refuels[0].peakAt as string).getTime(),
    ).toBeGreaterThanOrEqual(new Date(result.refuels[0].at).getTime());
  });
});

describe('consumption is measured stop to stop', () => {
  it("counts a trip's burn as the fall between the stops either side of it", async () => {
    const result = await analyse([
      { minutes: 30, fuel: 100, speed: PARKED }, // stop before the trip
      { minutes: 20, fuel: 85, speed: DRIVING }, // driving — sensor untrusted
      { minutes: 30, fuel: 60, speed: PARKED }, // stop after the trip
    ]);

    // 40 L burned on the trip, even though no drop EVENT was raised for it.
    expect(result.consumed).toBeCloseTo(40, 0);
    expect(result.drops).toHaveLength(0);
  });

  it('leaves slosh out of the total', async () => {
    // The vehicle burns nothing, but the sensor swings 15 L while moving.
    const result = await analyse([
      { minutes: 20, fuel: 100, speed: PARKED },
      { minutes: 5, fuel: 85, speed: DRIVING },
      { minutes: 5, fuel: 115, speed: DRIVING },
      { minutes: 5, fuel: 88, speed: DRIVING },
      { minutes: 30, fuel: 100, speed: PARKED },
    ]);

    expect(result.consumed).toBe(0);
    expect(result.drops).toHaveLength(0);
    expect(result.refuels).toHaveLength(0);
  });
});

describe('reported levels are taken at rest', () => {
  it('ignores a sloshed boundary reading in favour of a parked one', async () => {
    const result = await analyse([
      { minutes: 20, fuel: 70, speed: DRIVING }, // sloshed low at the boundary
      { minutes: 40, fuel: 100, speed: PARKED }, // the vehicle's real level
    ]);

    expect(result.firstFuel).toBeCloseTo(100, 0);
    expect(result.lastFuel).toBeCloseTo(100, 0);
    expect(result.netDrop).toBe(0);
  });

  it('falls back to the readings as taken when the vehicle never stopped', async () => {
    const result = await analyse([
      { minutes: 30, fuel: 100, speed: DRIVING },
      { minutes: 45, fuel: 89, speed: DRIVING },
    ]);

    // No rest point exists, so the boundary readings stand in and the change
    // still reaches the period total through the mass balance.
    expect(result.firstFuel).toBeCloseTo(100, 0);
    expect(result.lastFuel).toBeCloseTo(89, 0);
    expect(result.netDrop).toBeCloseTo(11, 0);
  });
});
