import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { getServerConfig } from '../../../server/server-config';
import {
  extractApiKeyToken,
  isProxyApiKeyConfigured,
  hasMatchingProxyApiKey,
  RequestHeaders,
} from './guards/api-key-auth.util';

@Injectable()
export class ProxyGuard implements CanActivate {
  private readonly logger = new Logger(ProxyGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();

    const config = getServerConfig();

    const headers = request.headers as RequestHeaders;
    const clientToken = extractApiKeyToken(headers);

    if (!isProxyApiKeyConfigured(config)) {
      return true;
    }

    if (hasMatchingProxyApiKey(config, clientToken)) {
      return true;
    }
    this.logger.warn(`Rejected unauthorized request from ${request.ip}`);

    throw new UnauthorizedException('API key validation failed');
  }
}
