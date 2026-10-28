import { VehicleSummary } from "@/lib/types";
import { fmtTime, fmtDateShort } from "@/lib/dateUtils";

export type AlertType = "late" | "warning" | "active" | "info";

export interface FleetAlert {
  /** Stable per vehicle + condition, so "seen" survives a refetch. */
  key: string;
  imei: string;
  type: AlertType;
  title: string;
  sub: string;
  initials: string;
  time: string;
}

const LOW_FUEL_LITRES = 10;
const HIGH_CONSUMPTION_LITRES = 50;

/** One alert per vehicle, worst condition first. Shared by the alerts panel and the header bell. */
export function buildFleetAlerts(vehicles: VehicleSummary[]): FleetAlert[] {
  return vehicles.map((v) => {
    const name = v.name || v.plateNumber || "Unnamed";
    const initials = name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
    const time = fmtTime(v.lastSeen);
    const plate = v.plateNumber ? ` · ${v.plateNumber}` : "";
    const base = { imei: v.imei, initials, time };

    if (v.status === "offline") {
      return { ...base, key: `${v.imei}:offline`, type: "late" as const,
        title: `${name} is offline`, sub: `Last: ${fmtDateShort(v.lastSeen)}` };
    }
    if ((v.currentFuel ?? 0) < LOW_FUEL_LITRES) {
      return { ...base, key: `${v.imei}:low-fuel`, type: "warning" as const,
        title: `Low fuel — ${name}`, sub: `${(v.currentFuel ?? 0).toFixed(1)} L${plate}` };
    }
    if ((v.consumed ?? 0) > HIGH_CONSUMPTION_LITRES) {
      return { ...base, key: `${v.imei}:high-consumption`, type: "warning" as const,
        title: `High consumption — ${name}`,
        sub: `${(v.consumed ?? 0).toFixed(1)} L · Rs ${(v.cost ?? 0).toLocaleString()}` };
    }
    return { ...base, key: `${v.imei}:normal`, type: "active" as const,
      title: `${name} normal`, sub: `${(v.consumed ?? 0).toFixed(1)} L used${plate}` };
  });
}

/** Alerts that need attention — what the bell counts. */
export function actionableAlerts(alerts: FleetAlert[]): FleetAlert[] {
  return alerts.filter(a => a.type === "late" || a.type === "warning");
}
