import { Module } from '@nestjs/common';
import { ProxyModule } from '../modules/proxy-gateway/server/proxy.module';
import { AdminGuard } from '../modules/proxy-gateway/server/guards/admin.guard';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

@Module({ imports: [ProxyModule], controllers: [DashboardController], providers: [AdminGuard, DashboardService] })
export class DashboardModule {}
