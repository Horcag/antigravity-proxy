import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { ProxyModule } from '../modules/proxy-gateway/server/proxy.module';

@Module({
  imports: [ProxyModule, AdminModule],
  controllers: [],
  providers: [],
})
export class AppModule {}
