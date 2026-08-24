import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AdminGuard } from '@/modules/proxy-gateway/server/guards/admin.guard';
import { AdminService, OAuthExchangeRequest } from './admin.service';

function isExplicitTrue(value: string | undefined): boolean {
  return value === '1' || value === 'true' || value === 'yes';
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
