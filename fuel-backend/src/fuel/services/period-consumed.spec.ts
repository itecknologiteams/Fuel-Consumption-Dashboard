import { periodConsumed } from './fuel-consumption.service';

describe('periodConsumed', () => {
  it('uses the mass balance when it is positive', () => {
    // Tank fell 40 L and 10 L was added → 50 L actually burned.
    expect(periodConsumed({ netDrop: 40, refueled: 10, consumed: 120 })).toBe(
      50,
    );
  });

  it('falls back to the drop sum when the period has no boundaries', () => {
    expect(periodConsumed({ netDrop: null, refueled: 0, consumed: 120 })).toBe(
      120,
    );
  });

  it('falls back to the drop sum when a refuel was missed', () => {
    // The tank ended fuller than it started but no refuel was detected, so the
    // balance is -16 L. Reporting max(0, …) here is what blanked the dashboard.
    expect(
      periodConsumed({ netDrop: -16.05, refueled: 0, consumed: 101.51 }),
    ).toBe(101.51);
  });

  it('falls back when a detected refuel does not cover the whole rise', () => {
    // e.g. a calibration table that saturates below tank capacity clips the
    // measured fill, leaving the balance non-positive.
    expect(periodConsumed({ netDrop: -40, refueled: 30, consumed: 90 })).toBe(
      90,
    );
  });

  it('reports no burn for an idle vehicle', () => {
    expect(periodConsumed({ netDrop: 0, refueled: 0, consumed: 0 })).toBe(0);
  });
});
