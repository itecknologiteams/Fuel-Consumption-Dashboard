import {
  Module,
  MiddlewareConsumer,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { FuelController } from './fuel.controller';
import { FuelSensorResolverService } from './services/fuel-sensor-resolver.service';
import { FuelTransformService } from './services/fuel-transform.service';
import { DynamicTableQueryService } from './services/dynamic-table-query.service';
import { FuelHistoryService } from './services/fuel-history.service';
import { FuelConsumptionService } from './services/fuel-consumption.service';
import { FuelStatsService } from './services/fuel-stats.service';
import { ThriftService } from './services/thrift.service';
import { TheftDetectionService } from './services/theft-detection.service';
import { TripAnalyzerService } from './services/trip-analyzer.service';
import { RouteHistoryService } from './services/route-history.service';
import { FuelAnomalyMiddleware } from '../common/middleware/fuel-anomaly.middleware';

@Module({
  controllers: [FuelController],
  providers: [
    FuelSensorResolverService,
    FuelTransformService,
    DynamicTableQueryService,
    FuelHistoryService,
    FuelConsumptionService,
    FuelStatsService,
    ThriftService,
    TheftDetectionService,
    TripAnalyzerService,
    RouteHistoryService,
    FuelAnomalyMiddleware,
  ],
  exports: [
    FuelSensorResolverService,
    FuelTransformService,
    DynamicTableQueryService,
    FuelHistoryService,
    FuelConsumptionService,
    FuelStatsService,
    ThriftService,
    TheftDetectionService,
    TripAnalyzerService,
    FuelAnomalyMiddleware,
  ],
})
export class FuelModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(FuelAnomalyMiddleware).forRoutes(
      // Apply to all fuel-related routes under vehicles/:imei/fuel/
      { path: 'vehicles/:imei/fuel/consumption', method: RequestMethod.GET },
      { path: 'vehicles/:imei/fuel/history', method: RequestMethod.GET },
      { path: 'vehicles/:imei/fuel/stats', method: RequestMethod.GET },
      { path: 'vehicles/:imei/fuel/refuels', method: RequestMethod.GET },
      { path: 'vehicles/:imei/fuel/debug', method: RequestMethod.GET },
      { path: 'vehicles/:imei/fuel/thrift', method: RequestMethod.GET },
      { path: 'vehicles/:imei/fuel/theft', method: RequestMethod.GET },
    );
  }
}
