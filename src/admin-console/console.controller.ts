import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { AdminService } from '@/admin/admin.service';
import { AccountLeaseService } from '@/modules/proxy-gateway/server/account-lease.service';
import type { FastifyRequest } from 'fastify';
import { ConsoleOAuthService } from './console-oauth.service';
import { ConsoleGuard, ConsoleSessionService } from './session.service';
import { ConsoleAccountsService } from './console-accounts.service';
import { ConsoleConfigService } from './console-config.service';

@Controller('admin/console')
@UseGuards(ConsoleGuard)
export class ConsoleController {
  constructor(private readonly accounts: ConsoleAccountsService, private readonly config: ConsoleConfigService,
    private readonly admin: AdminService, private readonly leases: AccountLeaseService,
    private readonly oauth: ConsoleOAuthService, private readonly sessions: ConsoleSessionService) {}
  @Get('accounts') listAccounts() { return this.accounts.list(); }
  @Post('accounts/import') importAccounts(@Body() body: unknown) { return this.accounts.import(body); }
  @Patch('accounts/:id') setDisabled(@Param('id') id: string, @Body() body: unknown) { return this.accounts.setDisabled(id, body); }
  @Delete('accounts/:id') removeAccount(@Param('id') id: string) { return this.admin.removeAccount(id); }
  @Post('accounts/reload') reload() { return this.admin.reloadAccounts(); }
  @Post('accounts/refresh-quota') refreshQuota() { return this.admin.refreshQuotaCatalog(true); }
  @Get('accounts/quota-diagnostics') quota() { return this.admin.getQuotaDiagnostics(); }
  @Get('settings') settings() { return this.config.getSettings(); }
  @Patch('settings') patchSettings(@Body() body: unknown) { return this.config.patchSettings(body); }
  @Get('projects') projects() { return this.config.listProjects(); }
  @Post('projects') createProject(@Body() body: unknown) { return this.config.createProject(body); }
  @Patch('projects/:id') patchProject(@Param('id') id: string, @Body() body: unknown) { return this.config.patchProject(id, body); }
  @Post('projects/:id/rotate') rotateProject(@Param('id') id: string) { return this.config.patchProject(id, {}, true); }
  @Delete('projects/:id') deleteProject(@Param('id') id: string) { return this.config.deleteProject(id); }
  @Get('models') async models() { return { models: [...await this.leases.getRefreshedAllCollectedModels()].sort() }; }
  @Get('aliases') aliases() { const { custom_mapping, anthropic_mapping } = this.config.getSettings(); return { custom_mapping, anthropic_mapping }; }
  @Put('aliases') putAliases(@Body() body: unknown) { return this.config.patchSettings(body); }
  @Get('oauth/start') oauthStart(@Req() req: FastifyRequest) { return this.oauth.start(this.sessions.identity(req)); }
  @Get('oauth/status') oauthStatus(@Query('state') state: string, @Req() req: FastifyRequest) { return this.oauth.status(state, this.sessions.identity(req)); }
  @Post('oauth/exchange') oauthExchange(@Body() body: unknown, @Req() req: FastifyRequest) { return this.oauth.exchange(body, this.sessions.identity(req)); }
}
