"use client";

import { useCallback, useEffect, useState, memo, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/components/ui";
import {
  getVehicles, getDashboardSummary, getCurrentFuel,
  getFuelHistory, getFuelConsumption, getFuelStats,
  getFuelSensors, getRefuelEvents,
  todayRange, dateInputToISO,
} from "@/lib/api";
import {
  Vehicle, DashboardSummaryData, FuelCurrentData,
  FuelHistoryData, FuelConsumptionData, FuelStatsData,
  FuelSensorsData, RefuelEventsData, ApiError,
} from "@/lib/types";

import AppShell             from "@/components/AppShell";
import MainHeader           from "@/components/MainHeader";
import KpiMiniCards         from "@/components/KpiMiniCards";
import DarkFuelChart        from "@/components/DarkFuelChart";
import FuelStatsPanel       from "@/components/FuelStatsPanel";
import FuelSensorsBar       from "@/components/FuelSensorsBar";
import RecentFuelLogs       from "@/components/RecentFuelLogs";
import QuickCalendar        from "@/components/QuickCalendar";
import ActiveAlerts         from "@/components/ActiveAlerts";
import FleetTargets         from "@/components/FleetTargets";
import { ShimmerStyle }     from "@/components/LoadingSkeleton";
import { buildFleetAlerts } from "@/lib/fleetAlerts";

// ── Page ─────────────────────────────────────────────────────────────────────

const DashboardPage = memo(function DashboardPage() {
  const { token, isLoading: authLoading, logout } = useAuth();
  const router = useRouter();
  const toast = useToast();

  // ── Date range ─────────────────────────────────────────────────────────────
  const [range, setRange] = useState(todayRange);

  // ── Vehicles ───────────────────────────────────────────────────────────────
  const [vehicles,      setVehicles]      = useState<Vehicle[]>([]);
  const [selectedImei,  setSelectedImei]  = useState("");
  const [loadingVehicles, setLoadingVehicles] = useState(false);

  // ── Dashboard summary ──────────────────────────────────────────────────────
  const [summary,       setSummary]       = useState<DashboardSummaryData | null>(null);
  const [loadingSummary, setLoadingSummary] = useState(false);

  // ── Live-poll state ────────────────────────────────────────────────────────
  const [lastLiveUpdate, setLastLiveUpdate] = useState<Date | null>(null);

  // ── Per-vehicle data ───────────────────────────────────────────────────────
  const [currentFuel,   setCurrentFuel]   = useState<FuelCurrentData | null>(null);
  const [fuelHistory,   setFuelHistory]   = useState<FuelHistoryData | null>(null);
  const [consumption,   setConsumption]   = useState<FuelConsumptionData | null>(null);
  const [fuelStats,     setFuelStats]     = useState<FuelStatsData | null>(null);
  const [fuelSensors,   setFuelSensors]   = useState<FuelSensorsData | null>(null);
  const [refuelEvents,  setRefuelEvents]  = useState<RefuelEventsData | null>(null);

  const [loadingVehicleData, setLoadingVehicleData] = useState(false);
  const [vehicleDataError,   setVehicleDataError]   = useState<ApiError | Error | null>(null);
  const [loadingSensors,     setLoadingSensors]     = useState(false);

  // ── 401 redirect ───────────────────────────────────────────────────────────
  const handle401 = useCallback(() => { logout(); router.replace("/login"); }, [logout, router]);

  useEffect(() => {
    if (!authLoading && !token) router.replace("/login");
  }, [authLoading, token, router]);

  // ── Load vehicles on mount ─────────────────────────────────────────────────
  useEffect(() => {
    if (!token) return;
    setLoadingVehicles(true);
    // The whole fleet, not just fuel-sensor vehicles: a truck with no sensor
    // still has position, distance and trip data worth seeing here. The sensor
    // fetch below already no-ops when a vehicle has none.
    getVehicles(token, false)
      .then(d => {
        setVehicles(d.vehicles);
        if (d.vehicles[0]) setSelectedImei(d.vehicles[0].imei);
      })
      .catch(e => {
        if (e instanceof ApiError && e.statusCode === 401) handle401();
        else toast.error("Couldn't load vehicles", e instanceof ApiError ? e.userMessage : undefined);
      })
      .finally(() => setLoadingVehicles(false));
  }, [token, handle401, toast]);

  // ── Load sensors when vehicle changes ──────────────────────────────────────
  useEffect(() => {
    if (!token || !selectedImei) return;
    setLoadingSensors(true);
    setFuelSensors(null);
    getFuelSensors(token, selectedImei)
      .then(setFuelSensors)
      .catch(e => {
        if (e instanceof ApiError && e.statusCode === 401) handle401();
        // 422 = no sensor configured — silently skip
      })
      .finally(() => setLoadingSensors(false));
  }, [token, selectedImei, handle401]);

  // ── Load dashboard summary ────────────────────────────────────────────────
  useEffect(() => {
    if (!token) return;
    setLoadingSummary(true);

    getDashboardSummary(token, range.from, range.to)
      .then(setSummary)
      .catch(e => {
        if (e instanceof ApiError && e.statusCode === 401) handle401();
        else toast.error("Couldn't load dashboard summary", e instanceof ApiError ? e.userMessage : undefined);
      })
      .finally(() => setLoadingSummary(false));
  }, [token, range, handle401, toast]);

  // ── Load per-vehicle data ──────────────────────────────────────────────────
  useEffect(() => {
    if (!token || !selectedImei) return;
    let cancelled = false;

    setLoadingVehicleData(true);
    setVehicleDataError(null);
    setCurrentFuel(null); setFuelHistory(null);
    setConsumption(null); setFuelStats(null); setRefuelEvents(null);

    // Auto-pick interval so the backend never rejects the range:
    //   ≤31 days  → 5min  (max granularity, ~8 928 pts)
    //   ≤90 days  → 15min (~8 640 pts)
    //   ≤365 days → hour  (~8 760 pts)
    //   >365 days → day
    const rangeDays = (new Date(range.to).getTime() - new Date(range.from).getTime()) / 86_400_000;
    const HISTORY_INTERVAL: "1min" | "5min" | "15min" | "hour" | "day" =
      rangeDays <= 3   ? "1min"  :
      rangeDays <= 31  ? "5min"  :
      rangeDays <= 90  ? "15min" :
      rangeDays <= 365 ? "hour"  : "day";

    Promise.allSettled([
      getCurrentFuel(token, selectedImei),
      getFuelHistory(token, selectedImei, range.from, range.to, HISTORY_INTERVAL),
      getFuelConsumption(token, selectedImei, range.from, range.to),
      getFuelStats(token, selectedImei, range.from, range.to),
      getRefuelEvents(token, selectedImei, range.from, range.to),
    ]).then(([cur, hist, cons, stats, refs]) => {
      if (cancelled) return;

      if (cur.status === "fulfilled") setCurrentFuel(cur.value);

      if (hist.status === "fulfilled") {
        setFuelHistory(hist.value);
      } else if (hist.status === "rejected") {
        const e = hist.reason;
        if (e instanceof ApiError && e.statusCode === 401) handle401();
        else setVehicleDataError(e);
      }

      if (cons.status  === "fulfilled") setConsumption(cons.value);
      if (stats.status === "fulfilled") setFuelStats(stats.value);
      if (refs.status  === "fulfilled") setRefuelEvents(refs.value);
    }).finally(() => { if (!cancelled) setLoadingVehicleData(false); });

    return () => { cancelled = true; };
  }, [token, selectedImei, range, handle401]);

  // ── Live polling: refresh chart + current fuel every 30 s when in today view
  useEffect(() => {
    if (!token || !selectedImei) return;

    // Only poll when range.to is within the last 10 minutes (live / "today" view).
    const toMs = new Date(range.to).getTime();
    if (Date.now() - toMs > 10 * 60 * 1000) return;

    const rangeDays = (new Date(range.to).getTime() - new Date(range.from).getTime()) / 86_400_000;
    const liveInterval: "1min" | "5min" | "15min" | "hour" | "day" =
      rangeDays <= 3   ? "1min"  :
      rangeDays <= 31  ? "5min"  :
      rangeDays <= 90  ? "15min" :
      rangeDays <= 365 ? "hour"  : "day";

    const poll = () => {
      const nowTo = new Date().toISOString();
      Promise.allSettled([
        getFuelHistory(token, selectedImei, range.from, nowTo, liveInterval),
        getCurrentFuel(token, selectedImei),
      ]).then(([hist, cur]) => {
        if (hist.status === "fulfilled") setFuelHistory(hist.value);
        if (cur.status === "fulfilled") setCurrentFuel(cur.value);
        setLastLiveUpdate(new Date());
      });
    };

    const id = setInterval(poll, 60_000);
    return () => clearInterval(id);
  }, [token, selectedImei, range.from, range.to]);

  // ── Date handlers ─────────────────────────────────────────────────────────
  // Pickers hand over a day; the range covers whole days — start of the first
  // through end of the last (or now, for today). Quoting the end day at its
  // midnight dropped that day's data and made a single-day pick impossible.
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const endOfDay   = (d: Date) => new Date(Math.min(
    new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() - 1,
    Date.now(),
  ));

  function selectDay(day: Date) {
    setRange({ from: startOfDay(day).toISOString(), to: endOfDay(day).toISOString() });
  }

  function handleFromChange(v: string) {
    try {
      const day = new Date(dateInputToISO(v));
      if (startOfDay(day).getTime() > Date.now()) return;
      // A new start begins a new selection: show that day until an end is picked.
      selectDay(day);
    } catch { /* ignore invalid input */ }
  }

  function handleToChange(v: string) {
    try {
      const newTo = endOfDay(new Date(dateInputToISO(v)));
      if (newTo <= new Date(range.from)) return;
      setRange(r => ({ ...r, to: newTo.toISOString() }));
    } catch { /* ignore invalid input */ }
  }

  // ── Prev / Next period nav for chart ──────────────────────────────────────
  function shiftPeriod(direction: -1 | 1) {
    const from = new Date(range.from);
    const to   = new Date(range.to);
    const spanMs = to.getTime() - from.getTime();
    setRange({
      from: new Date(from.getTime() + direction * spanMs).toISOString(),
      to:   new Date(to.getTime()   + direction * spanMs).toISOString(),
    });
  }

  // ── Derived (memoized) ────────────────────────────────────────────────────
  const selectedVehicle = useMemo(() => vehicles.find(v => v.imei === selectedImei), [vehicles, selectedImei]);
  const primarySensor   = useMemo(() => fuelSensors?.sensors[0], [fuelSensors]);
  const fleetAlerts     = useMemo(() => buildFleetAlerts(summary?.vehicles ?? []), [summary]);

  // Verified refuels only — the same ones counted in "Total Refueled".
  const refuelList = useMemo(() =>
    consumption?.refuels ? consumption.refuels.filter(r => r.isVerified !== false) :
    refuelEvents?.refuelEvents ?? [],
    [consumption, refuelEvents]
  );

  // ── Auth loading gate ─────────────────────────────────────────────────────
  if (authLoading || (!token && !authLoading)) {
    return (
      <div className="bg-app flex items-center justify-center h-screen">
        <Loader2 size={28} className="animate-spin" style={{ color: "var(--color-primary)" }} />
      </div>
    );
  }

  return (
    <>
      <ShimmerStyle />
      <AppShell
        rightPanel={
          <aside
            className="hidden xl:flex flex-shrink-0 flex-col gap-4 py-5 px-4 overflow-y-auto scroll-panel"
            style={{ width: 288, background: "var(--color-surface)", borderLeft: "1px solid var(--color-border)" }}
          >
            <ActiveAlerts
              vehicles={summary?.vehicles ?? []}
              loading={loadingSummary}
              selectedImei={selectedImei}
              onSelectImei={setSelectedImei}
            />
            <FleetTargets
              vehicles={summary?.vehicles ?? []}
              totalConsumed={summary?.totals.consumed ?? 0}
              loading={loadingSummary}
              efficiency={fuelStats?.efficiency}
              vehicleName={selectedVehicle?.name}
            />
          </aside>
        }
      >
          {/* Header — outside scroll container so dropdown escapes overflow */}
          <div style={{ position: "relative", zIndex: 50, flexShrink: 0, background: "var(--color-bg)", padding: "20px 24px 16px" }}>
            <MainHeader
              alerts={fleetAlerts}
              vehicles={vehicles}
              selectedImei={selectedImei}
              onSelectImei={setSelectedImei}
              from={range.from} to={range.to}
              onFromChange={handleFromChange}
              onToChange={handleToChange}
              loadingVehicles={loadingVehicles}
            />
          </div>

          {/* Scrollable body */}
          <main className="flex-1 overflow-y-auto scroll-panel px-6 pb-6">

            {/* Sensor bar */}
            {(fuelSensors || loadingSensors) && (
              <div className="mb-4 mt-4">
                <FuelSensorsBar sensorsData={fuelSensors} loading={loadingSensors} />
              </div>
            )}

            {/* KPI cards */}
            <div className={fuelSensors || loadingSensors ? "" : "mt-4"}>
              <KpiMiniCards data={summary} loading={loadingSummary} />
            </div>

            {/* Fuel level history chart */}
            <div className="mt-4">
              <DarkFuelChart
                buckets={fuelHistory?.buckets ?? []}
                consumption={consumption}
                loading={loadingVehicleData}
                error={vehicleDataError}
                onRetry={() => setSelectedImei(v => v)}
                vehicleName={selectedVehicle?.name}
                sensorName={primarySensor?.name}
                from={range.from}
                to={range.to}
                onPrevPeriod={() => shiftPeriod(-1)}
                onNextPeriod={() => shiftPeriod(1)}
                lastLiveUpdate={lastLiveUpdate}
              />
            </div>

            {/* Fuel stats panel */}
            <div className="mt-4">
              <FuelStatsPanel stats={fuelStats} loading={loadingVehicleData} />
            </div>

            {/* Fuel logs + Calendar */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
              <RecentFuelLogs
                refuelEvents={refuelList as any}
                currentFuel={currentFuel}
                loading={loadingVehicleData}
              />
              <QuickCalendar
                token={token}
                imei={selectedImei}
                vehicleName={selectedVehicle?.name}
                from={range.from}
                to={range.to}
                onSelectDay={selectDay}
              />
            </div>

            <div className="h-8" />
          </main>
      </AppShell>
    </>
  );
});

export default DashboardPage;
