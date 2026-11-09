import { Module } from '@nestjs/common';
import { DashboardModule } from '../dashboard/dashboard.module';
import { AdminModule } from '../admin/admin.module';
import { ProxyModule } from '../modules/proxy-gateway/server/proxy.module';

@Module({
  imports: [ProxyModule, AdminModule, DashboardModule],
  controllers: [],
  providers: [],
})
export class AppModule {}
