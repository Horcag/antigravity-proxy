import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../modules/proxy-gateway/server/guards/admin.guard';
import { DashboardService } from './dashboard.service';
import { getDashboardPage } from './dashboard-asset';

@Controller()
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('dashboard')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('X-Content-Type-Options', 'nosniff')
  @Header('Content-Security-Policy', "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
  page() { return getDashboardPage(); }

  @Get('admin/dashboard')
  @UseGuards(AdminGuard)
  @Header('Cache-Control', 'no-store')
  snapshot() { return this.dashboard.snapshot(); }
}
