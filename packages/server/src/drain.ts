/**
 * Shutdown drain: keep a stopping container out of Traefik before it stops
 * serving.
 *
 * Coolify replaces a container by starting the new one, waiting for it to turn
 * healthy, then running `docker stop` on the old one. Traefik routes to the old
 * container until it has exited or its Docker health leaves `healthy`. So on
 * SIGTERM (index.ts) only the health probe fails: Coolify runs it inside the
 * container against 127.0.0.1, and visitors never arrive over loopback. Every
 * other request is served until SHUTDOWN_DRAIN_SECONDS have passed.
 *
 * Traefik's own load-balancer health check (app.ts) fails too, after a grace.
 */
import type { IncomingHttpHeaders } from "node:http";

let draining = false;
let proxyDrainsAt = 0;

/**
 * Traefik's own health check fails only after a grace — a quarter of the
 * drain, at most 4 s. Traefik drops a container on ONE failed check, and
 * Coolify stops this one as soon as Docker calls the new one healthy, which
 * Traefik can take 2 s more to add. Failing at once could empty the pool.
 */
export function startDraining(drainSeconds = 0): void {
  draining = true;
  proxyDrainsAt = Date.now() + Math.min(4000, (drainSeconds * 1000) / 4);
}

/** Whether Traefik's probe should fail yet (see the grace above). */
export function isProxyDraining(): boolean {
  return draining && Date.now() >= proxyDrainsAt;
}

export function isDraining(): boolean {
  return draining;
}

/** Takes `req.socket.remoteAddress`: the peer of this socket, not a forwarded address. */
export function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/** Whether a request is Traefik's load-balancer health check: the
 *  X-Hatchkit-Drain header, and no X-Forwarded-For (Traefik adds that to
 *  every request it forwards). */
export function isTraefikProbe(headers: IncomingHttpHeaders): boolean {
  return headers["x-hatchkit-drain"] !== undefined && headers["x-forwarded-for"] === undefined;
}
