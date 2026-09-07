// ─── Auth ──────────────────────────────────────────────────────────────────

export interface LoginResponse {
  token: string;
  expiresIn: string;
}

// ─── Vehicles ──────────────────────────────────────────────────────────────

export interface Vehicle {
  imei: string;
  name: string;
  plateNumber: string;
  speed: number;
  lat: number;
  lng: number;
  lastSeen: string;
  status: "online" | "offline";
  device: string;
  model: string;
  simNumber: string;
}

export interface VehiclesResponse {
  count: number;
  vehicles: Vehicle[];
}

// ─── Fuel sensors ──────────────────────────────────────────────────────────

export interface FuelSensor {
  sensorId: number;
  name: string;
  type: string;
  param: string;
  units: string;
  formula: string | null;
  hasCalibration: boolean;
}

export interface FuelSensorsData {
  imei: string;
  count: number;
  sensors: FuelSensor[];
}

// ─── Fuel current ──────────────────────────────────────────────────────────

export interface FuelCurrentData {
  imei: string;
  fuel: number;
  unit: string;
  method: string;
  lastSeen: string;
  speed: number;
  lat: number;
  lng: number;
  ignitionOn?: boolean;
}

// ─── Fuel history ──────────────────────────────────────────────────────────

export type Interval = "1min" | "5min" | "15min" | "hour" | "day";

export interface FuelBucket {
  dt: string;
  fuel: number;
  unit: string;
  /**
   * Vehicle speed (km/h) at the reading this bucket was taken from. Lets
   * client-side detection apply the stationary (3 L) event threshold instead
   * of the moving (8 L) one. Optional — responses from an older backend omit it.
   */
  speed?: number;
}

export interface FuelHistoryData {
  imei: string;
  from: string;
  to: string;
  interval: Interval;
  unit: string;
  samples: number;
  buckets: FuelBucket[];
}

// ─── Shared drop / refuel detail ───────────────────────────────────────────

export interface FuelDropDetail {
  at: string;
  fuelBefore: number;
  fuelAfter: number;
  consumed: number;
  unit: string;
  /** True when the single-reading drop exceeds 2 L — likely sensor glitch. */
  isSensorJump?: boolean;
  /**
   * True when ALL conditions pass (mirrors Python is_fake_spike()):
   *   1. consumed >= 8 L (DROP_ALERT_THRESHOLD)
   *   2. Fuel did NOT recover within ±7 minutes (SPIKE_WINDOW_MINUTES)
   * Only these events are shown as "Fuel Drop Alert" in the UI.
   */
  isConfirmedDrop?: boolean;
}

export interface FuelRefuelAnomaly {
  isAnomaly: boolean;
  anomalyType:
    | 'fake_spike'
    | 'sensor_reset'
    | 'unsustained_rise'
    | 'movement_during_refuel'
    | 'no_stationary_period'
    | 'voltage_glitch'
    | 'none';
  confidence: number;
  reason: string;
  details: {
    fuelBefore: number;
    peakFuel: number;
    fuelAfterWindow: number;
    hadMovementAfter: boolean;
    maxSpeedDuring: number;
    maxSpeedAfter: number;
    sustainedMinutes: number;
    fallbackAmount: number;
  };
}

export interface FuelRefuelDetail {
  at: string;
  fuelBefore: number;
  fuelAfter: number;
  added: number;
  unit: string;
  /** Anomaly detection metadata (added by FuelAnomalyMiddleware) */
  _anomaly?: FuelRefuelAnomaly;
  /** True if the refuel passed all anomaly checks */
  isVerified?: boolean;
  /** Reliability score (0-100) based on confidence */
  reliabilityScore?: number;
}

export interface AnomalyMetadata {
  summary: {
    total: number;
    verified: number;
    anomalous: number;
    byType: Record<string, number>;
  };
  detectionVersion: string;
  checkedAt: string;
}

// ─── Python-confirmed drop alerts (from fuel_drop_alerts table) ────────────

export interface PythonDropAlertsData {
  imei: string;
  from: string;
  to: string;
  count: number;
  drops: FuelDropDetail[];
}

// ─── Fuel consumption (updated: now includes drops[] + refuels[] + tanks[]) ─

export interface TankBreakdown {
  sensorId: number;
  sensorName: string;
  consumed: number;
  refueled: number;
  refuelEvents: number;
}

export interface FuelConsumptionData {
  imei: string;
  from: string;
  to: string;
  /** Cumulative consumption from small drops only (excludes sensor jumps). */
  consumed: number;
  refueled: number;
  estimatedCost: number;
  unit: string;
  refuelEvents: number;
  samples: number;
  /** Single-tank: all drop events */
  drops?: FuelDropDetail[];
  /** Single-tank: all refuel events */
  refuels?: FuelRefuelDetail[];
  /** Multi-tank: per-tank breakdown */
  tanks?: TankBreakdown[];
  /** First valid fuel reading in the period (liters). */
  firstFuel?: number | null;
  /** Last valid fuel reading in the period (liters). */
  lastFuel?: number | null;
  /**
   * Net fuel change = firstFuel − lastFuel.
   * Positive = fuel was lost. This is the most reliable "total dropped"
   * metric because it does NOT inflate from sensor oscillations.
   */
  netDrop?: number | null;
  /** Anomaly detection metadata (added by FuelAnomalyMiddleware) */
  _anomalyMeta?: AnomalyMetadata;
  /** Raw fuel readings (for anomaly detection, from backend) */
  readings?: FuelReading[];
}

/** Fuel reading from backend (for anomaly detection) */
export interface FuelReading {
  ts: string;
  fuel: number;
  speed: number;
}

// ─── Fuel stats (NEW) ──────────────────────────────────────────────────────

export interface FuelEfficiency {
  totalDistanceKm: number;
  kmPerLiter: number;
  litersPer100km: number;
}

export interface FuelIdleDrain {
  liters: number;
  percentage: number;
}

export interface FuelTimelineEvent {
  at: string;
  consumed?: number;
  added?: number;
  fuel?: number;
  unit: string;
}

export interface FuelTimeline {
  biggestDrop:   FuelTimelineEvent;
  biggestRefuel: FuelTimelineEvent;
  lowestLevel:   FuelTimelineEvent;
  highestLevel:  FuelTimelineEvent;
}

export interface FuelStatsData {
  imei: string;
  from: string;
  to: string;
  unit: string;
  consumed: number;
  refueled: number;
  estimatedCost: number;
  avgDailyConsumption: number;
  efficiency: FuelEfficiency;
  idleDrain: FuelIdleDrain;
  fuelTimeline: FuelTimeline;
  refuelEvents: number;
  totalDropEvents: number;
  samples: number;
  drops: FuelDropDetail[];
  refuels: FuelRefuelDetail[];
}

// ─── Refuel events (existing endpoint) ─────────────────────────────────────

export interface RefuelEvent {
  at: string;
  fuelBefore: number;
  fuelAfter: number;
  added: number;
  unit: string;
}

export interface RefuelEventsData {
  imei: string;
  from: string;
  to: string;
  refuelEvents: RefuelEvent[];
}

// ─── Dashboard summary ─────────────────────────────────────────────────────

export interface VehicleSummary {
  imei: string;
  name: string;
  plateNumber: string;
  consumed: number;
  refueled: number;
  cost: number;
  lastSeen: string;
  status: "online" | "offline";
  currentFuel: number;
  unit: string;
}

export interface DashboardSummaryData {
  from: string;
  to: string;
  vehicles: VehicleSummary[];
  totals: {
    consumed: number;
    cost: number;
  };
}

// ─── Daily Trend (used in thrift + daily-trend reports) ────────────────────

export interface DailyTrendItem {
  date: string;
  consumed: number;
  distanceKm: number;
  kmPerLiter: number;
  rating: string;
}

// ─── Fleet Daily Trend ─────────────────────────────────────────────────────

export interface FleetDailyTrendItem {
  date: string;
  consumed: number;
  distanceKm: number;
}

// ─── Thrift Score Breakdown ──────────────────────────────────────────────────

export interface ThriftScoreBreakdown {
  idlePenalty: number;
  overspeedPenalty: number;
  efficiencyPenalty: number;
}

export interface ThriftScoreData {
  score: number;
  rating: string;
  breakdown: ThriftScoreBreakdown;
}

// ─── Thrift Analysis (Per Vehicle) ───────────────────────────────────────────

export interface ThriftAnalysisData {
  imei: string;
  consumed: number;
  efficiency: FuelEfficiency;
  idleDrain: FuelIdleDrain;
  highSpeedDrain: {
    liters: number;
    percentage: number;
    events: number;
  };
  dailyTrend: DailyTrendItem[];
  thriftScore: ThriftScoreData;
  samples: number;
}

// ─── Fleet Ranking (Thrift Leaderboard) ──────────────────────────────────────

export interface FleetRankingItem {
  rank: number;
  imei: string;
  name: string;
  plateNumber: string;
  kmPerLiter: number;
  litersPer100km: number;
  consumed: number;
  totalDistanceKm: number;
  thriftScore: number;
  thriftRating: string;
  badge: string;
}

export interface FleetRankingData {
  from: string;
  to: string;
  ranking: FleetRankingItem[];
  bestVehicle?: {
    rank: number;
    name: string;
    thriftScore: number;
    badge: string;
  };
  worstVehicle?: {
    rank: number;
    name: string;
    thriftScore: number;
    badge: string;
  };
}

// ─── Reports: Trips ─────────────────────────────────────────────────────────

export interface TripLocation {
  lat: number;
  lng: number;
  address?: string;
}

export interface Trip {
  tripId: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  startLocation: TripLocation;
  endLocation: TripLocation;
  distanceKm: number;
  fuelConsumed: number;
  fuelAtStart: number;
  fuelAtEnd: number;
  kmPerLiter: number | null;
  unit: string;
  maxSpeed: number;
  avgSpeed: number;
  idleDurationMinutes: number;
  movingDurationMinutes: number;
}

export interface TripVehicle {
  imei: string;
  name: string;
  plateNumber: string;
  unit: string;
  totalTrips: number;
  totalDistanceKm: number;
  /** Full-period consumed fuel (matches Routes mass-balance). */
  totalFuelConsumed: number;
  /** Fuel consumed only during detected trips. */
  tripFuelConsumed?: number;
  /** Period fuel not attributable to detected trips (idle/theft/noise-filtered gaps). */
  unassignedFuelConsumed?: number;
  totalDurationMinutes: number;
  avgKmPerLiter: number | null;
  trips: Trip[];
  status: "ok" | "no_data";
}

export interface TripsReportData {
  from: string;
  to: string;
  fleetTotals: {
    totalTrips: number;
    totalDistanceKm: number;
    /** Full-period consumed fuel (matches Routes mass-balance). */
    totalFuelConsumed: number;
    /** Fuel consumed only during detected trips. */
    tripFuelConsumed?: number;
    /** Period fuel not attributable to detected trips. */
    unassignedFuelConsumed?: number;
    totalDurationMinutes: number;
    avgKmPerLiter: number | null;
  };
  vehicles: TripVehicle[];
}

// ─── Fuel Debug ──────────────────────────────────────────────────────────────

export interface FuelDebugSample {
  rawValue: number;
  formulaApplied?: number;
  calibrationApplied?: number;
  finalValue: number;
  timestamp: string;
}

export interface FuelDebugData {
  imei: string;
  from: string;
  to: string;
  sensorId: number;
  samples: FuelDebugSample[];
  totalSamples: number;
}

// ─── Reports: Consumption ────────────────────────────────────────────────────

export interface ConsumptionReportVehicle {
  imei: string;
  name: string;
  plateNumber: string;
  consumed: number;
  refueled: number;
  estimatedCost: number | null;
  refuelEvents: number;
  unit: string;
  status: "ok" | "no_data";
}

export interface ConsumptionReportData {
  from: string;
  to: string;
  totals: {
    consumed: number;
    refueled: number;
    cost: number | null;
  };
  vehicles: ConsumptionReportVehicle[];
}

// ─── Reports: Refuels ────────────────────────────────────────────────────────

export interface RefuelReportEvent {
  imei: string;
  name: string;
  plateNumber: string;
  at: string;
  fuelBefore: number;
  fuelAfter: number;
  added: number;
  unit: string;
}

export interface RefuelReportData {
  from: string;
  to: string;
  totalEvents: number;
  totalAdded: number;
  events: RefuelReportEvent[];
}

// ─── Reports: Idle Waste ─────────────────────────────────────────────────────

export interface IdleWasteVehicle {
  imei: string;
  name: string;
  plateNumber: string;
  totalConsumed: number;
  idleLiters: number;
  idlePercentage: number;
  unit: string;
  status: "ok" | "no_data";
}

export interface IdleWasteReportData {
  from: string;
  to: string;
  fleetTotals: {
    idleLiters: number;
    totalConsumed: number;
    idlePercentage: number;
  };
  vehicles: IdleWasteVehicle[];
}

// ─── Reports: High Speed Waste ───────────────────────────────────────────────

export interface HighSpeedWasteVehicle {
  imei: string;
  name: string;
  plateNumber: string;
  totalConsumed: number;
  highSpeedLiters: number;
  highSpeedPercentage: number;
  highSpeedEvents: number;
  unit: string;
  status: "ok" | "no_data";
}

export interface HighSpeedWasteReportData {
  from: string;
  to: string;
  speedThresholdKmh: number;
  fleetTotals: {
    highSpeedLiters: number;
    totalConsumed: number;
    highSpeedPercentage: number;
  };
  vehicles: HighSpeedWasteVehicle[];
}

// ─── Reports: Daily Trend ────────────────────────────────────────────────────

export interface DailyTrendVehicle {
  imei: string;
  name: string;
  plateNumber: string;
  unit: string;
  totalConsumed: number;
  status: "ok" | "no_data";
  dailyTrend: DailyTrendItem[];
}

export interface DailyTrendReportData {
  from: string;
  to: string;
  fleetDailyTrend: FleetDailyTrendItem[];
  vehicles: DailyTrendVehicle[];
}

// ─── Reports: Thrift ─────────────────────────────────────────────────────────

export interface ThriftReportVehicle {
  imei: string;
  name: string;
  plateNumber: string;
  consumed: number;
  unit: string;
  kmPerLiter: number;
  litersPer100km: number;
  totalDistanceKm: number;
  idleLiters: number;
  idlePercentage: number;
  highSpeedLiters: number;
  highSpeedPercentage: number;
  thriftScore: number;
  thriftRating: string;
  breakdown: ThriftScoreBreakdown;
  status: "ok" | "no_data";
}

export interface ThriftReportData {
  from: string;
  to: string;
  fleetAvgScore: number;
  bestVehicle?: {
    imei: string;
    name: string;
    thriftScore: number;
    thriftRating: string;
  } | null;
  worstVehicle?: {
    imei: string;
    name: string;
    thriftScore: number;
    thriftRating: string;
  } | null;
  vehicles: ThriftReportVehicle[];
}

// ─── Reports: Engine Hours ───────────────────────────────────────────────────

export interface EngineHoursVehicle {
  imei: string;
  name: string;
  plateNumber: string;
  engineOnHours: number;
  avgHoursPerDay: number;
  totalSamples: number;
  status: "ok" | "no_data";
}

export interface EngineHoursReportData {
  from: string;
  to: string;
  fleetTotalEngineHours: number;
  vehicles: EngineHoursVehicle[];
}

// ─── Reports: Vehicle Status ─────────────────────────────────────────────────

export interface VehicleStatusItem {
  imei: string;
  name: string;
  plateNumber: string;
  status: "online" | "offline";
  lastSeen: string | null;
  minutesSinceLastSeen: number | null;
  speed: number;
  lat: number;
  lng: number;
  currentFuel: number | null;
  fuelUnit: string;
  device: string;
  model: string;
  simNumber: string;
}

export interface VehicleStatusReportData {
  generatedAt: string;
  totalVehicles: number;
  online: number;
  offline: number;
  vehicles: VehicleStatusItem[];
}

// ─── Fuel Theft Detection ──────────────────────────────────────────────────

export interface FuelDrop {
  at: string;
  fuelBefore: number;
  fuelAfter: number;
  consumed: number;
  type: "normal" | "suspicious" | "theft";
  speedAtDrop: number;
  ignitionOn: boolean;
  durationMinutes: number;
  lat: number;
  lng: number;
  severity: "low" | "medium" | "high" | "critical";
  reason: string;
}

export interface TheftSummary {
  totalDrops: number;
  normalDrops: number;
  suspiciousDrops: number;
  theftDrops: number;
  totalFuelLost: number;
  suspiciousFuelLost: number;
  theftFuelLost: number;
}

export interface TheftReportData {
  imei: string;
  name: string;
  plateNumber: string;
  from: string;
  to: string;
  summary: TheftSummary;
  riskLevel: "low" | "medium" | "high" | "critical";
  riskScore: number;
  alerts: string[];
  drops: FuelDrop[];
}

export interface FleetTheftVehicle {
  imei: string;
  name: string;
  plateNumber: string;
  riskScore: number;
  riskLevel: string;
  totalDrops: number;
  suspiciousDrops: number;
  theftDrops: number;
  fuelLost: number;
  alerts: string[];
  drops: FuelDrop[];
}

export interface FleetTheftReportData {
  from: string;
  to: string;
  fleetSummary: TheftSummary;
  fleetRiskLevel: "low" | "medium" | "high" | "critical";
  fleetRiskScore: number;
  fleetAlerts: string[];
  vehicles: FleetTheftVehicle[];
}

// ─── Trip Route ────────────────────────────────────────────────────────────

export interface TripRoutePoint {
  lat: number;
  lng: number;
  speed: number;
  ts: string;
}

export interface TripRouteData {
  points: TripRoutePoint[];
  totalPoints: number;
}

// ─── Theft Locations Report ────────────────────────────────────────────────

export interface TheftLocationEvent {
  imei: string;
  name: string;
  plateNumber: string;
  at: string;
  fuelBefore: number;
  fuelAfter: number;
  consumed: number;
  lat: number | null;
  lng: number | null;
}

export interface TheftLocationsReportData {
  from: string;
  to: string;
  totalEvents: number;
  events: TheftLocationEvent[];
}

// ─── Master Vehicle Report ─────────────────────────────────────────────────
// One vehicle, one date range, everything: fuel, distance, trips, engine time,
// theft signals, dispatch assignments with per-bin proof, and route deviations
// with the map evidence + operator remarks behind each one.

export interface MasterLatLng {
  lat: number;
  lng: number;
}

export interface MasterTrackPoint {
  at: string;
  lat: number;
  lng: number;
  speed: number;
}

export interface MasterDeviationEvent {
  eventId: number;
  type: string;
  at: string;
  lat: number | null;
  lng: number | null;
  distanceM: number | null;
  actor: string;
  note: string | null;
  remark: string | null;
}

/** One sustained excursion outside the planned route corridor. */
export interface MasterDeviationExcursion {
  excursionId: string;
  assignmentId: number;
  routeName: string | null;
  driverName: string | null;
  startedAt: string;
  endedAt: string;
  durationMinutes: number;
  maxDistanceM: number;
  avgDistanceM: number;
  corridorBufferM: number;
  peak: { lat: number; lng: number; at: string };
  /** Off-corridor portion of the actual track — the map proof. */
  path: MasterLatLng[];
  returnedToRoute: boolean;
  offRouteDistanceKm: number;
  events: MasterDeviationEvent[];
  /** Operator remarks recorded against this deviation. */
  remarks: string[];
}

export type MasterStopStatus = "completed" | "visited" | "skipped" | "missed";

export interface MasterStop {
  stopId: number | null;
  seq: number;
  name: string | null;
  lat: number;
  lng: number;
  radiusM: number;
  status: MasterStopStatus;
  completedAt: string | null;
  completionDistanceM: number | null;
  inRange: boolean | null;
  photoPath: string | null;
  note: string | null;
  skipRemark: string | null;
}

export interface MasterAssignment {
  assignmentId: number;
  routeId: number;
  routeName: string | null;
  driverId: number;
  driverName: string | null;
  status: string;
  priority: string;
  persistent: boolean;
  notes: string | null;
  scheduledStart: string | null;
  startedAt: string | null;
  completedAt: string | null;
  windowFrom: string;
  windowTo: string;
  corridorBufferM: number;
  plannedDistanceKm: number | null;
  depot: { name: string | null; lat: number; lng: number } | null;
  plannedGeometry: MasterLatLng[];
  actualTrack: MasterTrackPoint[];
  stops: MasterStop[];
  excursions: MasterDeviationExcursion[];
  stats: {
    stopsTotal: number;
    stopsCompleted: number;
    stopsSkipped: number;
    stopsMissed: number;
    completionRatePct: number;
    distanceKm: number;
    durationMinutes: number | null;
    excursionCount: number;
    maxDeviationM: number;
    gpsFixes: number;
    photoProofCount: number;
  };
}

export interface MasterReportData {
  from: string;
  to: string;
  generatedAt: string;

  vehicle: {
    imei: string;
    name: string;
    plateNumber: string;
    model: string | null;
    device: string | null;
    simNumber: string | null;
    lastSeen: string | null;
    online: boolean;
    fuelSensor: { name: string; param: string; unit: string } | null;
  };

  telemetry: {
    gpsFixes: number;
    firstFixAt: string | null;
    lastFixAt: string | null;
    hasFuelData: boolean;
  };

  fuel: {
    unit: string;
    consumed: number;
    refueled: number;
    refuelEventCount: number;
    estimatedCost: number | null;
    openingFuel: number | null;
    closingFuel: number | null;
    netDrop: number | null;
    idleLiters: number;
    idlePercentage: number;
    highSpeedLiters: number;
    highSpeedPercentage: number;
    highSpeedEvents: number;
    speedThresholdKmh: number;
    refuels: RefuelEvent[];
  };

  distance: {
    totalDistanceKm: number;
    tripDistanceKm: number;
    onAssignmentDistanceKm: number;
    kmPerLiter: number | null;
    maxSpeedKmh: number;
    avgMovingSpeedKmh: number;
  };

  engine: {
    engineOnHours: number;
    avgHoursPerDay: number;
    idleHours: number;
    movingHours: number;
    idleSharePct: number;
  };

  trips: {
    totalTrips: number;
    totalDistanceKm: number;
    totalFuelConsumed: number;
    totalDurationMinutes: number;
    avgKmPerLiter: number | null;
    items: Trip[];
  };

  theft: {
    riskLevel: string;
    riskScore: number;
    summary: {
      totalDrops: number;
      normalDrops: number;
      suspiciousDrops: number;
      theftDrops: number;
      totalFuelLost: number;
      suspiciousFuelLost: number;
      theftFuelLost: number;
    };
    alerts: unknown[];
  } | null;

  assignments: {
    total: number;
    analysed: number;
    truncated: boolean;
    completed: number;
    inProgress: number;
    notStarted: number;
    stopsTotal: number;
    stopsCompleted: number;
    stopsSkipped: number;
    stopsMissed: number;
    completionRatePct: number;
    photoProofCount: number;
    items: MasterAssignment[];
  };

  deviations: {
    total: number;
    withRemarks: number;
    maxDistanceM: number;
    totalOffRouteKm: number;
    items: MasterDeviationExcursion[];
  };
}

// ─── Generic API wrapper ───────────────────────────────────────────────────

export interface ApiResponse<T> {
  success: boolean;
  message: string;
  data: T;
}

// ─── API Error ─────────────────────────────────────────────────────────────

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly errorType?: string
  ) {
    super(message);
    this.name = "ApiError";
  }

  get userMessage(): string {
    if (this.statusCode === 0) {
      return this.message;
    }
    if (
      this.message.includes("EHOSTUNREACH") ||
      this.message.includes("ECONNREFUSED") ||
      this.message.includes("ETIMEDOUT")
    ) {
      return "Database is temporarily unreachable. Please retry in a moment.";
    }
    switch (this.statusCode) {
      case 400: return this.message;
      case 401: return "Session expired. Please log in again.";
      case 403: return "You don't have permission to access this vehicle.";
      case 404: return "No data found for the selected period.";
      case 422: return "No fuel sensor configured for this vehicle.";
      case 500: return "Server error while loading report. Please retry in a moment.";
      default:  return "Something went wrong. Please try again.";
    }
  }
}

// ─── Fuel Detection Engine Types ─────────────────────────────────────────────

/**
 * Fuel reading for detection engine
 */
export interface FuelReading {
  timestamp: Date;
  fuel: number;
  speed: number;
  ignitionOn?: boolean;
  movementBit?: number;
  lat?: number;
  lng?: number;
}

/**
 * Detection alert types
 */
export type DetectionAlertType = "drop" | "rise" | "low_fuel";

/**
 * Detection alert severity
 */
export type DetectionAlertSeverity = "low" | "medium" | "high" | "critical";

/**
 * Detection alert - mirrors Python alert structure
 */
export interface DetectionAlert {
  id: string;
  type: DetectionAlertType;
  imei: string;
  param?: string;
  fuelBefore: number;
  fuelAfter: number;
  amount: number;
  timestamp: Date;
  location?: { lat: number; lng: number };
  speed: number;
  ignitionOn: boolean;
  severity: DetectionAlertSeverity;
  reason: string;
  isConfirmed: boolean;
  verifiedAt?: Date;
}

/**
 * Drop detection result
 */
export interface DropDetectionResult {
  isDrop: boolean;
  dropAmount: number;
  fuelBefore: number;
  fuelAfter: number;
  isFakeSpike: boolean;
  isConfirmed: boolean;
  reason: string;
  severity: DetectionAlertSeverity;
}

/**
 * Rise detection result
 */
export interface RiseDetectionResult {
  isRise: boolean;
  riseAmount: number;
  fuelBefore: number;
  fuelAfter: number;
  isFakeSpike: boolean;
  isConfirmed: boolean;
  reason: string;
}

/**
 * Fuel detection state for UI
 */
export interface FuelDetectionState {
  alerts: DetectionAlert[];
  pendingAlerts: DetectionAlert[];
  theftAlerts: DetectionAlert[];
  refuelAlerts: DetectionAlert[];
  lowFuelAlerts: DetectionAlert[];
  currentLevels: Map<string, { fuel: number; timestamp: Date; speed: number }>;
  detectorStates: Map<string, {
    lastFuel: number | null;
    lastReadingTime: Date | null;
    baselineFuel: number | null;
    historyCount: number;
    lastAlert: DetectionAlert | null;
  }>;
}

/**
 * History analysis result
 */
export interface HistoryAnalysisResult {
  drops: FuelDropDetail[];
  refuels: FuelRefuelDetail[];
  theftEvents: FuelDropDetail[];
  netDrop: number | null;
  totalConsumed: number;
  totalRefueled: number;
  confirmedDropCount: number;
  theftCount: number;
}
