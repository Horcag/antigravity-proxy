export interface ParsedConnectAuthority {
  hostname: string;
  port: number;
}
export function parseConnectAuthority(destination: string | undefined): ParsedConnectAuthority | null {
  if (!destination || typeof destination !== 'string') return null;
  const trimmed = destination.trim();
  let hostname = '';
  let port = 0;
  const ipv6Match = /^\[([a-fA-F0-9:.%]+)\]:([0-9]{1,5})$/.exec(trimmed);
  if (ipv6Match) {
    hostname = ipv6Match[1].toLowerCase();
    port = Number(ipv6Match[2]);
  } else {
    const standardMatch = /^([a-zA-Z0-9.-]+):([0-9]{1,5})$/.exec(trimmed);
    if (!standardMatch) return null;
    hostname = standardMatch[1].toLowerCase();
    port = Number(standardMatch[2]);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (!ipv6Match && (
    hostname.startsWith('.') ||
    hostname.endsWith('.') ||
    hostname.includes('..') ||
    hostname.startsWith('-')
  )) {
    return null;
  }
  return { hostname, port };
}
