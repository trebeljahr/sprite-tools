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
 */
let draining = false;

export function startDraining(): void {
  draining = true;
}

export function isDraining(): boolean {
  return draining;
}

/** Takes `req.socket.remoteAddress`: the peer of this socket, not a forwarded address. */
export function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
