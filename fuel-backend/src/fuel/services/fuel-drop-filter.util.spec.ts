import {
  DROP_ALERT_THRESHOLD,
  FuelReading,
  POST_REFUEL_VERIFY_EPS_LITERS,
  RISE_THRESHOLD,
  eventToleranceLiters,
  isFakeRise,
  rawChangeIndex,
  stationaryTester,
} from './fuel-drop-filter.util';

const T0 = new Date('2026-03-01T10:00:00.000Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

function readings(
  spec: Array<{ minute: number; fuel: number; speed?: number }>,
): FuelReading[] {
  return spec.map((s) => ({ ts: at(s.minute), fuel: s.fuel, speed: s.speed }));
}

describe('stationaryTester', () => {
  describe('spansRest', () => {
    it('accepts a pair with the vehicle at rest throughout', () => {
      const parked = readings([
        { minute: 0, fuel: 100, speed: 0 },
        { minute: 1, fuel: 100, speed: 0 },
        { minute: 2, fuel: 100, speed: 0 },
        { minute: 3, fuel: 100, speed: 0 },
      ]);
      expect(stationaryTester(parked).spansRest(2, 3)).toBe(true);
    });

    it('tolerates GPS speed jitter below the stationary gate', () => {
      const jittering = readings([
        { minute: 0, fuel: 100, speed: 2 },
        { minute: 1, fuel: 100, speed: 1 },
        { minute: 2, fuel: 100, speed: 3 },
      ]);
      expect(stationaryTester(jittering).spansRest(1, 2)).toBe(true);
    });

    it('rejects a pair where the vehicle is moving', () => {
      const departing = readings([
        { minute: 0, fuel: 100, speed: 0 },
        { minute: 1, fuel: 100, speed: 0 },
        { minute: 2, fuel: 100, speed: 40 },
      ]);
      expect(stationaryTester(departing).spansRest(1, 2)).toBe(false);
    });

    it('rejects a pair still inside the settling margin after a stop', () => {
      // Only stopped at minute 3, so fuel at minute 3-4 is still settling.
      const justStopped = readings([
        { minute: 1, fuel: 100, speed: 45 },
        { minute: 2, fuel: 100, speed: 30 },
        { minute: 3, fuel: 100, speed: 0 },
        { minute: 4, fuel: 100, speed: 0 },
        { minute: 5, fuel: 100, speed: 0 },
        { minute: 6, fuel: 100, speed: 0 },
      ]);
      const atRest = stationaryTester(justStopped);
      expect(atRest.spansRest(2, 3)).toBe(false);
      // …but two minutes later the settling margin is clear.
      expect(atRest.spansRest(4, 5)).toBe(true);
    });

    it('rejects indices outside the series', () => {
      const parked = readings([
        { minute: 0, fuel: 100, speed: 0 },
        { minute: 1, fuel: 100, speed: 0 },
      ]);
      const atRest = stationaryTester(parked);
      expect(atRest.spansRest(-1, 0)).toBe(false);
      expect(atRest.spansRest(0, 5)).toBe(false);
    });

    it('rejects a pair whose window holds movement', () => {
      const departing = readings([
        { minute: 0, fuel: 100, speed: 0 },
        { minute: 1, fuel: 100, speed: 40 },
        { minute: 2, fuel: 100, speed: 45 },
        { minute: 3, fuel: 100, speed: 42 },
        { minute: 4, fuel: 100, speed: 0 },
        { minute: 5, fuel: 100, speed: 0 },
      ]);
      expect(stationaryTester(departing).spansRest(4, 5)).toBe(false);
    });
  });

  describe('isSettled', () => {
    // A trip that starts at minute 2 and ends at minute 5.
    const trip = readings([
      { minute: 0, fuel: 100, speed: 0 },
      { minute: 1, fuel: 100, speed: 0 },
      { minute: 2, fuel: 100, speed: 40 },
      { minute: 3, fuel: 100, speed: 50 },
      { minute: 4, fuel: 100, speed: 45 },
      { minute: 5, fuel: 100, speed: 0 },
      { minute: 6, fuel: 100, speed: 0 },
      { minute: 7, fuel: 100, speed: 0 },
      { minute: 8, fuel: 100, speed: 0 },
    ]);
    const atRest = stationaryTester(trip);

    it('accepts a reading taken before the vehicle set off', () => {
      expect(atRest.isSettled(1)).toBe(true);
    });

    it('rejects readings taken in motion', () => {
      expect(atRest.isSettled(3)).toBe(false);
    });

    it('rejects readings still settling right after the vehicle stops', () => {
      expect(atRest.isSettled(5)).toBe(false);
      expect(atRest.isSettled(6)).toBe(false);
    });

    it('accepts readings once the fuel has settled', () => {
      expect(atRest.isSettled(7)).toBe(true);
      expect(atRest.isSettled(8)).toBe(true);
    });

    it('rejects indices outside the series', () => {
      expect(atRest.isSettled(-1)).toBe(false);
      expect(atRest.isSettled(99)).toBe(false);
    });
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

describe('rawChangeIndex', () => {
  // A siphon while parked: the tank drops between minute 3 and minute 4, then
  // GPS reports a bogus 44 km/h at minute 6 while the vehicle sits still.
  const siphon = readings([
    { minute: 0, fuel: 229, speed: 0 },
    { minute: 1, fuel: 229, speed: 0 },
    { minute: 2, fuel: 229, speed: 0 },
    { minute: 3, fuel: 229, speed: 0 },
    { minute: 4, fuel: 212, speed: 0 },
    { minute: 5, fuel: 212, speed: 0 },
    { minute: 6, fuel: 212, speed: 44 },
    { minute: 7, fuel: 212, speed: 0 },
  ]);

  it('points back to the reading where the fuel actually fell', () => {
    // The median filter reports the step a couple of readings late, at 6.
    expect(rawChangeIndex(siphon, 6, 'drop')).toBe(4);
  });

  it('lets the event be judged on the stillness that actually applied', () => {
    const atRest = stationaryTester(siphon);
    // At the reported index the bogus speed spike says the vehicle is moving…
    expect(atRest.spansRest(5, 6)).toBe(false);
    // …but where the fuel actually went, it was standing still.
    const changeAt = rawChangeIndex(siphon, 6, 'drop');
    expect(atRest.spansRest(changeAt - 1, changeAt)).toBe(true);
  });

  it('finds the largest rise for a refuel', () => {
    const fill = readings([
      { minute: 0, fuel: 100, speed: 0 },
      { minute: 1, fuel: 102, speed: 0 },
      { minute: 2, fuel: 140, speed: 0 },
      { minute: 3, fuel: 141, speed: 0 },
    ]);
    expect(rawChangeIndex(fill, 3, 'rise')).toBe(2);
  });

  it('falls back to the reported index when nothing moved that way', () => {
    const flat = readings([
      { minute: 0, fuel: 100, speed: 0 },
      { minute: 1, fuel: 100, speed: 0 },
      { minute: 2, fuel: 100, speed: 0 },
    ]);
    expect(rawChangeIndex(flat, 2, 'drop')).toBe(2);
  });
});
