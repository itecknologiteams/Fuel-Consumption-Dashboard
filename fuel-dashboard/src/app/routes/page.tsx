"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Loader2, Fuel, Navigation, Droplets, RefreshCw,
  TrendingDown, TrendingUp, Truck, Wifi, WifiOff,
  ArrowLeft, CalendarDays, ChevronLeft, ChevronRight, X,
  Shield, Info, AlertTriangle,
} from "lucide-react";

import { useAuth } from "@/contexts/AuthContext";
import { getVehicles, getFuelConsumption, getCurrentFuel, getFuelStats, getFuelDropAlerts } from "@/lib/api";
import { Vehicle, FuelConsumptionData, FuelCurrentData, FuelStatsData, ApiError, FuelDropDetail } from "@/lib/types";
import { logAnomalies } from "@/lib/fuelAnomalyUtils";
import AppShell from "@/components/AppShell";
import { FuelEvent } from "@/components/RouteMap";
import { fmtDateDisplay, fmtDateTime, toLocalMidnight } from "@/lib/dateUtils";

const RouteMap = dynamic(() => import("@/components/RouteMap"), { ssr: false });

// ── Period presets ────────────────────────────────────────────────────────────

type Preset = "today" | "week" | "month" | "custom";

function getPresetRange(preset: Preset): { from: string; to: string } {
  const now = new Date();
  const to  = now.toISOString();

  if (preset === "today") {
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    return { from, to };
  }
  if (preset === "week") {
    // Monday of current week
    const day  = now.getDay(); // 0=Sun
    const diff = day === 0 ? -6 : 1 - day;
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() + diff).toISOString();
    return { from, to };
  }
  if (preset === "month") {
    const from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    return { from, to };
  }
  return { from: to, to }; // placeholder for custom
}

// ── Inline mini date-range calendar ──────────────────────────────────────────

const DAYS_SHORT = ["Su","Mo","Tu","We","Th","Fr","Sa"];
const MONTHS_FULL = ["January","February","March","April","May","June","July","August","September","October","November","December"];

const toMidnight = (iso: string) => toLocalMidnight(iso);
const fmtDisplay  = (iso: string) => fmtDateDisplay(iso);

interface CalendarProps {
  from: string; to: string;
  onFromChange: (v: string) => void;
  onToChange:   (v: string) => void;
  onClose:      () => void;
}

function InlineCalendar({ from, to, onFromChange, onToChange, onClose }: CalendarProps) {
  const today = new Date();
  const [viewYear,  setViewYear]  = useState(today.getFullYear());
  const [viewMonth, setViewMonth] = useState(today.getMonth());
  const [selecting, setSelecting] = useState<"from"|"to">("from");
  const [hovered,   setHovered]   = useState<Date|null>(null);

  const fromDate = toMidnight(from);
  const toDate   = toMidnight(to);

  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const firstDay    = new Date(viewYear, viewMonth, 1).getDay();
  const cells: (Date|null)[] = [
    ...Array(firstDay).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => new Date(viewYear, viewMonth, i + 1)),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  function handleDay(day: Date) {
    const iso = day.toISOString();
    if (selecting === "from") {
      onFromChange(iso);
      if (day >= toDate) onToChange(iso);
      setSelecting("to");
    } else {
      if (day < fromDate) { onToChange(from); onFromChange(iso); }
      else onToChange(iso);
      setSelecting("from");
    }
  }

  function dayStyle(day: Date): React.CSSProperties {
    const isFrom  = day.getTime() === fromDate.getTime();
    const isTo    = day.getTime() === toDate.getTime();
    const effectiveTo = selecting === "to" && hovered ? hovered : toDate;
    const inRange = day > fromDate && day < effectiveTo;
    const isToday = day.getTime() === new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    const base: React.CSSProperties = { width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 500, borderRadius: 8, cursor: "pointer", userSelect: "none" };
    if (isFrom || isTo) return { ...base, background: "var(--color-primary)", color: "#fff", fontWeight: 700, boxShadow: "0 2px 8px rgba(var(--color-primary-rgb),0.35)" };
    if (inRange)  return { ...base, background: "rgba(var(--color-primary-rgb),0.09)", color: "var(--color-primary)", fontWeight: 600, borderRadius: 0 };
    if (isToday)  return { ...base, border: "1.5px solid var(--color-primary)", color: "var(--color-primary)", fontWeight: 600 };
    return { ...base, color: "#374151" };
  }

  function prev() { if (viewMonth === 0) { setViewMonth(11); setViewYear(y => y-1); } else setViewMonth(m => m-1); }
  function next() { if (viewMonth === 11) { setViewMonth(0); setViewYear(y => y+1); } else setViewMonth(m => m+1); }

  return (
    <div style={{
      position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 9999,
      background: "#fff", border: "1px solid var(--color-border-soft)", borderRadius: 18,
      boxShadow: "0 20px 60px rgba(0,0,0,0.15)", padding: 16, minWidth: 296,
    }}>
      {/* Month nav */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <button onClick={prev} style={{ width: 26, height: 26, borderRadius: 8, border: "1px solid var(--color-border-soft)", background: "var(--color-surface-2)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
          <ChevronLeft size={12} style={{ color: "var(--color-text-2)" }} />
        </button>
        <span style={{ fontSize: 13, fontWeight: 700, color: "var(--color-text-1)" }}>{MONTHS_FULL[viewMonth]} {viewYear}</span>
        <button onClick={next} style={{ width: 26, height: 26, borderRadius: 8, border: "1px solid var(--color-border-soft)", background: "var(--color-surface-2)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
          <ChevronRight size={12} style={{ color: "var(--color-text-2)" }} />
        </button>
      </div>

      {/* Day headers */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", marginBottom: 4 }}>
        {DAYS_SHORT.map(d => (
          <div key={d} style={{ textAlign: "center", fontSize: 9, fontWeight: 700, color: "var(--color-text-3)", padding: "3px 0", textTransform: "uppercase" }}>{d}</div>
        ))}
      </div>

      {/* Cells */}
      {Array.from({ length: cells.length / 7 }, (_, row) => (
        <div key={row} style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)" }}>
          {cells.slice(row * 7, row * 7 + 7).map((day, col) => (
            <div key={col} style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "2px 0" }}
              onMouseEnter={() => day && setHovered(day)}
              onMouseLeave={() => setHovered(null)}
            >
              {day
                ? <div onClick={() => handleDay(day)} style={dayStyle(day)}>{day.getDate()}</div>
                : <div style={{ width: 32, height: 32 }} />}
            </div>
          ))}
        </div>
      ))}

      {/* Footer */}
      <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--color-bg)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div>
            <p style={{ fontSize: 9, fontWeight: 700, color: "var(--color-text-3)", textTransform: "uppercase", marginBottom: 2 }}>From</p>
            <p style={{ fontSize: 11, fontWeight: 700, color: "var(--color-primary)" }}>{fmtDisplay(from)}</p>
          </div>
          <span style={{ color: "#D1D5DB" }}>→</span>
          <div>
            <p style={{ fontSize: 9, fontWeight: 700, color: "var(--color-text-3)", textTransform: "uppercase", marginBottom: 2 }}>To</p>
            <p style={{ fontSize: 11, fontWeight: 700, color: "var(--color-primary)" }}>{fmtDisplay(to)}</p>
          </div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <p style={{ fontSize: 9, color: "var(--color-text-3)", textAlign: "right", maxWidth: 100, lineHeight: 1.4 }}>
            {selecting === "from" ? "Click start date" : "Click end date"}
          </p>
          <button onClick={onClose} style={{ width: 24, height: 24, borderRadius: 6, border: "1px solid var(--color-border-input)", background: "var(--color-bg)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
            <X size={11} style={{ color: "var(--color-text-2)" }} />
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const fmtTime = (iso: string) => fmtDateTime(iso);

// ── Page ─────────────────────────────────────────────────────────────────────

export default function RoutesPage() {
  const { token, isLoading: authLoading, logout } = useAuth();
  const router = useRouter();

  // ── Period state (default: this week) ──────────────────────────────────────
  const [preset,  setPreset]  = useState<Preset>("today");
  const [range,   setRange]   = useState(() => getPresetRange("today"));
  const [calOpen, setCalOpen] = useState(false);
  const calWrapRef = useRef<HTMLDivElement>(null);

  // ── Data ───────────────────────────────────────────────────────────────────
  const [vehicles,        setVehicles]        = useState<Vehicle[]>([]);
  const [selectedImei,    setSelectedImei]    = useState("");
  const [currentFuel,     setCurrentFuel]     = useState<FuelCurrentData | null>(null);
  const [consumption,     setConsumption]     = useState<FuelConsumptionData | null>(null);
  const [fuelStats,       setFuelStats]       = useState<FuelStatsData | null>(null);
  const [fuelEvents,      setFuelEvents]      = useState<FuelEvent[]>([]);
  const [pythonDrops,     setPythonDrops]     = useState<FuelDropDetail[]>([]);
  const [loading,         setLoading]         = useState(false);
  const [loadingVehicles, setLoadingVehicles] = useState(false);
  const [error,           setError]           = useState<string | null>(null);
  const [activeFilter,    setActiveFilter]    = useState<"all"|"drops"|"refuels">("drops");

  const handle401 = useCallback(() => { logout(); router.replace("/login"); }, [logout, router]);

  useEffect(() => { if (!authLoading && !token) router.replace("/login"); }, [authLoading, token, router]);

  // Close calendar on outside click
  useEffect(() => {
    function h(e: MouseEvent) {
      if (calWrapRef.current && !calWrapRef.current.contains(e.target as Node)) setCalOpen(false);
    }
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  // Apply preset
  function applyPreset(p: Preset) {
    setPreset(p);
    if (p !== "custom") setRange(getPresetRange(p));
    else setCalOpen(true);
  }

  // Load vehicles
  useEffect(() => {
    if (!token) return;
    setLoadingVehicles(true);
    getVehicles(token)
      .then(d => { setVehicles(d.vehicles); if (d.vehicles[0]) setSelectedImei(d.vehicles[0].imei); })
      .catch(e => { if (e instanceof ApiError && e.statusCode === 401) handle401(); else setError("Failed to load vehicles."); })
      .finally(() => setLoadingVehicles(false));
  }, [token, handle401]);

  // Load fuel events when vehicle or range changes
  useEffect(() => {
    if (!token || !selectedImei) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setCurrentFuel(null);
    setConsumption(null);
    setFuelStats(null);
    setFuelEvents([]);
    setPythonDrops([]);

    Promise.allSettled([
      getCurrentFuel(token, selectedImei),
      getFuelConsumption(token, selectedImei, range.from, range.to),
      getFuelStats(token, selectedImei, range.from, range.to),
      getFuelDropAlerts(token, selectedImei, range.from, range.to),
    ]).then(([cur, cons, stats, pyDrops]) => {
    
      if (cancelled) return;
      if (cur.status   === "fulfilled") setCurrentFuel(cur.value);
      if (stats.status === "fulfilled") setFuelStats(stats.value);

      // Python-confirmed drops from fuel_drop_alerts table (ground truth)
      const confirmedDrops: FuelDropDetail[] = pyDrops.status === "fulfilled"
        ? pyDrops.value.drops
        : [];
      setPythonDrops(confirmedDrops);

      if (cons.status === "fulfilled") {
        const c = cons.value;
        setConsumption(c);

        // DEBUG: Log the full refuel data to see if _anomaly is present
        console.log("[RoutesPage] Fuel consumption data:", {
          imei: c.imei,
          refuels: c.refuels?.length || 0,
          firstRefuel: c.refuels?.[0] ? {
            at: c.refuels[0].at,
            added: c.refuels[0].added,
            _anomaly: c.refuels[0]._anomaly,
            isVerified: c.refuels[0].isVerified,
          } : null,
          _anomalyMeta: c._anomalyMeta,
        });

        // Log anomalies for debugging
        if (c.refuels && c.refuels.length > 0) {
          logAnomalies(c.refuels, selectedImei);
        }

        // Merge: python confirmed drops (isConfirmedDrop:true) + refuels from consumption
        // Python drops take priority — they come directly from the monitoring script
        // that reads gs_objects (live sensor state), not gs_object_data (historical).
        const confirmedDropEvents: FuelEvent[] = confirmedDrops.map(d => ({
          type: "drop" as const,
          at: d.at,
          amount: d.consumed,
          fuelBefore: d.fuelBefore,
          fuelAfter: d.fuelAfter,
          unit: d.unit,
          isConfirmedDrop: true,
        }));

        // Process refuels with anomaly metadata
        const refuelEvents: FuelEvent[] = (c.refuels ?? []).map(r => {
          // The backend's verdict (isVerified) is the one every total uses.
          const isAnomaly = r.isVerified === false;
          if (isAnomaly) {
            console.log(`[RoutesPage] 🚨 Anomalous refuel detected: +${r.added}L at ${r.at}`, {
              type: r._anomaly?.anomalyType,
              reason: r._anomaly?.reason,
              confidence: r._anomaly?.confidence,
            });
          }
          return {
            type: "refuel" as const,
            at: r.at,
            amount: r.added,
            fuelBefore: r.fuelBefore,
            fuelAfter: r.fuelAfter,
            unit: r.unit,
            isAnomaly: isAnomaly,
            anomalyType: r._anomaly?.anomalyType,
            anomalyReason: r._anomaly?.reason,
            anomalyConfidence: r._anomaly?.confidence,
          };
        });

        // Include NestJS-detected confirmed drops (isConfirmedDrop=true from consumption API).
        // Python drops take priority — deduplicate by timestamp (within 5 min window).
        const pythonDropTimes = confirmedDropEvents.map(e => new Date(e.at).getTime());
        const nestDropEvents: FuelEvent[] = (c.drops ?? [])
          .filter(d => d.isConfirmedDrop && !pythonDropTimes.some(
            t => Math.abs(t - new Date(d.at).getTime()) < 5 * 60 * 1000
          ))
          .map(d => ({
            type: "drop" as const,
            at: d.at,
            amount: d.consumed,
            fuelBefore: d.fuelBefore,
            fuelAfter: d.fuelAfter,
            unit: d.unit,
            isConfirmedDrop: true,
          }));

        // Merge all drop sources then filter out sensor oscillations.
        // Pattern: sensor dips then recovers → next drop starts from HIGHER fuel
        // than current drop's endpoint. If recovery > 50% of drop magnitude
        // within 30 min → the drop was a spike, not a real loss.
        const allDropEvents = [...confirmedDropEvents, ...nestDropEvents]
          .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime()); // ASC for filter

        const RECOVERY_RATIO    = 0.5;   // ≥50% recovery between drops = spike
        const RECOVERY_MAX_MS   = 30 * 60 * 1000;
        const PREDROP_NOISE_L   = 3.0;   // allow up to 3L sensor drift between drops
        const PREDROP_RATIO     = 0.30;  // upward spike > 30% of drop magnitude = fake
        const PREDROP_MAX_MS    = 60 * 60 * 1000;

        // Pass 0: filter drops that recovered to near pre-drop level in raw readings
        // within 15 minutes — catches V-shaped sensor spikes where the recovery
        // happens via a RISE (not another drop), so Pass 1 can't see it.
        const SPIKE_RECOVERY_WINDOW_MS = 15 * 60 * 1000;
        const SPIKE_RECOVERY_FUEL_TOL  = 5.0; // within 5L of pre-drop level = recovered
        const rawReadings: Array<{ ts: string; fuel: number }> = (c as any).readings ?? [];
        const pass0 = allDropEvents.filter((d) => {
          const dropAt = new Date(d.at).getTime();
          const recovered = rawReadings.some((r) => {
            const rMs = new Date(r.ts).getTime();
            return rMs > dropAt &&
                   rMs <= dropAt + SPIKE_RECOVERY_WINDOW_MS &&
                   r.fuel >= d.fuelBefore - SPIKE_RECOVERY_FUEL_TOL;
          });
          return !recovered;
        });

        // Pass 1: filter drops whose fuel recovered before the next drop (oscillations)
        const pass1 = pass0.filter((d, idx) => {
          const next = pass0[idx + 1];
          if (!next) return true;
          const gapMs = new Date(next.at).getTime() - new Date(d.at).getTime();
          if (gapMs > RECOVERY_MAX_MS) return true;
          const dropMag = d.fuelBefore - d.fuelAfter;
          if (dropMag <= 0) return true;
          const recovery = next.fuelBefore - d.fuelAfter;
          return recovery / dropMag <= RECOVERY_RATIO;
        });

        // Pass 2: filter drops whose fuelBefore is inflated by a pre-drop upward spike.
        // If fuel apparently went UP between the previous drop's endpoint and this drop's
        // start (no refuel in between), the starting reading is sensor noise, and if the
        // spike accounts for >30% of the apparent drop magnitude → fake.
        const filteredDropEvents = pass1.filter((d, idx) => {
          if (idx === 0) return true;
          const prev = pass1[idx - 1];
          const gapMs = new Date(d.at).getTime() - new Date(prev.at).getTime();
          if (gapMs > PREDROP_MAX_MS) return true;
          const upwardSpike = d.fuelBefore - prev.fuelAfter;
          if (upwardSpike <= PREDROP_NOISE_L) return true; // within noise → real
          const dropMag = d.fuelBefore - d.fuelAfter;
          if (dropMag <= 0) return true;
          return upwardSpike / dropMag <= PREDROP_RATIO;
        });

        const events: FuelEvent[] = [
          ...filteredDropEvents,
          ...refuelEvents,
        ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()); // Latest first
        setFuelEvents(events);
      } else if (cons.status === "rejected") {
        const e = cons.reason;
        if (e instanceof ApiError && e.statusCode === 401) handle401();
        else setError(e instanceof ApiError ? e.userMessage : "Failed to load fuel data.");

        // Even if consumption failed, still show python drops
        if (confirmedDrops.length > 0) {
          const events: FuelEvent[] = confirmedDrops.map(d => ({
            type: "drop" as const,
            at: d.at,
            amount: d.consumed,
            fuelBefore: d.fuelBefore,
            fuelAfter: d.fuelAfter,
            unit: d.unit,
            isConfirmedDrop: true,
          })).sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()); // Latest first
          setFuelEvents(events);
        }
      }
    }).finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [token, selectedImei, range, handle401]);

  const selectedVehicle   = vehicles.find(v => v.imei === selectedImei);

  // First derive the base fuel event categories
  const drops = fuelEvents.filter(e => e.type === "drop");
  // Refuels the backend verified — it already trusts 50 L+ fills, so this
  // matches the refueled total on every other page.
  const isLegitimateRefuel = (e: FuelEvent) => e.type === "refuel" && !e.isAnomaly;
  const refuels = fuelEvents.filter(isLegitimateRefuel);
  const filteredEvents = fuelEvents.filter(e => {
    // Never show noise / normal-consumption drops — only confirmed drop alerts
    if (e.type === "drop" && !e.isConfirmedDrop) return false;
    // Only show legitimate refuels (hide small anomalous ones)
    if (e.type === "refuel" && !isLegitimateRefuel(e)) return false;
    return activeFilter === "all" ? true : activeFilter === "drops" ? e.type === "drop" : e.type === "refuel";
  });

  // Confirmed drops: >= 8 L and fuel stayed low for 7 continuous minutes
  const confirmedDrops    = drops.filter(e => e.isConfirmedDrop);
  const dropCount         = drops.length;
  const confirmedDropCount= confirmedDrops.length;
  const refuelCount       = refuels.length;
  const confirmedDropTotal= confirmedDrops.reduce((s, e) => s + e.amount, 0);

  // The backend's totals — the same figures the dashboard, stats and reports
  // show for this period (verified refuels; mass-balance burn). Recomputing
  // them here with different rules made this page disagree with the others.
  const totalRefueled = consumption?.refueled ?? 0;
  const totalDropped  = consumption?.periodConsumed ?? consumption?.consumed ?? 0;
  const netChange = totalRefueled - totalDropped;

  // Fuel level estimation for the ring (same calc as in RouteMap).
  // Guard against NaN: fuelBefore/fuelAfter may be undefined; currentFuel.fuel
  // can be undefined when no sensor data, making the division return NaN.
  const maxObserved = fuelEvents.reduce(
    (m, e) => Math.max(m, isFinite(e.fuelBefore) ? e.fuelBefore : 0, isFinite(e.fuelAfter) ? e.fuelAfter : 0),
    0,
  );
  const estCapacity  = maxObserved > 0 ? maxObserved * 1.1 : 200;
  const rawFuelLevel = currentFuel?.fuel;
  const fuelPct      =
    rawFuelLevel != null && isFinite(rawFuelLevel) && estCapacity > 0
      ? Math.min(100, Math.max(0, (rawFuelLevel / estCapacity) * 100))
      : null;
  const fuelColor   = fuelPct === null ? "#9CA3AF" : fuelPct > 60 ? "#22c55e" : fuelPct > 30 ? "#f59e0b" : "#ef4444";

  const PRESETS: { key: Preset; label: string }[] = [
    { key: "today", label: "Today" },
    { key: "week",  label: "This Week" },
    { key: "month", label: "This Month" },
  ];

  if (authLoading) return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", background: "var(--color-bg)" }}>
      <Loader2 size={26} style={{ color: "var(--color-primary)" }} className="animate-spin" />
    </div>
  );

  return (
    <AppShell>

      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>

        {/* ── Top bar ──────────────────────────────────────────────────── */}
        <div style={{
          flexShrink: 0, background: "#FFFFFF", borderBottom: "1px solid var(--color-border-soft)",
          padding: "12px 24px", display: "flex", alignItems: "center",
          justifyContent: "space-between", gap: 16, zIndex: 40,
        }}>
          {/* Left: back + title */}
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button onClick={() => router.push("/")} style={{ display: "flex", alignItems: "center", gap: 6, background: "var(--color-bg)", border: "1px solid var(--color-border-input)", borderRadius: 10, padding: "6px 12px", cursor: "pointer", fontSize: 12, fontWeight: 600, color: "var(--color-text-2)" }}>
              <ArrowLeft size={13} /> Dashboard
            </button>
            <div>
              <h1 style={{ fontSize: 15, fontWeight: 700, color: "var(--color-text-1)" }}>Fleet Routes &amp; Fuel Events</h1>
              <p style={{ fontSize: 11, color: "var(--color-text-3)" }}>
                {fmtDisplay(range.from)} → {fmtDisplay(range.to)}
              </p>
            </div>
          </div>

          {/* Center: period preset chips + custom calendar */}
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {PRESETS.map(p => (
              <div key={p.key} style={{ position: "relative" }}>
                <button
                  onClick={() => applyPreset(p.key)}
                  style={{
                    padding: "7px 16px", borderRadius: 20, fontSize: 12, fontWeight: 600,
                    cursor: "pointer", border: "none", transition: "all 0.15s",
                    background: preset === p.key ? "var(--color-primary)" : "var(--color-bg)",
                    color:      preset === p.key ? "#FFFFFF" : "var(--color-text-2)",
                    boxShadow:  preset === p.key ? "0 4px 12px rgba(var(--color-primary-rgb),0.3)" : "none",
                    display: "flex", alignItems: "center", gap: 5,
                  }}
                >
                  {p.key === "custom" && <CalendarDays size={12} />}
                  {p.label}
                </button>

                {/* Inline calendar for custom */}
                {p.key === "custom" && preset === "custom" && calOpen && (
                  <InlineCalendar
                    from={range.from} to={range.to}
                    onFromChange={v => setRange(r => ({ ...r, from: v }))}
                    onToChange={v => { setRange(r => ({ ...r, to: v })); setCalOpen(false); }}
                    onClose={() => setCalOpen(false)}
                  />
                )}
              </div>
            ))}
          </div>

          {/* Right: event type filter */}
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {(["all","drops","refuels"] as const).map(f => (
              <button
                key={f}
                onClick={() => setActiveFilter(f)}
                style={{
                  padding: "6px 14px", borderRadius: 20, fontSize: 11, fontWeight: 600,
                  cursor: "pointer", border: `1px solid ${activeFilter === f ? "var(--color-primary)" : "var(--color-border-input)"}`,
                  background: activeFilter === f ? "rgba(var(--color-primary-rgb),0.08)" : "#FFFFFF",
                  color:      activeFilter === f ? "var(--color-primary)" : "var(--color-text-3)",
                  transition: "all 0.15s",
                }}
              >
                {f === "all" ? "All Events" : f === "drops" ? "🔴 Drops" : "🟢 Refuels"}
              </button>
            ))}
          </div>
        </div>

        {/* ── Body ─────────────────────────────────────────────────────── */}
        {/* On small screens the 3 panes scroll horizontally so nothing overflows
            the viewport; on lg+ they sit side by side as a fixed workspace. */}
        <div className="flex-1 flex overflow-x-auto lg:overflow-x-hidden overflow-y-hidden">

          {/* LEFT: vehicles + stats */}
          <div style={{ width: 272, flexShrink: 0, background: "#FFFFFF", borderRight: "1px solid var(--color-border-soft)", display: "flex", flexDirection: "column", overflow: "hidden" }}>

            {/* Stats */}
            <div style={{ padding: "14px 14px 10px", borderBottom: "1px solid var(--color-bg)" }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
                <div style={{ background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 12, padding: "10px 12px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 3 }}>
                    <TrendingDown size={11} style={{ color: "#ef4444" }} />
                    <span style={{ fontSize: 9, fontWeight: 700, color: "#ef4444", textTransform: "uppercase", letterSpacing: "0.06em" }}>Dropped</span>
                  </div>
{/* <p style={{ fontSize: 20, fontWeight: 800, color: "#1A1A2E", lineHeight: 1 }}>{totalDropped.toFixed(1)}</p> */}
                  <p style={{ fontSize: 20, color: "var(--color-text-3)", marginTop: 2 }}>
                    {confirmedDropCount > 0
                      ? <><span style={{ color: "#ef4444", fontWeight: 700 }}>{confirmedDropCount} alert{confirmedDropCount > 1 ? "s" : ""}</span> · {confirmedDropTotal.toFixed(1)} L</>
                      : "No drops"}
                  </p>
                </div>
                <div style={{ background: "#F0FDF4", border: "1px solid #BBF7D0", borderRadius: 12, padding: "10px 12px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 3 }}>
                    <TrendingUp size={11} style={{ color: "#22c55e" }} />
                    <span style={{ fontSize: 9, fontWeight: 700, color: "#22c55e", textTransform: "uppercase", letterSpacing: "0.06em" }}>Refueled</span>
                  </div>
                  <p style={{ fontSize: 20, fontWeight: 800, color: "var(--color-text-1)", lineHeight: 1 }}>{totalRefueled.toFixed(1)}</p>
                  <p style={{ fontSize: 9, color: "var(--color-text-3)", marginTop: 2 }}>
                    litres this period
                  </p>
                </div>
              </div>

            </div>

            {/* Vehicle list */}
            <div style={{ padding: "10px 14px 4px" }}>
              <p style={{ fontSize: 9, fontWeight: 700, color: "var(--color-text-3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                {loadingVehicles ? "Loading…" : `${vehicles.length} Vehicles`}
              </p>
            </div>
            <div style={{ flex: 1, overflowY: "auto" }}>
              {loadingVehicles
                ? <div style={{ display: "flex", justifyContent: "center", padding: 24 }}><Loader2 size={16} style={{ color: "var(--color-primary)" }} className="animate-spin" /></div>
                : vehicles.map(v => {
                  const isSel  = v.imei === selectedImei;
                  const online = v.status === "online";
                  return (
                    <div key={v.imei} onClick={() => setSelectedImei(v.imei)}
                      style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 14px", cursor: "pointer", background: isSel ? "rgba(var(--color-primary-rgb),0.05)" : "transparent", borderLeft: `3px solid ${isSel ? "var(--color-primary)" : "transparent"}`, transition: "background 0.12s" }}
                      onMouseEnter={e => { if (!isSel) (e.currentTarget as HTMLDivElement).style.background = "var(--color-surface-2)"; }}
                      onMouseLeave={e => { if (!isSel) (e.currentTarget as HTMLDivElement).style.background = "transparent"; }}
                    >
                      <div style={{ width: 34, height: 34, borderRadius: 10, flexShrink: 0, background: isSel ? "var(--color-primary)" : "var(--color-bg)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <Truck size={14} style={{ color: isSel ? "white" : "var(--color-text-3)" }} />
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{ fontSize: 12, fontWeight: 600, color: "var(--color-text-1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{v.name}</p>
                        <p style={{ fontSize: 10, color: "var(--color-text-3)" }}>{v.plateNumber}</p>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 3, flexShrink: 0 }}>
                        {online ? <Wifi size={11} style={{ color: "#22c55e" }} /> : <WifiOff size={11} style={{ color: "var(--color-primary)" }} />}
                        <span style={{ fontSize: 9, fontWeight: 700, color: online ? "#22c55e" : "var(--color-primary)" }}>
                          {online ? "Online" : "Offline"}
                        </span>
                      </div>
                    </div>
                  );
                })}
            </div>
          </div>

          {/* MAP */}
          <div className="min-w-[300px] lg:min-w-0" style={{ flex: 1, position: "relative", overflow: "hidden" }}>
            <RouteMap
              vehicles={vehicles}
              selectedImei={selectedImei}
              onSelectVehicle={setSelectedImei}
              fuelEvents={filteredEvents}
              currentFuel={currentFuel}
              dropCount={dropCount}
              refuelCount={refuelCount}
            />

            {/* ── Floating selected-vehicle info card ─────────────────── */}
            {selectedVehicle && !loading && (
              <div style={{
                position: "absolute", top: 14, right: 14, zIndex: 999,
                background: "rgba(255,255,255,0.97)", backdropFilter: "blur(16px)",
                border: "1px solid var(--color-border-soft)", borderRadius: 16,
                boxShadow: "0 8px 32px rgba(0,0,0,0.12)", width: 240,
                fontFamily: "system-ui, sans-serif", overflow: "hidden",
              }}>
                {/* Card header */}
                <div style={{ background: "var(--color-text-1)", padding: "12px 14px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ width: 28, height: 28, borderRadius: 8, background: "var(--color-primary)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                      <Truck size={12} color="white" />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <p style={{ fontSize: 12, fontWeight: 700, color: "white", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{selectedVehicle.name}</p>
                      <p style={{ fontSize: 9, color: "rgba(255,255,255,0.5)" }}>{selectedVehicle.plateNumber}</p>
                    </div>
                    <span style={{ fontSize: 8, fontWeight: 700, padding: "2px 7px", borderRadius: 10, background: selectedVehicle.status === "online" ? "rgba(34,197,94,0.2)" : "rgba(255,255,255,0.1)", color: selectedVehicle.status === "online" ? "#4ade80" : "rgba(255,255,255,0.4)" }}>
                      {selectedVehicle.status === "online" ? "● ONLINE" : "● OFFLINE"}
                    </span>
                  </div>
                </div>

                <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
                  {/* Fuel level */}
                  {/* {currentFuel && fuelPct !== null ? (
                    <div>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5 }}>
                        <span style={{ fontSize: 9, fontWeight: 700, color: "#9CA3AF", textTransform: "uppercase", letterSpacing: "0.06em" }}>Current Fuel</span>
                      <span style={{ fontSize: 13, fontWeight: 800, color: fuelColor }}>{(currentFuel.fuel ?? 0).toFixed(1)} L</span>
                    </div>
                    <div style={{ height: 7, background: "#F0EFEF", borderRadius: 4, overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${fuelPct ?? 0}%`, background: fuelColor, borderRadius: 4 }} />
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", marginTop: 3 }}>
                      <span style={{ fontSize: 8, color: "#D1D5DB" }}>Empty</span>
                      <span style={{ fontSize: 8, color: fuelColor, fontWeight: 700 }}>{(fuelPct ?? 0).toFixed(0)}%</span>
                      <span style={{ fontSize: 8, color: "#D1D5DB" }}>{(estCapacity ?? 200).toFixed(0)} L cap.</span>
                    </div>
                    </div>
                  ) : currentFuel ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <Fuel size={12} style={{ color: "#E84040" }} />
                      <span style={{ fontSize: 12, fontWeight: 800, color: "#E84040" }}>{(currentFuel.fuel ?? 0).toFixed(1)} L</span>
                      <span style={{ fontSize: 9, color: "#9CA3AF" }}>current fuel</span>
                    </div>
                  ) : null} */}

                  {/* Speed / movement */}
                  {currentFuel && (
                    <div style={{ display: "flex", alignItems: "center", gap: 6, background: "#F9F9F9", borderRadius: 8, padding: "6px 8px" }}>
                      <Navigation size={11} style={{ color: currentFuel.speed > 0 ? "var(--color-primary)" : "var(--color-text-3)" }} />
                      <span style={{ fontSize: 11, fontWeight: 700, color: currentFuel.speed > 0 ? "var(--color-text-1)" : "var(--color-text-3)" }}>
                        {currentFuel.speed > 0 ? `${currentFuel.speed} km/h` : "Parked / Idle"}
                      </span>
                    </div>
                  )}

                  {/* Period stats */}
                  <div>
                    <p style={{ fontSize: 9, fontWeight: 700, color: "var(--color-text-3)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>
                      {preset === "today" ? "Today" : preset === "week" ? "This Week" : preset === "month" ? "This Month" : "Custom"} · Fuel Events
                    </p>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                      <div style={{ background: "#FEF2F2", borderRadius: 8, padding: "7px 8px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 3, marginBottom: 2 }}>
                          <TrendingDown size={9} style={{ color: "#ef4444" }} />
                          <span style={{ fontSize: 8, fontWeight: 700, color: "#ef4444", textTransform: "uppercase" }}>Drops</span>
                        </div>
                        {/* <p style={{ fontSize: 14, fontWeight: 800, color: "#1A1A2E" }}>{dropCount}</p> */}
                        <p style={{ fontSize: 9, color: "#ef4444", fontWeight: 700 }}>
                          {confirmedDropCount > 0
                            ? <>{confirmedDropCount} confirmed</>
                            : <>No drops</>}
                        </p>
                      </div>
                      <div style={{ background: "#F0FDF4", borderRadius: 8, padding: "7px 8px", border: "none" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 3, marginBottom: 2 }}>
                          <TrendingUp size={9} style={{ color: "#22c55e" }} />
                          <span style={{ fontSize: 8, fontWeight: 700, color: "#22c55e", textTransform: "uppercase" }}>Refuels</span>
                        </div>
                        <p style={{ fontSize: 14, fontWeight: 800, color: "var(--color-text-1)" }}>{refuelCount}</p>
                        <p style={{ fontSize: 9, color: "#22c55e", fontWeight: 700 }}>
                          +{totalRefueled.toFixed(1)} L
                        </p>
                      </div>
                    </div>
                    <div style={{ marginTop: 6, background: "var(--color-bg)", borderRadius: 8, padding: "6px 8px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span style={{ fontSize: 9, color: "var(--color-text-3)", fontWeight: 600 }}>Net change</span>
                      <span style={{ fontSize: 12, fontWeight: 800, color: netChange >= 0 ? "#22c55e" : "#ef4444" }}>
                        {netChange >= 0 ? "+" : ""}{netChange.toFixed(1)} L
                      </span>
                    </div>
                  </div>

                  {/* Efficiency stats (from getFuelStats) */}
                  {fuelStats && (
                    <div>
                      <p style={{ fontSize: 9, fontWeight: 700, color: "var(--color-text-3)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>Performance</p>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 5 }}>
                        <div style={{ textAlign: "center", background: "#F9F9F9", borderRadius: 8, padding: "6px 4px" }}>
                          <p style={{ fontSize: 11, fontWeight: 800, color: "var(--color-text-1)" }}>{(fuelStats.efficiency?.kmPerLiter ?? 0).toFixed(1)}</p>
                          <p style={{ fontSize: 8, color: "var(--color-text-3)" }}>km/L</p>
                        </div>
                        <div style={{ textAlign: "center", background: "#F9F9F9", borderRadius: 8, padding: "6px 4px" }}>
                          <p style={{ fontSize: 11, fontWeight: 800, color: "var(--color-text-1)" }}>{(fuelStats.avgDailyConsumption ?? 0).toFixed(1)}</p>
                          <p style={{ fontSize: 8, color: "var(--color-text-3)" }}>L/day</p>
                        </div>
                        <div style={{ textAlign: "center", background: fuelStats.idleDrain?.percentage > 15 ? "#FEF2F2" : "#F9F9F9", borderRadius: 8, padding: "6px 4px" }}>
                          <p style={{ fontSize: 11, fontWeight: 800, color: fuelStats.idleDrain?.percentage > 15 ? "#ef4444" : "var(--color-text-1)" }}>
                            {(fuelStats.idleDrain?.percentage ?? 0).toFixed(0)}%
                          </p>
                          <p style={{ fontSize: 8, color: "var(--color-text-3)" }}>idle</p>
                        </div>
                      </div>
                      {fuelStats.efficiency?.totalDistanceKm > 0 && (
                        <p style={{ fontSize: 9, color: "var(--color-text-3)", marginTop: 4, textAlign: "center" }}>
                          Total distance: {(fuelStats.efficiency?.totalDistanceKm ?? 0).toFixed(1)} km
                        </p>
                      )}
                    </div>
                  )}

                  {/* Alert banner: multiple confirmed drops */}
                  {confirmedDropCount > 3 && (
                    <div style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 8, padding: "7px 10px", display: "flex", alignItems: "flex-start", gap: 6 }}>
                      <AlertTriangle size={12} style={{ color: "#ef4444", flexShrink: 0, marginTop: 1 }} />
                      <div>
                        <p style={{ fontSize: 10, fontWeight: 700, color: "#ef4444" }}>High Drop Rate</p>
                        <p style={{ fontSize: 9, color: "var(--color-text-3)" }}>{confirmedDropCount} confirmed drops detected — check for fuel theft or sensor issues.</p>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Legend */}
            <div style={{ position: "absolute", bottom: 20, left: 16, background: "rgba(255,255,255,0.95)", backdropFilter: "blur(12px)", border: "1px solid var(--color-border-soft)", borderRadius: 12, padding: "10px 14px", boxShadow: "0 4px 20px rgba(0,0,0,0.10)", display: "flex", flexDirection: "column", gap: 5, zIndex: 999 }}>
              <p style={{ fontSize: 9, fontWeight: 700, color: "var(--color-text-3)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 3 }}>Legend</p>
              {[
                { color: "#22c55e", label: "Online vehicle" },
                { color: "#6B7280", label: "Offline vehicle" },
                { color: "#E84040", label: "Selected vehicle" },
                { color: "#f97316", label: "Small drop / noise" },
                { color: "#22c55e", label: "Refuel" },
              ].map(({ color, label }) => (
                <div key={label} style={{ display: "flex", alignItems: "center", gap: 7 }}>
                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: color, flexShrink: 0 }} />
                  <span style={{ fontSize: 10, color: "var(--color-text-2)" }}>{label}</span>
                </div>
              ))}
            </div>

            {/* Loading pill */}
            {loading && (
              <div style={{ position: "absolute", top: 14, left: "50%", transform: "translateX(-50%)", background: "rgba(255,255,255,0.95)", backdropFilter: "blur(8px)", border: "1px solid var(--color-border-soft)", borderRadius: 20, padding: "7px 16px", display: "flex", alignItems: "center", gap: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.1)", zIndex: 999 }}>
                <Loader2 size={13} style={{ color: "var(--color-primary)" }} className="animate-spin" />
                <span style={{ fontSize: 12, fontWeight: 600, color: "var(--color-text-2)" }}>Loading fuel events…</span>
              </div>
            )}
          </div>

          {/* RIGHT: timeline */}
          <div style={{ width: 296, flexShrink: 0, background: "#FFFFFF", borderLeft: "1px solid var(--color-border-soft)", display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <div style={{ padding: "14px 14px 10px", borderBottom: "1px solid var(--color-bg)" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div>
                  <p style={{ fontSize: 13, fontWeight: 700, color: "var(--color-text-1)" }}>{selectedVehicle?.name ?? "Fuel Events"}</p>
                  <p style={{ fontSize: 10, color: "var(--color-text-3)" }}>{filteredEvents.length} events · {preset === "today" ? "Today" : preset === "week" ? "This Week" : preset === "month" ? "This Month" : "Custom range"}</p>
                </div>
                <button onClick={() => setSelectedImei(v => v)} style={{ width: 28, height: 28, borderRadius: 8, border: "1px solid var(--color-border-input)", background: "var(--color-bg)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
                  <RefreshCw size={12} style={{ color: "var(--color-text-2)" }} />
                </button>
              </div>
              {error && (
                <div style={{ marginTop: 8, background: "rgba(var(--color-primary-rgb),0.06)", border: "1px solid rgba(var(--color-primary-rgb),0.2)", borderRadius: 10, padding: "7px 10px", display: "flex", gap: 7 }}>
                  <AlertTriangle size={12} style={{ color: "var(--color-primary)", flexShrink: 0, marginTop: 1 }} />
                  <p style={{ fontSize: 11, color: "var(--color-primary)" }}>{error}</p>
                </div>
              )}
            </div>

            {/* Timeline scroll */}
            <div style={{ flex: 1, overflowY: "auto", padding: "10px 0" }}>
              {loading ? (
                <div style={{ display: "flex", justifyContent: "center", padding: 32 }}>
                  <Loader2 size={18} style={{ color: "var(--color-primary)" }} className="animate-spin" />
                </div>
              ) : filteredEvents.length === 0 ? (
                <div style={{ padding: 24, textAlign: "center" }}>
                  <Droplets size={28} style={{ color: "#DBEAFE", margin: "0 auto 8px" }} />
                  <p style={{ fontSize: 12, color: "var(--color-text-3)" }}>No events for this period</p>
                  <p style={{ fontSize: 11, color: "#D1D5DB", marginTop: 4 }}>Try "This Month" or Custom</p>
                </div>
              ) : (
                <div style={{ position: "relative", padding: "0 14px" }}>
                  <div style={{ position: "absolute", left: 26, top: 0, bottom: 0, width: 2, background: "var(--color-border-soft)" }} />
                  {filteredEvents.map((ev, i) => {
                    const isDrop      = ev.type === "drop";
                    const isAlert     = isDrop && ev.isConfirmedDrop; // >= 8 L, stayed low 7 min
                    const isSmallDrop = isDrop && !ev.isConfirmedDrop;
                    const isRefuel    = ev.type === "refuel";
                    // Confirmed alert → vivid red; small drop → muted orange; refuel → green
                    const dotBg    = isAlert ? "#dc2626" : isSmallDrop ? "#f97316" : "#22c55e";
                    const cardBg   = isAlert ? "#FEF2F2" : isSmallDrop ? "#FFF7ED" : "#F0FDF4";
                    const cardBdr  = isAlert ? "#FECACA" : isSmallDrop ? "#FED7AA" : "#BBF7D0";
                    const labelClr = isAlert ? "#dc2626" : isSmallDrop ? "#ea580c" : "#22c55e";

                    return (
                      <div key={`${ev.at}-${i}`} style={{ display: "flex", gap: 10, marginBottom: 10, position: "relative" }}>
                        <div style={{ width: 24, height: 24, borderRadius: "50%", flexShrink: 0, background: dotBg, border: "2.5px solid white", boxShadow: `0 2px 6px ${dotBg}55`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 8, fontWeight: 800, color: "white", zIndex: 1 }}>
                          {i + 1}
                        </div>
                          <div style={{ flex: 1, background: cardBg, border: `1px solid ${cardBdr}`, borderRadius: 12, padding: "9px 11px", boxShadow: isAlert ? "0 2px 8px rgba(220,38,38,0.10)" : "none" }}>
                          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 3 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                              {isDrop ? <TrendingDown size={10} style={{ color: labelClr }} /> : <TrendingUp size={10} style={{ color: labelClr }} />}
                              <span style={{ fontSize: 9, fontWeight: 700, color: labelClr, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                                {isAlert ? "⚠ Fuel Drop Alert" : isSmallDrop ? "Fuel Drop" : "Refuel"}
                              </span>
                            </div>
                            <span style={{ fontSize: 9, color: "var(--color-text-3)" }}>{fmtTime(ev.at)}</span>
                          </div>
                          <p style={{ fontSize: 15, fontWeight: 800, color: "var(--color-text-1)", lineHeight: 1.1 }}>
                            {isDrop ? "−" : "+"}{(ev.amount ?? 0).toFixed(1)} L
                          </p>
                          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 2 }}>
                            <span style={{ fontSize: 10, color: "var(--color-text-3)" }}>
                              {(ev.fuelBefore ?? 0).toFixed(1)} → {(ev.fuelAfter ?? 0).toFixed(1)} L
                            </span>

                            {isSmallDrop && (
                              <span style={{ fontSize: 8, color: "var(--color-text-3)", fontStyle: "italic" }}>noise / consumption</span>
                            )}
                          </div>

                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Summary bar */}
            {consumption && (
              <div style={{ padding: "10px 14px", borderTop: "1px solid var(--color-bg)" }}>
                <div style={{ background: "var(--color-primary)", borderRadius: 12, padding: "11px 14px" }}>
                  <p style={{ fontSize: 9, fontWeight: 700, color: "rgba(255,255,255,0.7)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>Period Summary</p>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <div>
                      <p style={{ fontSize: 9, color: "rgba(255,255,255,0.7)" }}>Consumed</p>
                      <p style={{ fontSize: 14, fontWeight: 800, color: "white" }}>{(totalDropped ?? 0).toFixed(1)} L</p>
                    </div>
                    <div>
                      <p style={{ fontSize: 9, color: "rgba(255,255,255,0.7)" }}>Refueled</p>
                      <p style={{ fontSize: 14, fontWeight: 800, color: "white" }}>+{(totalRefueled ?? 0).toFixed(1)} L</p>
                    </div>
                 
                  </div>
                </div>
              </div>
            )}
          </div>

        </div>
      </div>
    </AppShell>
  );
}
