import { once } from "node:events";
import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { closeDatabase, getDatabase } from "../src/db.js";

// Minimal PostgreSQL wire-protocol server: trust auth and simple queries that
// return one row with one int column. Enough for pg's Pool to connect and run
// "SELECT 1", and to send the same FATAL that a Postgres restart sends.
function message(type: string, body: Buffer) {
  const header = Buffer.alloc(5);
  header.write(type, 0, "ascii");
  header.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([header, body]);
}
const int32 = (value: number) => {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32BE(value);
  return buffer;
};
const int16 = (value: number) => {
  const buffer = Buffer.alloc(2);
  buffer.writeInt16BE(value);
  return buffer;
};
const cstring = (value: string) => Buffer.from(`${value}\0`);
const ready = () => message("Z", Buffer.from("I"));
const oneRow = () =>
  Buffer.concat([
    message(
      "T",
      Buffer.concat([
        int16(1),
        cstring("value"),
        int32(0),
        int16(0),
        int32(23),
        int16(4),
        int32(-1),
        int16(0),
      ]),
    ),
    message("D", Buffer.concat([int16(1), int32(1), Buffer.from("1")])),
    message("C", cstring("SELECT 1")),
    ready(),
  ]);
const adminShutdown = () =>
  message(
    "E",
    Buffer.concat([
      cstring("SFATAL"),
      cstring("C57P01"),
      cstring("Mterminating connection due to administrator command"),
      Buffer.from("\0"),
    ]),
  );

function fakePostgres() {
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let buffer = Buffer.alloc(0);
    let started = false;
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (!started) {
          if (buffer.length < 4 || buffer.length < buffer.readInt32BE(0)) return;
          buffer = buffer.subarray(buffer.readInt32BE(0));
          started = true;
          socket.write(Buffer.concat([message("R", int32(0)), ready()]));
          continue;
        }
        if (buffer.length < 5 || buffer.length < buffer.readInt32BE(1) + 1) return;
        const type = String.fromCharCode(buffer[0]);
        buffer = buffer.subarray(buffer.readInt32BE(1) + 1);
        if (type === "Q") socket.write(oneRow());
        if (type === "X") socket.end();
      }
    });
  });
  return {
    server,
    // What Postgres does to every backend when it is shut down or recreated.
    terminateAll() {
      for (const socket of sockets) socket.end(adminShutdown());
    },
    get connections() {
      return sockets.size;
    },
  };
}

const saved = { ...process.env };
afterEach(async () => {
  await closeDatabase();
  process.env = { ...saved };
  vi.restoreAllMocks();
});

it("survives Postgres dropping an idle pooled connection and reconnects", async () => {
  const postgres = fakePostgres();
  postgres.server.listen(0, "127.0.0.1");
  await once(postgres.server, "listening");
  const { port } = postgres.server.address() as AddressInfo;
  process.env.POSTGRES_URL = `postgres://sprite:sprite@127.0.0.1:${port}/sprite`;
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const uncaught = vi.fn();
  process.on("uncaughtException", uncaught);
  try {
    const pool = getDatabase();
    expect((await pool.query("SELECT 1")).rows).toEqual([{ value: 1 }]);
    expect(pool.idleCount).toBe(1);

    // No test-side "error" listener: the app's own listener must be the one
    // that keeps pg's emit from becoming an uncaught exception.
    postgres.terminateAll();
    for (let i = 0; !logged.mock.calls.length && !uncaught.mock.calls.length && i < 100; i++)
      await new Promise((done) => setTimeout(done, 10));
    expect(uncaught).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalledWith(
      "[db] Idle database client failed: terminating connection due to administrator command",
    );
    for (let i = 0; pool.totalCount > 0 && i < 100; i++)
      await new Promise((done) => setTimeout(done, 10));
    expect(pool.totalCount).toBe(0);

    expect((await pool.query("SELECT 1")).rows).toEqual([{ value: 1 }]);
    expect(uncaught).not.toHaveBeenCalled();
  } finally {
    process.off("uncaughtException", uncaught);
    await closeDatabase();
    postgres.server.close();
  }
});

it("still rejects an active query when its connection dies", async () => {
  const postgres = fakePostgres();
  // Never answer queries, so the query is in flight when the server ends it.
  postgres.server.removeAllListeners("connection");
  postgres.server.on("connection", (socket: Socket) => {
    socket.on("error", () => {});
    let started = false;
    socket.on("data", (chunk) => {
      if (!started) {
        started = true;
        socket.write(Buffer.concat([message("R", int32(0)), ready()]));
        return;
      }
      if (String.fromCharCode(chunk[0]) === "Q") socket.end(adminShutdown());
    });
  });
  postgres.server.listen(0, "127.0.0.1");
  await once(postgres.server, "listening");
  const { port } = postgres.server.address() as AddressInfo;
  process.env.POSTGRES_URL = `postgres://sprite:sprite@127.0.0.1:${port}/sprite`;
  vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await expect(getDatabase().query("SELECT 1")).rejects.toThrow(
      "terminating connection due to administrator command",
    );
  } finally {
    await closeDatabase();
    postgres.server.close();
  }
});
