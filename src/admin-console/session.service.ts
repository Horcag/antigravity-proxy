import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { CanActivate, Controller, Delete, ExecutionContext, ForbiddenException, Get, Injectable, Post, Body, Req, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getServerConfig } from '@/server/server-config';
import { extractApiKeyToken, hasMatchingApiKey } from '@/modules/proxy-gateway/server/guards/api-key-auth.util';

const COOKIE = 'ag_console';
const MAX_AGE = 7 * 24 * 60 * 60;
interface Session { expires: number; csrf: string }
function equal(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

@Injectable()
export class ConsoleSessionService {
  private secret(): string {
    const key = getServerConfig()?.admin_api_key;
    if (!key?.trim()) throw new UnauthorizedException('Admin API key is not configured');
    return key;
  }
  private mac(payload: string): string {
    return createHmac('sha256', this.secret()).update(`admin-console-session-v1:${payload}`).digest('base64url');
  }
  requireOrigin(request: FastifyRequest): void {
    const origin = request.headers.origin;
    if (!origin || origin !== `${request.protocol}://${request.headers.host}`) {
      throw new ForbiddenException('Same-origin request required');
    }
    if (request.headers['sec-fetch-site'] === 'cross-site') throw new ForbiddenException('Cross-site request rejected');
  }
  login(key: unknown): { token: string; session: Session } {
    if (typeof key !== 'string' || !hasMatchingApiKey(key, this.secret())) throw new UnauthorizedException('Invalid admin key');
    const session = { expires: Date.now() + MAX_AGE * 1000, csrf: randomBytes(32).toString('base64url') };
    const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
    return { token: `${payload}.${this.mac(payload)}`, session };
  }
  read(request: FastifyRequest): Session | null {
    const token = request.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    if (!token || token.length > 2048) return null;
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra) return null;
    try {
      if (!equal(signature, this.mac(payload))) return null;
      const session = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Session;
      if (typeof session.expires !== 'number' || session.expires <= Date.now() || session.expires > Date.now() + MAX_AGE * 1000 || typeof session.csrf !== 'string') return null;
      return session;
    } catch { return null; }
  }
  identity(request: FastifyRequest): string {
    return this.read(request)?.csrf ?? this.mac(extractApiKeyToken(request.headers) ?? '');
  }
  authorize(request: FastifyRequest): boolean {
    const key = this.secret();
    if (hasMatchingApiKey(extractApiKeyToken(request.headers), key)) return true;
    const session = this.read(request);
    if (!session) throw new UnauthorizedException('Console login required');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      this.requireOrigin(request);
      const csrf = request.headers['x-csrf-token'];
      if (typeof csrf !== 'string' || !equal(csrf, session.csrf)) throw new ForbiddenException('Invalid CSRF token');
    }
    return true;
  }
  cookie(request: FastifyRequest, token: string, remember: boolean): string {
    return `${COOKIE}=${token}; Path=/admin; HttpOnly; SameSite=Strict${request.protocol === 'https' ? '; Secure' : ''}${remember ? `; Max-Age=${token ? MAX_AGE : 0}` : ''}`;
  }
}
@Injectable()
export class ConsoleGuard implements CanActivate {
  constructor(private readonly sessions: ConsoleSessionService) {}
  canActivate(context: ExecutionContext): boolean {
    context.switchToHttp().getResponse<FastifyReply>().header('cache-control', 'no-store');
    return this.sessions.authorize(context.switchToHttp().getRequest());
  }
}
@Controller('admin/session')
export class ConsoleSessionController {
  constructor(private readonly sessions: ConsoleSessionService) {}
  @Get() status(@Req() req: FastifyRequest, @Res({ passthrough: true }) res: FastifyReply) {
    res.header('cache-control', 'no-store');
    const session = this.sessions.read(req);
    return { loggedIn: Boolean(session), csrfToken: session?.csrf ?? null };
  }
  @Post() login(@Body() body: { key?: unknown; remember?: boolean }, @Req() req: FastifyRequest, @Res({ passthrough: true }) res: FastifyReply) {
    this.sessions.requireOrigin(req);
    const { token, session } = this.sessions.login(body?.key);
    res.header('set-cookie', this.sessions.cookie(req, token, body?.remember === true));
    res.header('cache-control', 'no-store');
    return { loggedIn: true, csrfToken: session.csrf };
  }
  @Delete() @UseGuards(ConsoleGuard)
  logout(@Req() req: FastifyRequest, @Res({ passthrough: true }) res: FastifyReply) {
    res.header('set-cookie', this.sessions.cookie(req, '', true));
    return { loggedIn: false, csrfToken: null };
  }
}
