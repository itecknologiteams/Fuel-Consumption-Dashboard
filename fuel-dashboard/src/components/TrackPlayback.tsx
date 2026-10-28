"use client";

import { useEffect, useMemo, useState } from "react";
import { Pause, Play, Route, Gauge, Clock, ParkingCircle, Fuel } from "lucide-react";
import { TripRouteData } from "@/lib/types";
import { fmtDateTime } from "@/lib/dateUtils";

interface Props {
  track: TripRouteData;
  /** Fuel events shown on the map — ticked on the slider at their time. */
  events: Array<{ type: "drop" | "refuel"; at: string; amount: number }>;
  index: number | null;
  onIndexChange: (i: number | null) => void;
}

const SPEEDS = [1, 4, 16];
const TICK_MS = 120;

/** Index of the track point nearest `t` (points are in time order). */
function indexAt(times: number[], t: number): number {
  let lo = 0, hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < t) lo = mid + 1; else hi = mid;
  }
  return lo > 0 && Math.abs(times[lo - 1] - t) < Math.abs(times[lo] - t) ? lo - 1 : lo;
}

function fmtMinutes(min: number) {
  return min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`;
}

export default function TrackPlayback({ track, events, index, onIndexChange }: Props) {
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(4);
  const last = track.points.length - 1;
  const times = useMemo(() => track.points.map(p => new Date(p.ts).getTime()), [track]);

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      onIndexChange(Math.min(last, (index ?? 0) + speed));
    }, TICK_MS);
    return () => clearInterval(id);
  }, [playing, speed, index, last, onIndexChange]);

  // Stop at the end of the track.
  const atEnd = index !== null && index >= last;
  if (playing && atEnd) setPlaying(false);

  const p = index !== null ? track.points[index] : null;
  const ticks = useMemo(
    () => events.map(e => ({ ...e, pct: last > 0 ? (indexAt(times, new Date(e.at).getTime()) / last) * 100 : 0 })),
    [events, times, last],
  );

  const s = track.summary;
  const drops = events.filter(e => e.type === "drop").length;

  return (
    <div style={{
      position: "absolute", left: 14, right: 14, bottom: 14, zIndex: 999,
      background: "rgba(255,255,255,0.97)", backdropFilter: "blur(16px)",
      border: "1px solid var(--color-border-soft)", borderRadius: 14,
      boxShadow: "0 8px 32px rgba(0,0,0,0.14)", padding: "10px 14px",
      fontFamily: "system-ui, sans-serif",
    }}>
      {/* Summary */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 14, fontSize: 11, color: "var(--color-text-2)", marginBottom: 8 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 4 }}><Route size={12} style={{ color: "#2563EB" }} /><b>{s.distanceKm.toFixed(1)} km</b></span>
        <span style={{ display: "flex", alignItems: "center", gap: 4 }}><Clock size={12} />Driving {fmtMinutes(s.movingMinutes)}</span>
        <span style={{ display: "flex", alignItems: "center", gap: 4 }}><Gauge size={12} />Max {s.maxSpeedKmh} km/h</span>
        <span style={{ display: "flex", alignItems: "center", gap: 4 }}><ParkingCircle size={12} />{track.stops.length} stop{track.stops.length !== 1 ? "s" : ""}</span>
        {drops > 0 && <span style={{ color: "#ef4444", fontWeight: 700 }}>▼ {drops} drop{drops !== 1 ? "s" : ""} on route</span>}
        <span style={{ marginLeft: "auto", color: "var(--color-text-3)" }}>
          {s.startedAt ? fmtDateTime(s.startedAt) : "—"} → {s.endedAt ? fmtDateTime(s.endedAt) : "—"}
        </span>
      </div>

      {/* Controls */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button
          type="button"
          aria-label={playing ? "Pause playback" : "Play route"}
          onClick={() => {
            if (playing) { setPlaying(false); return; }
            if (index === null || atEnd) onIndexChange(0);
            setPlaying(true);
          }}
          style={{ width: 32, height: 32, borderRadius: 10, border: "none", background: "var(--color-primary)", color: "white", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0 }}
        >
          {playing ? <Pause size={14} /> : <Play size={14} />}
        </button>

        <div style={{ position: "relative", flex: 1, height: 24, display: "flex", alignItems: "center" }}>
          <input
            type="range"
            min={0}
            max={Math.max(0, last)}
            value={index ?? 0}
            onChange={e => { setPlaying(false); onIndexChange(Number(e.target.value)); }}
            aria-label="Route position"
            style={{ width: "100%", accentColor: "var(--color-primary)" }}
          />
          {ticks.map((t, i) => (
            <button
              key={`${t.at}-${i}`}
              type="button"
              title={`${t.type === "drop" ? "Drop −" : "Refuel +"}${t.amount.toFixed(1)} L · ${fmtDateTime(t.at)}`}
              onClick={() => { setPlaying(false); onIndexChange(indexAt(times, new Date(t.at).getTime())); }}
              style={{
                position: "absolute", left: `calc(${t.pct}% - 3px)`, top: 0, width: 6, height: 8,
                borderRadius: 2, border: "none", padding: 0, cursor: "pointer",
                background: t.type === "drop" ? "#ef4444" : "#22c55e",
              }}
            />
          ))}
        </div>

        <div style={{ display: "flex", gap: 2, flexShrink: 0 }}>
          {SPEEDS.map(x => (
            <button
              key={x}
              type="button"
              onClick={() => setSpeed(x)}
              style={{
                fontSize: 10, fontWeight: 700, padding: "4px 7px", borderRadius: 7, cursor: "pointer",
                border: `1px solid ${speed === x ? "var(--color-primary)" : "var(--color-border-input)"}`,
                background: speed === x ? "rgba(var(--color-primary-rgb),0.08)" : "white",
                color: speed === x ? "var(--color-primary)" : "var(--color-text-2)",
              }}
            >
              {x}×
            </button>
          ))}
        </div>
      </div>

      {/* Readout at the playhead */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 14, fontSize: 11, marginTop: 6, color: "var(--color-text-3)", minHeight: 16 }}>
        {p ? (
          <>
            <span><b style={{ color: "var(--color-text-1)" }}>{fmtDateTime(p.ts)}</b></span>
            <span>Speed <b style={{ color: "var(--color-text-1)" }}>{p.speed} km/h</b></span>
            {p.fuel != null && (
              <span style={{ display: "flex", alignItems: "center", gap: 3 }}>
                <Fuel size={11} />Fuel <b style={{ color: "var(--color-text-1)" }}>{p.fuel.toFixed(1)} {track.unit ?? "L"}</b>
              </span>
            )}
            <span>Ignition <b style={{ color: p.ignition ? "#16a34a" : "var(--color-text-1)" }}>{p.ignition ? "ON" : "OFF"}</b></span>
          </>
        ) : (
          <span>Press play or drag the slider to replay the route · red/green ticks are drops/refuels</span>
        )}
      </div>
    </div>
  );
}
