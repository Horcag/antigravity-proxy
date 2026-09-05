import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { AdminGuard } from '@/modules/proxy-gateway/server/guards/admin.guard';
import { AdminService, OAuthExchangeRequest } from './admin.service';

function isExplicitTrue(value: string | undefined): boolean {
  return value === '1' || value === 'true' || value === 'yes';
}

function preferredAccountIdFromBody(body: unknown): string {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return '';
  }
  const accountId = (body as Record<string, unknown>).account_id;
  return typeof accountId === 'string' ? accountId : '';
}

@Controller()
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('health')
  health() {
    return {
      ok: true,
    };
  }

  @Get('admin/status')
  @UseGuards(AdminGuard)
  status() {
    return this.adminService.getStatus();
  }

  @Get('admin/accounts')
  @UseGuards(AdminGuard)
  listAccounts() {
    return this.adminService.listAccounts();
  }

  @Get('admin/accounts/preferred')
  @UseGuards(AdminGuard)
  getPreferredAccount() {
    return this.adminService.getPreferredAccount();
  }

  @Put('admin/accounts/preferred')
  @UseGuards(AdminGuard)
  setPreferredAccountFromBody(@Body() body: unknown) {
    return this.adminService.setPreferredAccount(preferredAccountIdFromBody(body));
  }

  @Put('admin/accounts/preferred/:accountId')
  @UseGuards(AdminGuard)
  setPreferredAccountFromPath(@Param('accountId') accountId: string) {
    return this.adminService.setPreferredAccount(accountId);
  }

  @Delete('admin/accounts/preferred')
  @UseGuards(AdminGuard)
  clearPreferredAccount() {
    return this.adminService.clearPreferredAccount();
  }

  @Post('admin/accounts/import')
  @UseGuards(AdminGuard)
  importAccounts(@Body() body: unknown) {
    return this.adminService.importAccounts(body);
  }

  @Get('admin/accounts/export')
  @UseGuards(AdminGuard)
  exportAccounts(@Query('include_tokens') includeTokens?: string) {
    return this.adminService.exportAccounts(isExplicitTrue(includeTokens));
  }

  @Delete('admin/accounts/:accountId')
  @UseGuards(AdminGuard)
  removeAccount(@Param('accountId') accountId: string) {
    return this.adminService.removeAccount(accountId);
  }

  @Post('admin/accounts/reload')
  @UseGuards(AdminGuard)
  reloadAccounts() {
    return this.adminService.reloadAccounts();
  }

  @Post('admin/accounts/refresh-quota')
  @UseGuards(AdminGuard)
  refreshQuotaCatalog(@Query('force') force?: string) {
    return this.adminService.refreshQuotaCatalog(isExplicitTrue(force));
  }

  @Get('admin/accounts/quota-diagnostics')
  @UseGuards(AdminGuard)
  quotaDiagnostics() {
    return this.adminService.getQuotaDiagnostics();
  }

  @Get('admin/oauth/url')
  @UseGuards(AdminGuard)
  oauthUrl(@Query('client_key') clientKey?: string) {
    return this.adminService.getOAuthUrl(clientKey);
  }

  @Post('admin/oauth/exchange')
  @UseGuards(AdminGuard)
  oauthExchange(@Body() body: OAuthExchangeRequest) {
    return this.adminService.exchangeOAuthCode(body);
  }
}
