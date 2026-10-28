"use client";

import { useEffect, useMemo, useRef } from "react";
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { Vehicle, FuelCurrentData, TripRouteData, TripRoutePoint } from "@/lib/types";
import { fmtDateTime } from "@/lib/dateUtils";

// ── Types ────────────────────────────────────────────────────────────────────

export interface FuelEvent {
  type: "drop" | "refuel";
  at: string;
  amount: number;
  fuelAfter: number;
  fuelBefore: number;
  unit: string;
  lat?: number;
  lng?: number;
  /** True when this drop is >= 8 L AND fuel stayed low for 7 min (Python is_fake_spike check). */
  isConfirmedDrop?: boolean;
  /** Anomaly detection metadata (for refuels) */
  isAnomaly?: boolean;
  anomalyType?: string;
  anomalyReason?: string;
  anomalyConfidence?: number;
}

interface Props {
  vehicles: Vehicle[];
  selectedImei: string;
  onSelectVehicle: (imei: string) => void;
  fuelEvents: FuelEvent[];
  currentFuel?: FuelCurrentData | null;
  dropCount?: number;
  refuelCount?: number;
  /** Route history of the selected vehicle for the period. */
  track?: TripRouteData | null;
  /** Index into track.points shown by the playback marker. */
  playhead?: number | null;
}

const TRACK_COLOR = "#2563EB";

function makeLetterIcon(letter: string, color: string) {
  const html = `
    <div style="width:28px;height:28px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);
      background:${color};border:2.5px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.3);
      display:flex;align-items:center;justify-content:center;">
      <span style="transform:rotate(45deg);font-size:12px;font-weight:900;color:white;">${letter}</span>
    </div>`;
  return L.divIcon({ html, className: "", iconSize: [28, 28], iconAnchor: [14, 28] });
}

function makeStopIcon(idling: boolean) {
  const color = idling ? "#F59E0B" : "#1D4ED8";
  const html = `
    <div style="width:20px;height:20px;border-radius:5px;background:${color};border:2px solid white;
      box-shadow:0 1px 6px rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;
      font-size:11px;font-weight:900;color:white;">P</div>`;
  return L.divIcon({ html, className: "", iconSize: [20, 20], iconAnchor: [10, 10] });
}

function makeDropIcon(type: "drop" | "refuel", amount: number) {
  const isDrop = type === "drop";
  const color = isDrop ? "#ef4444" : "#22c55e";
  const html = `
    <div style="display:flex;flex-direction:column;align-items:center;">
      <div style="background:${color};color:white;font-size:10px;font-weight:800;padding:2px 6px;
        border-radius:6px;border:2px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.3);white-space:nowrap;">
        ${isDrop ? "▼ −" : "▲ +"}${amount.toFixed(1)} L
      </div>
      <div style="width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;
        border-top:6px solid ${color};"></div>
    </div>`;
  return L.divIcon({ html, className: "", iconSize: [70, 26], iconAnchor: [35, 26] });
}

const playheadIcon = L.divIcon({
  html: `<div style="width:18px;height:18px;border-radius:50%;background:#E84040;border:3px solid white;
    box-shadow:0 0 0 4px rgba(232,64,64,0.3),0 2px 8px rgba(0,0,0,0.35);"></div>`,
  className: "",
  iconSize: [18, 18],
  iconAnchor: [9, 9],
});

/** Zoom to the whole track whenever a new one loads. */
function FitTrack({ points }: { points: TripRoutePoint[] }) {
  const map = useMap();
  useEffect(() => {
    if (points.length < 2) return;
    map.fitBounds(L.latLngBounds(points.map(p => [p.lat, p.lng] as [number, number])), { padding: [50, 50] });
  }, [points, map]);
  return null;
}

/** Keep the playback marker in view while it plays. */
function FollowPlayhead({ point }: { point: TripRoutePoint | null }) {
  const map = useMap();
  useEffect(() => {
    if (!point) return;
    if (!map.getBounds().pad(-0.1).contains([point.lat, point.lng])) {
      map.panTo([point.lat, point.lng], { animate: true, duration: 0.3 });
    }
  }, [point, map]);
  return null;
}

// ── Fix leaflet default icon (broken in Next.js) ─────────────────────────────

function fixLeafletIcons() {
  // @ts-ignore
  delete L.Icon.Default.prototype._getIconUrl;
  L.Icon.Default.mergeOptions({
    iconUrl:       "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
    iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
    shadowUrl:     "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
  });
}

// ── Fuel level helpers ────────────────────────────────────────────────────────

function fuelColor(pct: number) {
  if (pct > 60) return "#22c55e";
  if (pct > 30) return "#f59e0b";
  return "#ef4444";
}

// ── Custom SVG truck icon ─────────────────────────────────────────────────────
// fuelPct: 0-100, shows a colored arc ring around the icon
// dropCount: shows a red badge on top-right

function makeTruckIcon(
  color: string,
  size: number,
  label?: string,
  fuelPct?: number,
  dropCount?: number,
) {
  const s = size;
  const ringSize  = s + 16;
  const cx        = ringSize / 2;
  const r         = (ringSize - 6) / 2;
  const circ      = 2 * Math.PI * r;
  const filled    = fuelPct !== undefined ? Math.max(0, Math.min(1, fuelPct / 100)) * circ : 0;
  const ringColor = fuelPct !== undefined ? fuelColor(fuelPct) : "transparent";

  const svgRing = fuelPct !== undefined ? `
    <svg style="position:absolute;top:-8px;left:-8px;pointer-events:none;"
         width="${ringSize}" height="${ringSize}" viewBox="0 0 ${ringSize} ${ringSize}">
      <circle cx="${cx}" cy="${cx}" r="${r}"
        fill="none" stroke="rgba(0,0,0,0.08)" stroke-width="4"/>
      <circle cx="${cx}" cy="${cx}" r="${r}"
        fill="none" stroke="${ringColor}" stroke-width="4"
        stroke-dasharray="${filled.toFixed(2)} ${(circ - filled).toFixed(2)}"
        stroke-linecap="round"
        transform="rotate(-90 ${cx} ${cx})"/>
    </svg>` : "";

  const badge = dropCount && dropCount > 0 ? `
    <div style="position:absolute;top:-5px;right:-5px;min-width:16px;height:16px;padding:0 3px;
      border-radius:8px;background:#ef4444;border:1.5px solid white;color:white;
      font-size:8px;font-weight:900;display:flex;align-items:center;justify-content:center;
      box-shadow:0 1px 4px rgba(239,68,68,0.5);">
      ${dropCount > 99 ? "99+" : dropCount}
    </div>` : "";

  const fuelBadge = fuelPct !== undefined && isFinite(fuelPct) ? `
    <div style="
      margin-top:2px;font-size:8px;font-weight:800;color:${ringColor};
      background:white;border:1px solid ${ringColor};padding:1px 5px;
      border-radius:5px;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,0.12);">
      ${fuelPct.toFixed(0)}% fuel
    </div>` : "";

  const html = `
    <div style="display:flex;flex-direction:column;align-items:center;cursor:pointer;">
      <div style="position:relative;">
        ${svgRing}
        ${badge}
        <div style="
          width:${s}px;height:${s}px;border-radius:${Math.round(s * 0.28)}px;
          background:${color};border:3px solid white;
          box-shadow:0 4px 14px rgba(0,0,0,0.28);
          display:flex;align-items:center;justify-content:center;">
          <svg width="${Math.round(s*0.44)}" height="${Math.round(s*0.44)}" viewBox="0 0 24 24" fill="none">
            <path d="M20 8h-3V4H3c-1.1 0-2 .9-2 2v11h2c0 1.66 1.34 3 3 3s3-1.34
              3-3h6c0 1.66 1.34 3 3 3s3-1.34 3-3h2v-5l-3-4zM6 18.5c-.83 0-1.5-.67
              -1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm13.5-9l1.96
              2.5H17V9.5h2.5zm-1.5 9c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67
              1.5 1.5-.67 1.5-1.5 1.5z" fill="white"/>
          </svg>
        </div>
      </div>
      ${label ? `
        <div style="
          margin-top:3px;background:#1A1A2E;color:white;
          font-size:9px;font-weight:700;padding:2px 7px;
          border-radius:5px;white-space:nowrap;
          box-shadow:0 2px 6px rgba(0,0,0,0.2);">${label}</div>` : ""}
      ${fuelBadge}
      <div style="width:0;height:0;border-left:5px solid transparent;
        border-right:5px solid transparent;
        border-top:7px solid ${color};margin-top:-1px;"></div>
    </div>`;

  const totalH = s + (label ? 18 : 0) + (fuelPct !== undefined ? 16 : 0) + 10;
  return L.divIcon({
    html,
    className: "",
    iconSize:  [s, totalH],
    iconAnchor:[s / 2, totalH],
  });
}

// ── Auto-fit bounds ───────────────────────────────────────────────────────────

function FitBounds({ vehicles }: { vehicles: Vehicle[] }) {
  const map = useMap();
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current || vehicles.length === 0) return;
    const valid = vehicles.filter(v => v.lat && v.lng);
    if (!valid.length) return;
    const bounds = L.latLngBounds(valid.map(v => [v.lat, v.lng] as [number, number]));
    map.fitBounds(bounds, { padding: [60, 60] });
    fitted.current = true;
  }, [vehicles, map]);
  return null;
}

// ── Pan to selected vehicle ───────────────────────────────────────────────────

function PanToSelected({ imei, vehicles }: { imei: string; vehicles: Vehicle[] }) {
  const map = useMap();
  useEffect(() => {
    const v = vehicles.find(v => v.imei === imei);
    if (v?.lat && v?.lng) map.panTo([v.lat, v.lng], { animate: true, duration: 0.6 });
  }, [imei, vehicles, map]);
  return null;
}

// ── Popup helpers ─────────────────────────────────────────────────────────────

const fmtTime = (iso: string) => fmtDateTime(iso);

// ── Fuel events list (shown in popup when events have no GPS coords) ──────────

function FuelEventsList({ events }: { events: FuelEvent[] }) {
  if (events.length === 0) return (
    <p style={{ fontSize: 11, color: "var(--color-text-3)", marginTop: 6 }}>No fuel events in this period.</p>
  );
  return (
    <div style={{ maxHeight: 200, overflowY: "auto", marginTop: 8 }}>
      {events.map((ev, i) => {
        const isDrop = ev.type === "drop";
        const col = isDrop ? "#ef4444" : "#22c55e";
        return (
          <div key={`${ev.at}-${i}`} style={{ display: "flex", alignItems: "flex-start", gap: 8, paddingBottom: 8, marginBottom: 8, borderBottom: i < events.length - 1 ? "1px solid #F5F5F5" : "none" }}>
            <div style={{ width: 18, height: 18, borderRadius: "50%", background: col, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 7, fontWeight: 800, color: "white", flexShrink: 0, marginTop: 1 }}>
              {i + 1}
            </div>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 2 }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: col }}>{isDrop ? "▼ Drop" : "▲ Refuel"}</span>
                <span style={{ fontSize: 12, fontWeight: 800, color: "var(--color-text-1)" }}>{isDrop ? "−" : "+"}{(ev.amount ?? 0).toFixed(1)} L</span>
              </div>
              <p style={{ fontSize: 10, color: "var(--color-text-3)" }}>{(ev.fuelBefore ?? 0).toFixed(1)} → {(ev.fuelAfter ?? 0).toFixed(1)} L · {fmtTime(ev.at)}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function RouteMap({
  vehicles, selectedImei, onSelectVehicle, fuelEvents,
  currentFuel, dropCount = 0, refuelCount = 0, track, playhead,
}: Props) {
  useEffect(() => { fixLeafletIcons(); }, []);

  // Track split where the tracker went silent: solid where the path is
  // known, a dashed link across each gap.
  const trackPoints = useMemo(() => track?.points ?? [], [track]);
  const { segments, gapLinks } = useMemo(() => {
    const segs: [number, number][][] = [];
    const links: [number, number][][] = [];
    for (let i = 0; i < trackPoints.length; i++) {
      const p = trackPoints[i];
      if (i === 0 || p.gap) {
        if (i > 0) links.push([[trackPoints[i - 1].lat, trackPoints[i - 1].lng], [p.lat, p.lng]]);
        segs.push([]);
      }
      segs[segs.length - 1].push([p.lat, p.lng]);
    }
    return { segments: segs, gapLinks: links };
  }, [trackPoints]);
  const playPoint = playhead != null ? trackPoints[playhead] ?? null : null;

  const center: [number, number] = vehicles[0]?.lat
    ? [vehicles[0].lat, vehicles[0].lng]
    : [24.8607, 67.0011]; // Karachi fallback

  const selected = vehicles.find(v => v.imei === selectedImei);

  // Estimate fuel % from current fuel vs max observed fuelBefore in events.
  // Guard against NaN: Math.max with NaN args returns NaN; currentFuel.fuel
  // can be undefined/null when no sensor data, making the division produce NaN.
  const maxObserved = fuelEvents.reduce(
    (m, e) => Math.max(m, isFinite(e.fuelBefore) ? e.fuelBefore : 0, isFinite(e.fuelAfter) ? e.fuelAfter : 0),
    0,
  );
  const estimatedCapacity = maxObserved > 0 ? maxObserved * 1.1 : 200;
  const rawFuel = currentFuel?.fuel;
  const fuelPct =
    rawFuel != null && isFinite(rawFuel) && estimatedCapacity > 0
      ? Math.min(100, Math.max(0, (rawFuel / estimatedCapacity) * 100))
      : undefined;

  return (
    <MapContainer
      center={center}
      zoom={13}
      style={{ width: "100%", height: "100%" }}
      zoomControl
    >
      <TileLayer
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        maxZoom={19}
      />

      <FitBounds vehicles={vehicles} />
      <PanToSelected imei={selectedImei} vehicles={vehicles} />
      <FitTrack points={trackPoints} />
      <FollowPlayhead point={playPoint} />

      {/* ── Route history track ─────────────────────────────────────── */}
      {gapLinks.map((pos, i) => (
        <Polyline key={`gap-${i}`} positions={pos}
          pathOptions={{ color: "#94A3B8", weight: 2, opacity: 0.8, dashArray: "6 6" }} />
      ))}
      {segments.map((pos, i) => (
        <Polyline key={`seg-${i}`} positions={pos}
          pathOptions={{ color: TRACK_COLOR, weight: 4, opacity: 0.85, lineJoin: "round" }} />
      ))}

      {track?.summary.start && trackPoints.length > 0 && (
        <Marker position={[track.summary.start.lat, track.summary.start.lng]} icon={makeLetterIcon("A", "#16a34a")} zIndexOffset={600}>
          <Popup><b>Start</b><br />{fmtTime(track.summary.startedAt ?? "")}</Popup>
        </Marker>
      )}
      {track?.summary.end && trackPoints.length > 0 && (
        <Marker position={[track.summary.end.lat, track.summary.end.lng]} icon={makeLetterIcon("B", "#1A1A2E")} zIndexOffset={600}>
          <Popup><b>End</b><br />{fmtTime(track.summary.endedAt ?? "")}</Popup>
        </Marker>
      )}

      {track?.stops.map((s, i) => {
        const idling = s.ignitionOnPct >= 50;
        return (
          <Marker key={`stop-${s.from}-${i}`} position={[s.lat, s.lng]} icon={makeStopIcon(idling)} zIndexOffset={400}>
            <Popup>
              <div style={{ minWidth: 180, fontFamily: "system-ui, sans-serif" }}>
                <p style={{ fontSize: 12, fontWeight: 700, marginBottom: 4 }}>
                  {idling ? "Stop · engine idling" : "Stop · parked"}
                </p>
                <p style={{ fontSize: 11, color: "var(--color-text-3)" }}>
                  {fmtTime(s.from)} → {fmtTime(s.to)}
                </p>
                <p style={{ fontSize: 11, marginTop: 2 }}>
                  Duration: <b>{s.durationMin >= 60 ? `${Math.floor(s.durationMin / 60)} h ${s.durationMin % 60} min` : `${s.durationMin} min`}</b>
                  {" · "}ignition on {s.ignitionOnPct}%
                </p>
                {s.fuelStart != null && s.fuelEnd != null && (
                  <p style={{ fontSize: 11, marginTop: 2 }}>
                    Fuel: {s.fuelStart.toFixed(1)} → <b>{s.fuelEnd.toFixed(1)} L</b>
                    {Math.abs(s.fuelEnd - s.fuelStart) >= 1 && (
                      <span style={{ color: s.fuelEnd < s.fuelStart ? "#ef4444" : "#16a34a", fontWeight: 700 }}>
                        {" "}({s.fuelEnd < s.fuelStart ? "−" : "+"}{Math.abs(s.fuelEnd - s.fuelStart).toFixed(1)} L)
                      </span>
                    )}
                  </p>
                )}
              </div>
            </Popup>
          </Marker>
        );
      })}

      {playPoint && (
        <Marker position={[playPoint.lat, playPoint.lng]} icon={playheadIcon} zIndexOffset={2000} />
      )}

      {/* ── Vehicle markers ────────────────────────────────────────────── */}
      {vehicles.filter(v => v.lat && v.lng).map(v => {
        const isSelected = v.imei === selectedImei;
        const baseColor  = isSelected ? "#E84040" : v.status === "online" ? "#22c55e" : "#6B7280";

        // Only selected vehicle gets the fuel ring + drop badge
        const icon = makeTruckIcon(
          baseColor,
          isSelected ? 44 : 34,
          isSelected ? v.name : undefined,
          isSelected ? fuelPct : undefined,
          isSelected ? dropCount : undefined,
        );

        const hasGpsEvents  = fuelEvents.some(e => e.lat != null && e.lng != null);
        const vehicleEvents = isSelected ? fuelEvents : [];

        return (
          <Marker
            key={v.imei}
            position={[v.lat, v.lng]}
            icon={icon}
            eventHandlers={{ click: () => onSelectVehicle(v.imei) }}
            zIndexOffset={isSelected ? 1000 : 0}
          >
            <Popup maxWidth={300}>
              <div style={{ minWidth: 240, fontFamily: "system-ui, sans-serif" }}>

                {/* Header */}
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                  <div style={{ width: 36, height: 36, borderRadius: 10, background: baseColor, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                      <path d="M20 8h-3V4H3c-1.1 0-2 .9-2 2v11h2c0 1.66 1.34 3 3 3s3-1.34 3-3h6c0 1.66 1.34 3 3 3s3-1.34 3-3h2v-5l-3-4zM6 18.5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm13.5-9l1.96 2.5H17V9.5h2.5zm-1.5 9c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z" fill="white"/>
                    </svg>
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ fontWeight: 700, fontSize: 14, color: "var(--color-text-1)" }}>{v.name}</p>
                    <p style={{ fontSize: 10, color: "var(--color-text-3)" }}>{v.plateNumber} · {v.model || v.device}</p>
                  </div>
                  <span style={{ fontSize: 9, fontWeight: 700, padding: "3px 8px", borderRadius: 12, flexShrink: 0, background: v.status === "online" ? "rgba(34,197,94,0.1)" : "rgba(107,114,128,0.1)", color: v.status === "online" ? "#16a34a" : "var(--color-text-2)" }}>
                    {v.status === "online" ? "● Online" : "● Offline"}
                  </span>
                </div>

                {/* Fuel level bar (selected vehicle only) */}
                {isSelected && currentFuel && (
                  <div style={{ background: "#F9F9F9", borderRadius: 10, padding: "8px 10px", marginBottom: 8 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                      <span style={{ fontSize: 10, fontWeight: 600, color: "var(--color-text-3)" }}>Current Fuel Level</span>
                      <span style={{ fontSize: 12, fontWeight: 800, color: fuelColor(fuelPct ?? 0) }}>
                        {(currentFuel.fuel ?? 0).toFixed(1)} L
                      </span>
                    </div>
                    <div style={{ height: 6, background: "var(--color-border-input)", borderRadius: 3, overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${fuelPct ?? 0}%`, background: fuelColor(fuelPct ?? 0), borderRadius: 3, transition: "width 0.4s" }} />
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", marginTop: 3 }}>
                      <span style={{ fontSize: 9, color: "#D1D5DB" }}>0 L</span>
                      <span style={{ fontSize: 9, color: "#D1D5DB" }}>{(estimatedCapacity ?? 200).toFixed(0)} L est. cap.</span>
                    </div>
                  </div>
                )}

                {/* Status chips */}
                <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
                  {v.speed > 0 && (
                    <span style={{ fontSize: 10, fontWeight: 600, padding: "2px 8px", borderRadius: 12, background: "rgba(var(--color-primary-rgb), 0.08)", color: "var(--color-primary)" }}>
                      🚀 {v.speed} km/h
                    </span>
                  )}
                  {currentFuel && currentFuel.speed === 0 && (
                    <span style={{ fontSize: 10, fontWeight: 600, padding: "2px 8px", borderRadius: 12, background: "var(--color-bg)", color: "var(--color-text-3)" }}>
                      Parked
                    </span>
                  )}
                  {isSelected && dropCount > 0 && (
                    <span style={{ fontSize: 10, fontWeight: 600, padding: "2px 8px", borderRadius: 12, background: "rgba(239,68,68,0.08)", color: "#ef4444" }}>
                      ▼ {dropCount} drops
                    </span>
                  )}
                  {isSelected && refuelCount > 0 && (
                    <span style={{ fontSize: 10, fontWeight: 600, padding: "2px 8px", borderRadius: 12, background: "rgba(34,197,94,0.08)", color: "#22c55e" }}>
                      ▲ {refuelCount} refuels
                    </span>
                  )}
                </div>

                {/* GPS coords */}
                <p style={{ fontSize: 9, color: "#D1D5DB", marginBottom: 6 }}>
                  📍 {(v.lat ?? 0).toFixed(5)}, {(v.lng ?? 0).toFixed(5)}
                </p>

                {/* Last seen */}
                <p style={{ fontSize: 10, color: "var(--color-text-3)", marginBottom: 8 }}>
                  Last seen: {fmtTime(v.lastSeen)}
                </p>

                {/* Fuel events in popup (only when no GPS on events) */}
                {isSelected && vehicleEvents.length > 0 && !hasGpsEvents && (
                  <>
                    <div style={{ borderTop: "1px solid #F0F0F0", paddingTop: 8, marginTop: 4 }}>
                      <p style={{ fontSize: 10, fontWeight: 700, color: "var(--color-text-3)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>
                        Fuel Events · {vehicleEvents.length} total
                      </p>
                    </div>
                    <FuelEventsList events={vehicleEvents} />
                  </>
                )}

                {!isSelected && (
                  <button onClick={() => onSelectVehicle(v.imei)} style={{ width: "100%", background: "var(--color-primary)", color: "white", border: "none", borderRadius: 8, padding: "7px 0", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
                    Select &amp; View Fuel Events
                  </button>
                )}
              </div>
            </Popup>
          </Marker>
        );
      })}

      {/* ── Fuel event markers (GPS-tagged only) ───────────────────────── */}
      {selected && fuelEvents
        .filter(ev => ev.lat != null && ev.lng != null)
        .map((ev, i) => {
          const isDrop = ev.type === "drop";
          const col  = isDrop ? "#ef4444" : "#22c55e";
          return (
            <Marker
              key={`gps-${ev.type}-${ev.at}-${i}`}
              position={[ev.lat!, ev.lng!]}
              icon={makeDropIcon(ev.type, ev.amount ?? 0)}
              zIndexOffset={isDrop ? 900 : 800}
            >
              <Popup>
                <div style={{ minWidth: 170, fontFamily: "system-ui, sans-serif" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                    <div style={{ width: 8, height: 8, borderRadius: "50%", background: col }} />
                    <span style={{ fontSize: 11, fontWeight: 700, color: col }}>{isDrop ? "Fuel Drop" : "Refuel"}</span>
                  </div>
                  <p style={{ fontSize: 18, fontWeight: 800, color: "var(--color-text-1)", lineHeight: 1.1, marginBottom: 4 }}>
                    {isDrop ? "−" : "+"}{(ev.amount ?? 0).toFixed(1)} L
                  </p>
                  <p style={{ fontSize: 11, color: "var(--color-text-3)" }}>
                    Before: <b>{(ev.fuelBefore ?? 0).toFixed(1)} L</b> → After: <b>{(ev.fuelAfter ?? 0).toFixed(1)} L</b>
                  </p>
                  <p style={{ fontSize: 11, color: "var(--color-text-3)", marginTop: 4 }}>{fmtTime(ev.at)}</p>
                </div>
              </Popup>
            </Marker>
          );
        })}
    </MapContainer>
  );
}
