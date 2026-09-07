import {
  DROP_ALERT_THRESHOLD,
  FuelReading,
  POST_REFUEL_VERIFY_EPS_LITERS,
  RISE_THRESHOLD,
  STATIONARY_EVENT_THRESHOLD,
  eventToleranceLiters,
  isFakeRise,
  minEventLiters,
  stationaryEventTester,
} from './fuel-drop-filter.util';

const T0 = new Date('2026-03-01T10:00:00.000Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

function readings(
  spec: Array<{ minute: number; fuel: number; speed?: number }>,
): FuelReading[] {
  return spec.map((s) => ({ ts: at(s.minute), fuel: s.fuel, speed: s.speed }));
}

describe('minEventLiters', () => {
  it('uses 3 L standing still and the moving threshold otherwise', () => {
    expect(minEventLiters(true, DROP_ALERT_THRESHOLD)).toBe(
      STATIONARY_EVENT_THRESHOLD,
    );
    expect(minEventLiters(false, DROP_ALERT_THRESHOLD)).toBe(
      DROP_ALERT_THRESHOLD,
    );
  });
});

describe('stationaryEventTester', () => {
  it('accepts an event with the vehicle at rest throughout', () => {
    const parked = readings([
      { minute: 0, fuel: 100, speed: 0 },
      { minute: 1, fuel: 100, speed: 0 },
      { minute: 2, fuel: 100, speed: 0 },
      { minute: 3, fuel: 100, speed: 0 },
    ]);
    expect(stationaryEventTester(parked)(2, 3)).toBe(true);
  });

  it('tolerates GPS speed jitter below the stationary gate', () => {
    const jittering = readings([
      { minute: 0, fuel: 100, speed: 2 },
      { minute: 1, fuel: 100, speed: 1 },
      { minute: 2, fuel: 100, speed: 3 },
    ]);
    expect(stationaryEventTester(jittering)(1, 2)).toBe(true);
  });

  it('rejects an event where the vehicle is moving', () => {
    const departing = readings([
      { minute: 0, fuel: 100, speed: 0 },
      { minute: 1, fuel: 100, speed: 0 },
      { minute: 2, fuel: 100, speed: 40 },
    ]);
    expect(stationaryEventTester(departing)(1, 2)).toBe(false);
  });

  it('rejects an event still inside the settling margin after a stop', () => {
    // Only stopped at minute 3, so fuel at minute 3-4 is still settling.
    const justStopped = readings([
      { minute: 1, fuel: 100, speed: 45 },
      { minute: 2, fuel: 100, speed: 30 },
      { minute: 3, fuel: 100, speed: 0 },
      { minute: 4, fuel: 100, speed: 0 },
      { minute: 5, fuel: 100, speed: 0 },
      { minute: 6, fuel: 100, speed: 0 },
    ]);
    const isStationary = stationaryEventTester(justStopped);
    expect(isStationary(2, 3)).toBe(false);
    // …but two minutes later the settling margin is clear.
    expect(isStationary(4, 5)).toBe(true);
  });

  it('rejects indices outside the series', () => {
    const parked = readings([
      { minute: 0, fuel: 100, speed: 0 },
      { minute: 1, fuel: 100, speed: 0 },
    ]);
    const isStationary = stationaryEventTester(parked);
    expect(isStationary(-1, 0)).toBe(false);
    expect(isStationary(0, 5)).toBe(false);
  });
});

describe('eventToleranceLiters', () => {
  it('leaves events at or above the cap untouched', () => {
    expect(eventToleranceLiters(70, POST_REFUEL_VERIFY_EPS_LITERS)).toBe(
      POST_REFUEL_VERIFY_EPS_LITERS,
    );
    expect(eventToleranceLiters(8, DROP_ALERT_THRESHOLD)).toBe(
      DROP_ALERT_THRESHOLD,
    );
  });

  it('shrinks with the event below the cap so small events stay verified', () => {
    expect(eventToleranceLiters(3, DROP_ALERT_THRESHOLD)).toBe(1.5);
  });

  it('never returns a negative tolerance', () => {
    expect(eventToleranceLiters(-5, DROP_ALERT_THRESHOLD)).toBe(0);
  });
});

describe('isFakeRise', () => {
  it('accepts a real refuel even when the window also caught slosh', () => {
    // Sloshing on the drive in throws up an 8 L sub-rise that falls straight
    // back, then the vehicle parks and is filled. Judging the window on that
    // first sub-rise alone used to write the whole refuel off as fake.
    const rows = readings([
      { minute: 0, fuel: 163, speed: 45 },
      { minute: 1, fuel: 173, speed: 40 }, // slosh sub-rise (+10)
      { minute: 2, fuel: 163, speed: 45 }, // …falls straight back
      { minute: 3, fuel: 164, speed: 0 }, // parks
      { minute: 4, fuel: 200, speed: 0 }, // fill
      { minute: 5, fuel: 233, speed: 0 },
      { minute: 6, fuel: 233, speed: 0 },
    ]);

    expect(isFakeRise(at(3), rows)).toBe(false);
  });

  it('still rejects a rise that gives all the fuel back', () => {
    const rows = readings([
      { minute: 0, fuel: 163, speed: 0 },
      { minute: 1, fuel: 180, speed: 0 },
      { minute: 2, fuel: 163, speed: 0 },
      { minute: 3, fuel: 163, speed: 0 },
    ]);

    expect(isFakeRise(at(1), rows, 7, RISE_THRESHOLD)).toBe(true);
  });
});
