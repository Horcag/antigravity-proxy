import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../modules/proxy-gateway/server/guards/admin.guard';
import { DashboardService } from './dashboard.service';
import { dashboardPage } from './dashboard.page';

@Controller()
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('dashboard')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('X-Content-Type-Options', 'nosniff')
  @Header('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
  page() { return dashboardPage; }

  @Get('admin/dashboard')
  @UseGuards(AdminGuard)
  @Header('Cache-Control', 'no-store')
  snapshot() { return this.dashboard.snapshot(); }
}
