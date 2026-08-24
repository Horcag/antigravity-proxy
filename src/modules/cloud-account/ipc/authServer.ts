export class AuthServer {
  static getRedirectUri(): string {
    return process.env.AG_PROXY_OAUTH_REDIRECT_URI?.trim() || 'http://localhost:8888/oauth-callback';
  }
}
