import { ConsoleOAuthService } from '@/admin-console/console-oauth.service';
import { ConsoleObservationController } from './console-observation.controller';
import { Module } from '@nestjs/common';
import { ProxyModule } from '@/modules/proxy-gateway/server/proxy.module';
import { AdminService } from '@/admin/admin.service';
import { ConsoleSessionController, ConsoleSessionService, ConsoleGuard } from './session.service';
import { ConsoleController } from './console.controller';
import { ConsoleAccountsService } from './console-accounts.service';
import { ConsoleConfigService } from './console-config.service';
@Module({
  imports: [ProxyModule], controllers: [ConsoleSessionController, ConsoleController, ConsoleObservationController],
  providers: [ConsoleSessionService, ConsoleGuard, ConsoleAccountsService, ConsoleConfigService, ConsoleOAuthService, AdminService],
})
export class ConsoleModule {}
