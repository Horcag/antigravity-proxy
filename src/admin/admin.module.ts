import { Module } from '@nestjs/common';
import { ProxyModule } from '@/modules/proxy-gateway/server/proxy.module';
import { AdminGuard } from '@/modules/proxy-gateway/server/guards/admin.guard';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({
  imports: [ProxyModule],
  controllers: [AdminController],
  providers: [AdminGuard, AdminService],
})
export class AdminModule {}
