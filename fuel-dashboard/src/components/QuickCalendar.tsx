"use client";

import { ChevronLeft, ChevronRight, CalendarDays, Loader2, Droplets, TrendingDown } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { getFuelConsumption } from "@/lib/api";
import { ApiError, FuelConsumptionData } from "@/lib/types";
import { fmtTime, toLocalMidnight } from "@/lib/dateUtils";

const DAYS   = ["Su","Mo","Tu","We","Th","Fr","Sa"];
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

interface DayEvent {
  kind: "refuel" | "drop";
  at: string;
  litres: number;
}

interface Props {
  token: string | null;
  imei: string;
  vehicleName?: string;
  /** Dashboard range — its days are highlighted. */
  from: string;
  to: string;
  /** Load the whole dashboard for this local day. */
  onSelectDay: (day: Date) => void;
}

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

export default function QuickCalendar({ token, imei, vehicleName, from, to, onSelectDay }: Props) {
  const now = new Date();
  const [vm, setVm] = useState(now.getMonth());
  const [vy, setVy] = useState(now.getFullYear());
  // Result of the last month fetch, tagged with what it was fetched for.
  const [result, setResult] = useState<{ key: string; data: FuelConsumptionData | null; failed: boolean }>(
    { key: "", data: null, failed: false });

  const prevMonth = () => { if (vm === 0) { setVm(11); setVy(y => y-1); } else setVm(m => m-1); };
  const nextMonth = () => { if (vm === 11) { setVm(0); setVy(y => y+1); } else setVm(m => m+1); };

  // Follow the dashboard range into its month when it's picked elsewhere (header date picker).
  const rangeStart = useMemo(() => toLocalMidnight(from), [from]);
  const [followedFrom, setFollowedFrom] = useState(from);
  if (followedFrom !== from) {
    setFollowedFrom(from);
    setVm(rangeStart.getMonth());
    setVy(rangeStart.getFullYear());
  }

  const isFutureMonth = new Date(vy, vm, 1) > now;
  const requestKey = `${imei}:${vy}-${vm}`;

  // Refuels and confirmed drops for the month on screen.
  useEffect(() => {
    if (!token || !imei || isFutureMonth) return;
    const monthStart = new Date(vy, vm, 1);
    const monthEnd = new Date(Math.min(new Date(vy, vm + 1, 1).getTime() - 1, Date.now()));

    let cancelled = false;
    getFuelConsumption(token, imei, monthStart.toISOString(), monthEnd.toISOString())
      .then(data => { if (!cancelled) setResult({ key: requestKey, data, failed: false }); })
      // 404 = no tracking data that month: an empty month, not a failure.
      .catch(e => { if (!cancelled) setResult({ key: requestKey, data: null, failed: !(e instanceof ApiError && e.statusCode === 404) }); });
    return () => { cancelled = true; };
  }, [token, imei, vm, vy, isFutureMonth, requestKey]);

  const isCurrentResult = !isFutureMonth && result.key === requestKey;
  const loading    = !isFutureMonth && !!imei && !isCurrentResult;
  const shownData  = isCurrentResult ? result.data : null;
  const failedLoad = isCurrentResult && result.failed;

  const eventsByDay = useMemo(() => {
    const map = new Map<string, DayEvent[]>();
    const add = (ev: DayEvent) => {
      const k = dayKey(new Date(ev.at));
      map.set(k, [...(map.get(k) ?? []), ev]);
    };
    shownData?.refuels?.filter(r => r.isVerified !== false)
      .forEach(r => add({ kind: "refuel", at: r.at, litres: r.added }));
    shownData?.drops?.filter(d => d.isConfirmedDrop)
      .forEach(d => add({ kind: "drop", at: d.at, litres: d.consumed }));
    map.forEach(list => list.sort((a, b) => a.at.localeCompare(b.at)));
    return map;
  }, [shownData]);

  const daysInMonth = new Date(vy, vm+1, 0).getDate();
  const firstDay    = new Date(vy, vm, 1).getDay();
  const isCurrent   = vm === now.getMonth() && vy === now.getFullYear();
  const cells: (number|null)[] = [...Array(firstDay).fill(null), ...Array.from({length: daysInMonth}, (_,i) => i+1)];

  const rangeEnd   = toLocalMidnight(to);
  const today      = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const singleDay  = rangeStart.getTime() === rangeEnd.getTime();
  const focusEvents = singleDay ? eventsByDay.get(dayKey(rangeStart)) ?? [] : [];
  const focusInView = rangeStart.getMonth() === vm && rangeStart.getFullYear() === vy;

  const monthRefuels = [...eventsByDay.values()].flat().filter(e => e.kind === "refuel").length;
  const monthDrops   = [...eventsByDay.values()].flat().filter(e => e.kind === "drop").length;

  return (
    <div className="card p-5 anim-3">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <CalendarDays size={15} style={{ color: "var(--color-primary)" }} />
          <span className="text-sm font-bold" style={{ color: "var(--color-text-1)" }}>{MONTHS[vm]} {vy}</span>
          {loading && <Loader2 size={13} className="animate-spin" style={{ color: "var(--color-text-3)" }} />}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={prevMonth}
            aria-label="Previous month"
            className="w-7 h-7 flex items-center justify-center rounded-lg transition-colors"
            style={{ background: "var(--color-bg)", border: "1px solid var(--color-border-input)" }}
          >
            <ChevronLeft size={13} style={{ color: "var(--color-text-2)" }} />
          </button>
          <button
            onClick={nextMonth}
            aria-label="Next month"
            className="w-7 h-7 flex items-center justify-center rounded-lg transition-colors"
            style={{ background: "var(--color-bg)", border: "1px solid var(--color-border-input)" }}
          >
            <ChevronRight size={13} style={{ color: "var(--color-text-2)" }} />
          </button>
        </div>
      </div>

      {/* Day headers */}
      <div className="grid grid-cols-7 mb-1">
        {DAYS.map(d => (
          <div key={d} className="text-center text-xs font-semibold py-1" style={{ color: "var(--color-text-3)" }}>{d}</div>
        ))}
      </div>

      {/* Cells */}
      <div className="grid grid-cols-7 gap-y-1">
        {cells.map((day, i) => {
          if (!day) return <div key={i} />;
          const date     = new Date(vy, vm, day);
          const isToday  = isCurrent && day === now.getDate();
          const isFuture = date > today;
          const inRange  = date >= rangeStart && date <= rangeEnd;
          const events   = eventsByDay.get(dayKey(date)) ?? [];
          const hasRefuel = events.some(e => e.kind === "refuel");
          const hasDrop   = events.some(e => e.kind === "drop");
          return (
            <div key={i} className="flex flex-col items-center">
              <button
                disabled={isFuture}
                onClick={() => onSelectDay(date)}
                title={isFuture ? undefined : `Show ${MONTHS[vm]} ${day}`}
                className="w-8 h-8 rounded-lg text-xs font-medium transition-all"
                style={{
                  background: inRange ? "var(--color-primary)" : "transparent",
                  color: inRange ? "#FFF" : isFuture ? "#D1D5DB" : isToday ? "var(--color-primary)" : "var(--color-text-1)",
                  border: isToday && !inRange ? "1.5px solid var(--color-primary)" : "1.5px solid transparent",
                  boxShadow: inRange ? "0 4px 12px rgba(var(--color-primary-rgb), 0.3)" : "none",
                  fontWeight: inRange || isToday ? 700 : 500,
                  cursor: isFuture ? "default" : "pointer",
                }}
              >
                {day}
              </button>
              <div className="flex gap-0.5 h-1 mt-0.5">
                {hasRefuel && <div className="w-1 h-1 rounded-full" style={{ background: "#3B82F6" }} />}
                {hasDrop   && <div className="w-1 h-1 rounded-full" style={{ background: "var(--color-primary)" }} />}
              </div>
            </div>
          );
        })}
      </div>

      {/* Legend */}
      <div className="flex items-center gap-3 mt-3 text-xs" style={{ color: "var(--color-text-3)" }}>
        <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full" style={{ background: "#3B82F6" }} />Refuel</span>
        <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full" style={{ background: "var(--color-primary)" }} />Fuel drop</span>
        <span className="ml-auto">
          {failedLoad ? "Couldn't load events" : !imei ? "No vehicle selected" : `${monthRefuels} refuel${monthRefuels !== 1 ? "s" : ""} · ${monthDrops} drop${monthDrops !== 1 ? "s" : ""} this month`}
        </span>
      </div>

      {/* Selected day */}
      <div
        className="mt-3 rounded-xl p-3.5 flex gap-3"
        style={{ background: "rgba(var(--color-primary-rgb), 0.05)", border: "1px solid rgba(var(--color-primary-rgb), 0.15)" }}
      >
        <div className="w-1.5 rounded-full flex-shrink-0" style={{ background: "var(--color-primary)" }} />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold" style={{ color: "var(--color-text-1)" }}>
            {singleDay
              ? `${rangeStart.getTime() === today.getTime() ? "Today" : `${MONTHS[rangeStart.getMonth()].slice(0, 3)} ${rangeStart.getDate()}`}${vehicleName ? ` · ${vehicleName}` : ""}`
              : `${MONTHS[rangeStart.getMonth()].slice(0, 3)} ${rangeStart.getDate()} – ${MONTHS[rangeEnd.getMonth()].slice(0, 3)} ${rangeEnd.getDate()}`}
          </p>
          {!singleDay ? (
            <p className="text-xs mt-0.5" style={{ color: "var(--color-text-3)" }}>Click a day to see its fuel events</p>
          ) : !focusInView ? (
            <p className="text-xs mt-0.5" style={{ color: "var(--color-text-3)" }}>Selected day is in another month</p>
          ) : focusEvents.length === 0 ? (
            <p className="text-xs mt-0.5" style={{ color: "var(--color-text-3)" }}>
              {loading ? "Loading events…" : "No refuels or fuel drops on this day"}
            </p>
          ) : (
            <div className="flex flex-col gap-1 mt-1">
              {focusEvents.slice(0, 3).map((e, i) => (
                <p key={i} className="text-xs flex items-center gap-1.5" style={{ color: "var(--color-text-2)" }}>
                  {e.kind === "refuel"
                    ? <Droplets size={11} style={{ color: "#3B82F6" }} />
                    : <TrendingDown size={11} style={{ color: "var(--color-primary)" }} />}
                  {e.kind === "refuel" ? `Refuel +${e.litres.toFixed(1)} L` : `Drop −${e.litres.toFixed(1)} L`}
                  <span style={{ color: "var(--color-text-3)" }}>· {fmtTime(e.at)}</span>
                </p>
              ))}
              {focusEvents.length > 3 && (
                <p className="text-xs" style={{ color: "var(--color-text-3)" }}>+{focusEvents.length - 3} more</p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
