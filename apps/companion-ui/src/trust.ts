// Same rule as the simulator's server: only a page served from this loopback origin may talk to us.
// A foreign Origin is another site (cross-site WebSocket hijacking); a non-loopback Host is DNS rebinding.

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function isTrustedRequest(req: Request): boolean {
  const host = req.headers.get("host");
  if (!host) return false;
  let hostname: string;
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    return false;
  }
  if (!LOOPBACK_HOSTS.has(hostname)) return false;
  const origin = req.headers.get("origin");
  if (origin === null) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

