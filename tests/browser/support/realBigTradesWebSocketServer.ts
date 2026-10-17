import { createServer, type IncomingMessage, type Server } from "node:http";
import { createHash } from "node:crypto";
import type { Socket } from "node:net";

export type BigTradeSubscription = { markets: string[]; minNotionalUsd: number };
export type BigTradeSubscriptionEvent = BigTradeSubscription & { connectionId: number; requestId: string };
export type BigTradeFrame = {
  id: string; time: number; market: string; price: number; qty: number;
  notionalUsd: number; isBuy: boolean;
};

type Connection = {
  socket: Socket;
  connectionId: number;
  sequence: number;
  subscriptions: BigTradeSubscription | null;
  closed: boolean;
  buffer: Buffer;
};

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_FRAME = 1024 * 1024;
const MAX_CONNECTIONS = 16;
const CLOSE_TIMEOUT_MS = 1_000;

export class RealBigTradesWebSocketServer {
  private readonly server: Server;
  private readonly connections = new Set<Connection>();
  private readonly subscriptions: BigTradeSubscription[] = [];
  private readonly subscriptionEvents: BigTradeSubscriptionEvent[] = [];
  private readonly desired: string[][] = [];
  private nextConnectionId = 1;
  private readonly paths: string[] = [];
  private listening = false;
  private disposed = false;
  private portNumber = 0;

  constructor() {
    this.server = createServer((_request, response) => {
      response.writeHead(404).end();
    });
    this.server.on("upgrade", (request, socket, head) => this.upgrade(request, socket, head));
  }

  async listen(requestedPort = 0): Promise<void> {
    if (this.disposed) throw new Error("Big Trades WebSocket server is disposed");
    await new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        this.server.off("listening", onListening);
        if (error.code === "EADDRINUSE") {
          reject(new Error(`Big Trades WebSocket server could not bind 127.0.0.1:${requestedPort}: address already in use`, { cause: error }));
          return;
        }
        reject(error);
      };
      const onListening = () => {
        this.server.off("error", onError);
        const address = this.server.address();
        if (!address || typeof address === "string") return reject(new Error("Missing server address"));
        this.portNumber = address.port;
        this.listening = true;
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(requestedPort, "127.0.0.1");
    });
  }

  get port(): number { if (!this.listening) throw new Error("Server is not listening"); return this.portNumber; }
  get httpUrl(): string { return `http://127.0.0.1:${this.port}`; }
  get url(): string { return `ws://127.0.0.1:${this.port}/api/big-trades/stream`; }
  get bigTradeDesired(): string[][] { return this.desired; }
  get bigTradeSubscriptions(): BigTradeSubscription[] { return this.subscriptions; }
  get bigTradeSubscriptionEvents(): BigTradeSubscriptionEvent[] { return this.subscriptionEvents; }
  get socketPaths(): string[] { return this.paths; }

  async waitForSubscription(timeoutMs = 5_000): Promise<BigTradeSubscription> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = this.subscriptions.at(-1);
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Timed out waiting for Big Trades subscription");
  }

  observeSubscribe(timeoutMs = 5_000): Promise<BigTradeSubscription> { return this.waitForSubscription(timeoutMs); }

  pushBigTrade(trade: BigTradeFrame): void { this.pushBigTrades([trade]); }
  pushBigTrades(trades: BigTradeFrame[]): void {
    if (trades.length === 0) return;
    for (const connection of this.connections) {
      if (connection.closed || !connection.subscriptions) continue;
      connection.sequence += 1;
      this.sendText(connection, JSON.stringify({ type: "trades", v: 1, sequence: connection.sequence, trades }));
    }
  }

  async closeCurrentActiveConnection(reason = "TASK-499"): Promise<void> {
    const connection = [...this.connections].at(-1);
    if (!connection || connection.closed) return;
    connection.closed = true;
    this.sendFrame(connection.socket, Buffer.from([0x03, 0xf5, ...Buffer.from(reason)]), 0x8);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { connection.socket.destroy(); resolve(); }, CLOSE_TIMEOUT_MS);
      connection.socket.once("close", () => { clearTimeout(timer); resolve(); });
      connection.socket.end();
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const connection of this.connections) {
      connection.closed = true;
      connection.socket.destroy();
    }
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.connections.clear();
  }

  private upgrade(request: IncomingMessage, socket: Socket, head: Buffer): void {
    const connectionHeader = request.headers.connection;
    const connectionTokens = typeof connectionHeader === "string"
      ? connectionHeader.split(",").map((token) => token.trim().toLowerCase())
      : [];
    const key = request.headers["sec-websocket-key"];
    const validKey = typeof key === "string" &&
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/.test(key) &&
      Buffer.from(key, "base64").length === 16 &&
      Buffer.from(key, "base64").toString("base64").replace(/=+$/, "") === key.replace(/=+$/, "");
    if (this.connections.size >= MAX_CONNECTIONS ||
        request.method !== "GET" ||
        request.url !== "/api/big-trades/stream" ||
        request.headers.upgrade?.toLowerCase() !== "websocket" ||
        !connectionTokens.includes("upgrade") ||
        request.headers["sec-websocket-version"] !== "13" ||
        !validKey) {
      socket.destroy();
      return;
    }
    const accept = createHash("sha1").update(key + GUID).digest("base64");
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
    const connection: Connection = { socket, connectionId: this.nextConnectionId++, sequence: 0, subscriptions: null, closed: false, buffer: head };
    this.connections.add(connection);
    this.paths.push(request.url);
    socket.on("data", (chunk) => this.readFrames(connection, chunk));
    socket.on("close", () => { connection.closed = true; this.connections.delete(connection); });
    socket.on("error", () => { connection.closed = true; this.connections.delete(connection); });
    if (head.length) this.readFrames(connection, Buffer.alloc(0));
  }

  private readFrames(connection: Connection, chunk: Buffer): void {
    if (connection.closed) return;
    connection.buffer = Buffer.concat([connection.buffer, chunk]);
    if (connection.buffer.length > MAX_FRAME * 2) { connection.socket.destroy(); return; }
    while (connection.buffer.length >= 2) {
      const first = connection.buffer[0], second = connection.buffer[1];
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f, offset = 2;
      if (!masked || first & 0x70) { connection.socket.destroy(); return; }
      if (length === 126) {
        if (connection.buffer.length < 4) return;
        length = connection.buffer.readUInt16BE(2); offset = 4;
      } else if (length === 127) { connection.socket.destroy(); return; }
      if (length > MAX_FRAME || connection.buffer.length < offset + 4 + length) return;
      const mask = connection.buffer.subarray(offset, offset + 4); offset += 4;
      const payload = Buffer.from(connection.buffer.subarray(offset, offset + length));
      connection.buffer = connection.buffer.subarray(offset + length);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      if ((first & 0x0f) === 0x8) { connection.socket.destroy(); return; }
      if ((first & 0x0f) !== 0x1) continue;
      this.handleText(connection, payload.toString("utf8"));
    }
  }

  private handleText(connection: Connection, text: string): void {
    let request: unknown;
    try { request = JSON.parse(text); } catch { return; }
    if (!request || typeof request !== "object") return;
    const subscribe = request as { type?: unknown; requestId?: unknown; markets?: unknown; minNotionalUsd?: unknown };
    if (subscribe.type !== "subscribe" || typeof subscribe.requestId !== "string" ||
        !Array.isArray(subscribe.markets) || subscribe.markets.some((market) => typeof market !== "string") ||
        typeof subscribe.minNotionalUsd !== "number" || !Number.isFinite(subscribe.minNotionalUsd)) return;
    const markets = [...subscribe.markets] as string[];
    connection.subscriptions = { markets, minNotionalUsd: subscribe.minNotionalUsd };
    const subscription = { markets, minNotionalUsd: subscribe.minNotionalUsd };
    this.desired.push(markets);
    this.subscriptions.push(subscription);
    connection.sequence += 1;
    this.sendText(connection, JSON.stringify({
      type: "subscribed", v: 1, sequence: connection.sequence, requestId: subscribe.requestId,
      markets, minNotionalUsd: subscribe.minNotionalUsd,
    }));
    this.subscriptionEvents.push({
      connectionId: connection.connectionId,
      requestId: subscribe.requestId,
      markets: [...markets],
      minNotionalUsd: subscribe.minNotionalUsd,
    });
  }

  private sendText(connection: Connection, text: string): void { this.sendFrame(connection.socket, Buffer.from(text), 0x1); }
  private sendFrame(socket: Socket, payload: Buffer, opcode: number): void {
    if (payload.length > MAX_FRAME) throw new Error("WebSocket payload exceeds test bound");
    const header = payload.length < 126 ? Buffer.from([0x80 | opcode, payload.length]) :
      Buffer.from([0x80 | opcode, 126, payload.length >> 8, payload.length & 0xff]);
    socket.write(Buffer.concat([header, payload]));
  }
}
