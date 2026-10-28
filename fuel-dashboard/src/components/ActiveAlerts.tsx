"use client";

import { AlertTriangle, TrendingUp, CheckCircle, Info } from "lucide-react";
import { VehicleSummary } from "@/lib/types";
import { AlertType, FleetAlert, buildFleetAlerts } from "@/lib/fleetAlerts";

function CardSkeleton() {
  return (
    <div className="card p-5">
      <div className="skeleton w-28 h-5 mb-4 rounded-lg" />
      {[0, 1, 2].map(i => (
        <div key={i} className="card-flat rounded-xl p-3.5 mb-2.5">
          <div className="skeleton w-16 h-4 mb-2 rounded-full" />
          <div className="skeleton w-full h-4 mb-1.5 rounded" />
          <div className="skeleton w-2/3 h-3 rounded" />
        </div>
      ))}
    </div>
  );
}

interface Props {
  vehicles: VehicleSummary[];
  loading: boolean;
  selectedImei?: string;
  onSelectImei?: (imei: string) => void;
}

export const TAG_MAP: Record<AlertType, {
  label: string;
  Icon: React.ElementType;
  iconColor: string;
  iconBg: string;
  tagStyle: React.CSSProperties;
  borderColor: string;
}> = {
  late:    {
    label: "Critical",
    Icon: AlertTriangle,
    iconColor: "#E84040",
    iconBg: "rgba(232,64,64,0.1)",
    tagStyle: { background: "rgba(232,64,64,0.1)", color: "#E84040", border: "1px solid rgba(232,64,64,0.2)" },
    borderColor: "#E84040",
  },
  warning: {
    label: "Warning",
    Icon: TrendingUp,
    iconColor: "#F59E0B",
    iconBg: "rgba(245,158,11,0.1)",
    tagStyle: { background: "rgba(245,158,11,0.1)", color: "#b45309", border: "1px solid rgba(245,158,11,0.2)" },
    borderColor: "#F59E0B",
  },
  active:  {
    label: "Active",
    Icon: CheckCircle,
    iconColor: "#22C55E",
    iconBg: "rgba(34,197,94,0.1)",
    tagStyle: { background: "rgba(34,197,94,0.1)", color: "#16a34a", border: "1px solid rgba(34,197,94,0.2)" },
    borderColor: "#22C55E",
  },
  info:    {
    label: "Info",
    Icon: Info,
    iconColor: "#3B82F6",
    iconBg: "rgba(59,130,246,0.1)",
    tagStyle: { background: "rgba(59,130,246,0.1)", color: "#1d4ed8", border: "1px solid rgba(59,130,246,0.2)" },
    borderColor: "#3B82F6",
  },
};

const AVATAR_COLORS = ["#E84040", "#3B82F6", "#22C55E", "#A855F7", "#F59E0B"];

export default function ActiveAlerts({ vehicles, loading, selectedImei, onSelectImei }: Props) {
  if (loading) return <CardSkeleton />;

  const alerts: FleetAlert[] = buildFleetAlerts(vehicles);

  if (alerts.length === 0) {
    alerts.push({ key: "none", imei: "", type: "info", title: "No active alerts", sub: "Fleet operating normally", initials: "✓", time: "" });
  }

  return (
    <div className="card p-5 anim-2">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm font-bold" style={{ color: "var(--color-text-1)" }}>Alerts &amp; Notifications</p>
        <div className="flex items-center gap-2">
          <span className="badge-count">{alerts.length}</span>
        </div>
      </div>

      <div className="flex flex-col gap-2.5">
        {alerts.slice(0, 5).map((alert, i) => {
          const t = TAG_MAP[alert.type];
          const Icon = t.Icon;
          const clickable = !!alert.imei && !!onSelectImei;
          const isSelected = !!alert.imei && alert.imei === selectedImei;
          return (
            <div
              key={alert.key}
              role={clickable ? "button" : undefined}
              tabIndex={clickable ? 0 : undefined}
              title={clickable ? "Show this vehicle on the dashboard" : undefined}
              onClick={clickable ? () => onSelectImei!(alert.imei) : undefined}
              onKeyDown={clickable ? e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelectImei!(alert.imei); } } : undefined}
              className={`rounded-xl p-3.5 transition-all${clickable ? " cursor-pointer hover:shadow-sm" : ""}`}
              style={{
                background: isSelected ? "rgba(var(--color-primary-rgb),0.04)" : "var(--color-surface-2)",
                border: "1px solid var(--color-border-soft)",
                borderLeft: `3px solid ${t.borderColor}`,
                borderRadius: 12,
              }}
            >
              {/* Top: tag + time */}
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <div
                    className="w-5 h-5 rounded-lg flex items-center justify-center"
                    style={{ background: t.iconBg }}
                  >
                    <Icon size={11} style={{ color: t.iconColor }} />
                  </div>
                  <span
                    className="text-xs font-semibold px-2 py-0.5 rounded-full"
                    style={t.tagStyle}
                  >
                    {t.label}
                  </span>
                </div>
                {alert.time && (
                  <span className="text-xs" style={{ color: "var(--color-text-3)" }}>{alert.time}</span>
                )}
              </div>

              {/* Content */}
              <p className="text-xs font-semibold leading-snug mb-1" style={{ color: "var(--color-text-1)" }}>
                {alert.title}
              </p>
              <div className="flex items-center justify-between">
                <p className="text-xs" style={{ color: "var(--color-text-3)" }}>{alert.sub}</p>
                <div
                  className="w-5 h-5 rounded-full flex items-center justify-center text-white ring-2 ring-white flex-shrink-0"
                  style={{ background: AVATAR_COLORS[i % AVATAR_COLORS.length], fontSize: "8px", fontWeight: 700 }}
                >
                  {alert.initials}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
