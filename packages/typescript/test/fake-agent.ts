import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rename, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { pipeline } from "node:stream/promises";
import type { AddressInfo } from "node:net";
import type {
  Disk,
  DiskAttachRequest,
  ErrorCode,
  ExecResponse,
  FileInfo,
  OutputEvent,
  PortExposure,
  Process,
  ProcessSpec,
  ProcessState,
} from "../src/generated/types.gen.js";

const MAX_EXPOSED_PORTS = 32;
/** Drive slot 1 is the boot disk; the host's default `sandbox_stickydisk_slots` is 3. */
const DISK_SLOTS = [2, 3, 4];
/** The fake's own listener, which the real agent refuses to expose (the shim port). */
const SHIM_PORT = 7777;

/**
 * In-process stand-in for the fa host agent (spec/agent-openapi.yaml).
 * Processes really run via /bin/sh so output, exit codes and timing are real.
 * Auth accepts any token in `validTokens`; tokens in `expiredTokens` get
 * `token_expired`. `faults` lets tests destroy sockets before, during or instead
 * of a response, or answer 503 before a request is handled.
 */
export class FakeAgent {
  readonly validTokens = new Set<string>();
  readonly expiredTokens = new Set<string>();
  readonly requests: Array<{ method: string; path: string; authorization: string | null }> = [];
  /**
   * Each request pops one fault. `reset` destroys the socket before handling;
   * `lost-response` handles the request but destroys the socket instead of answering;
   * `cut-body` sends the headers and first body chunk, then destroys the socket;
   * `stall` sends the headers and first body chunk, then holds the socket open silently;
   * `unavailable` answers 503; `sandbox_paused`, `sandbox_failed` and `sandbox_deleted` answer
   * as the retired socket of a gone VM does; `cut-stream` drops an output stream after its first event;
   * `garbage-event` emits an NDJSON line that is not an `OutputEvent`; `pass` leaves the
   * request alone (to aim a later fault at the nth request).
   */
  readonly faults: Array<
    | "pass"
    | "reset"
    | "lost-response"
    | "cut-body"
    | "stall"
    | "unavailable"
    | "sandbox_paused"
    | "sandbox_failed"
    | "sandbox_deleted"
    | "cut-stream"
    | "garbage-event"
  > = [];

  /** Used to mint exposure hostnames: `port-<port>-<rand>-<sandboxId>.<sandboxDomain>`. */
  readonly sandboxId = "sbx-fake";
  readonly sandboxDomain = "sandboxes.test";
  /** Entities the storage agent knows, each with the one JWT it accepts for it. */
  readonly entityJwts = new Map<number, string>();
  /** Delay before `POST /disks` answers, standing in for format and mount. */
  attachDelayMs = 0;

  private server: Server | undefined;
  private root = "";
  private readonly processes = new Map<string, FakeProcess>();
  private readonly ports = new Map<number, PortExposure>();
  private readonly disks = new Map<number, Disk>();

  get url(): string {
    if (!this.server) throw new Error("not started");
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}/v1`;
  }

  get fsRoot(): string {
    return this.root;
  }

  async start(): Promise<this> {
    this.root = await mkdtemp(join(tmpdir(), "fake-agent-"));
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    return this;
  }

  async stop(): Promise<void> {
    for (const p of this.processes.values()) p.kill();
    this.ports.clear();
    this.disks.clear();
    const server = this.server;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await rm(this.root, { recursive: true, force: true });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://fake");
    const method = req.method ?? "GET";
    this.requests.push({
      method,
      path: url.pathname + url.search,
      authorization: req.headers.authorization ?? null,
    });
    res.setHeader("x-request-id", String(req.headers["x-request-id"] ?? `srv-${Date.now()}`));

    const fault = this.faults.shift();
    if (fault === "reset") {
      req.socket.destroy();
      return;
    }
    if (fault === "unavailable") {
      return sendError(res, 503, "unavailable", "sandbox is starting");
    }
    if (fault === "sandbox_paused" || fault === "sandbox_failed" || fault === "sandbox_deleted") {
      const state = fault.slice("sandbox_".length);
      return sendError(res, fault === "sandbox_deleted" ? 410 : 409, fault, `sandbox is ${state}`, {
        state,
        vm_id: "vm-old",
        ...(fault === "sandbox_failed" ? { error: "guest unreachable for 95s" } : {}),
      });
    }
    const cutStream = fault === "cut-stream";
    if (fault === "garbage-event") {
      const write = res.write.bind(res) as (...args: unknown[]) => boolean;
      res.write = (() => {
        res.write = write as typeof res.write;
        return write(`${JSON.stringify({ type: "stdout", offset: "zero", data: 42 })}\n`);
      }) as typeof res.write;
    }
    if (fault === "lost-response") {
      res.writeHead = () => {
        req.socket.destroy();
        return res;
      };
    }
    if (fault === "cut-body") {
      const write = res.write.bind(res) as (...args: unknown[]) => boolean;
      res.write = ((...args: unknown[]) => {
        const ok = write(...args);
        setImmediate(() => req.socket.destroy());
        return ok;
      }) as typeof res.write;
    }
    if (fault === "stall") {
      const write = res.write.bind(res) as (...args: unknown[]) => boolean;
      let written = false;
      res.write = ((...args: unknown[]) => {
        if (written) return true;
        written = true;
        return write(...args);
      }) as typeof res.write;
      res.end = (() => res) as typeof res.end;
    }

    if (!url.pathname.startsWith("/v1/")) return sendError(res, 404, "not_found", "no such route");
    const path = url.pathname.slice("/v1".length);

    if (method === "GET" && path === "/health") return sendJson(res, 200, { status: "ok" });

    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer ")) {
      return sendError(res, 401, "unauthorized", "missing bearer token");
    }
    const token = auth.slice("Bearer ".length);
    if (this.expiredTokens.has(token)) return sendError(res, 401, "token_expired", "token expired");
    if (!this.validTokens.has(token)) return sendError(res, 401, "unauthorized", "bad token");

    try {
      if (method === "POST" && path === "/exec") return await this.exec(req, res);
      if (method === "GET" && path === "/processes") {
        return sendJson(res, 200, {
          processes: [...this.processes.values()].map((p) => p.snapshot()),
        });
      }
      const procMatch = /^\/processes\/([^/]+)(\/output)?$/.exec(path);
      if (procMatch) {
        const id = decodeURIComponent(procMatch[1]!);
        if (procMatch[2] && method === "GET") {
          return this.output(id, url.searchParams, res, cutStream);
        }
        if (!procMatch[2] && method === "PUT") return await this.startProcess(id, req, res);
        if (!procMatch[2] && method === "GET") {
          const p = this.processes.get(id);
          if (!p) return sendError(res, 404, "not_found", `no process ${id}`);
          return sendJson(res, 200, p.snapshot());
        }
        if (!procMatch[2] && method === "DELETE") {
          const p = this.processes.get(id);
          if (!p) return sendError(res, 404, "not_found", `no process ${id}`);
          p.kill();
          this.processes.delete(id);
          res.writeHead(204).end();
          return;
        }
      }
      if (method === "GET" && path === "/ports") {
        const ports = [...this.ports.values()].sort((a, b) => a.port - b.port);
        return sendJson(res, 200, { ports });
      }
      const portMatch = /^\/ports\/([^/]+)$/.exec(path);
      if (portMatch) {
        const port = Number(portMatch[1]);
        if (!/^[1-9][0-9]{0,4}$/.test(portMatch[1]!) || port > 65535) {
          return sendError(res, 400, "invalid_argument", `bad port ${portMatch[1]}`);
        }
        if (method === "PUT") return this.exposePort(port, res);
        if (method === "DELETE") {
          if (!this.ports.delete(port)) {
            return sendError(res, 404, "not_found", `port ${port} is not exposed`);
          }
          res.writeHead(204).end();
          return;
        }
      }
      if (method === "GET" && path === "/disks") {
        const disks = [...this.disks.values()].sort((a, b) => a.slot - b.slot);
        return sendJson(res, 200, { disks });
      }
      if (method === "POST" && path === "/disks") return await this.attachDisk(req, res);
      const diskMatch = /^\/disks\/([^/]+)$/.exec(path);
      if (diskMatch && method === "DELETE") {
        const disk = this.disks.get(Number(diskMatch[1]));
        if (!disk) return sendError(res, 404, "not_found", `nothing attached at ${diskMatch[1]}`);
        disk.detached_at ??= new Date().toISOString();
        return sendJson(res, 200, disk);
      }
      if (path === "/fs/file" && method === "GET")
        return await this.readFile(url.searchParams, res);
      if (path === "/fs/file" && method === "PUT")
        return await this.writeFile(url.searchParams, req, res);
      return sendError(res, 404, "not_found", `no route ${method} ${path}`);
    } catch (error) {
      if (!res.headersSent) sendError(res, 500, "internal", String(error));
      else res.destroy();
    }
  }

  private async exec(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const spec = await readJson<ProcessSpec>(req);
    const invalid = validateSpec(spec);
    if (invalid) return sendError(res, 400, "invalid_argument", invalid);
    const proc = new FakeProcess("exec", spec, spec.timeout_seconds ?? 300, this.root);
    const started = Date.now();
    await Promise.race([proc.exited, proc.deadline]);
    const snap = proc.snapshot();
    const body: ExecResponse = {
      exit_code: snap.exit_code,
      signal: snap.signal,
      stdout: proc.stdout.toString("utf8"),
      stderr: proc.stderr.toString("utf8"),
      truncated: false,
      timed_out: snap.timed_out ?? false,
      duration_ms: Date.now() - started,
    };
    sendJson(res, 200, body);
  }

  private async startProcess(id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const spec = await readJson<ProcessSpec>(req);
    const invalid = validateSpec(spec);
    if (invalid) return sendError(res, 400, "invalid_argument", invalid);
    const existing = this.processes.get(id);
    if (existing) {
      if (specsEqual(existing.spec, spec)) return sendJson(res, 200, existing.snapshot());
      return sendError(res, 409, "conflict", "process exists with a different spec", {
        existing_spec: existing.spec,
      });
    }
    const proc = new FakeProcess(id, spec, spec.timeout_seconds ?? 0, this.root);
    this.processes.set(id, proc);
    sendJson(res, 201, proc.snapshot());
  }

  private output(
    id: string,
    params: URLSearchParams,
    res: ServerResponse,
    cutAfterFirstEvent: boolean,
  ): void {
    const proc = this.processes.get(id);
    if (!proc) return sendError(res, 404, "not_found", `no process ${id}`);
    const follow = params.get("follow") === "true";
    const which = params.get("stream") ?? "both";
    const from = {
      stdout: Number(params.get("stdout_from") ?? 0),
      stderr: Number(params.get("stderr_from") ?? 0),
    };
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    res.flushHeaders();

    const write = (event: OutputEvent) => {
      if (res.destroyed) return;
      const line = `${JSON.stringify(event)}\n`;
      if (cutAfterFirstEvent) {
        cutAfterFirstEvent = false;
        res.write(line, () => res.destroy());
        return;
      }
      res.write(line);
    };
    const emitRetained = () => {
      for (const stream of ["stdout", "stderr"] as const) {
        if (which !== "both" && which !== stream) continue;
        const buf = proc[stream];
        if (buf.length > from[stream]) {
          write({
            type: stream,
            offset: from[stream],
            data: buf.subarray(from[stream]).toString("base64"),
          });
          from[stream] = buf.length;
        }
      }
    };

    emitRetained();
    if (proc.state !== "running") {
      write(proc.exitEvent());
      res.end();
      return;
    }
    if (!follow) {
      res.end();
      return;
    }
    const onData = () => emitRetained();
    const onExit = () => {
      emitRetained();
      write(proc.exitEvent());
      res.end();
      proc.events.off("data", onData);
    };
    proc.events.on("data", onData);
    proc.events.once("exit", onExit);
    res.on("close", () => {
      proc.events.off("data", onData);
      proc.events.off("exit", onExit);
    });
  }

  private exposePort(port: number, res: ServerResponse): void {
    const existing = this.ports.get(port);
    if (existing) return sendJson(res, 200, existing);
    if (port === SHIM_PORT) {
      return sendError(res, 400, "invalid_argument", "the sandbox shim port cannot be exposed");
    }
    if (this.ports.size >= MAX_EXPOSED_PORTS) {
      return sendError(res, 409, "conflict", `at most ${MAX_EXPOSED_PORTS} ports may be exposed`);
    }
    const letters = "abcdefghijklmnopqrstuvwxyz";
    const rand = Array.from({ length: 8 }, () => letters[Math.floor(Math.random() * 26)]).join("");
    const hostname = `port-${port}-${rand}-${this.sandboxId}.${this.sandboxDomain}`;
    const exposure: PortExposure = {
      port,
      rand,
      hostname,
      url: `https://${hostname}`,
      created_at: new Date().toISOString(),
    };
    this.ports.set(port, exposure);
    sendJson(res, 201, exposure);
  }

  /** A pause, resume or crash boots a new VM, which drops every attachment. */
  restartVm(): void {
    this.disks.clear();
  }

  private async attachDisk(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson<DiskAttachRequest>(req);
    await new Promise((resolve) => setTimeout(resolve, this.attachDelayMs));
    if (!Number.isInteger(body.entity_id) || body.entity_id < 1 || !body.entity_jwt) {
      return sendError(res, 400, "invalid_argument", "entity_id and entity_jwt are required");
    }
    const jwt = this.entityJwts.get(body.entity_id);
    if (jwt === undefined) return sendError(res, 404, "not_found", "unknown entity");
    if (jwt !== body.entity_jwt) return sendError(res, 403, "forbidden", "entity token rejected");
    const attached = [...this.disks.values()].find(
      (d) => d.entity_id === body.entity_id && d.detached_at === undefined,
    );
    if (attached) {
      if (attached.mount_path !== body.mount_path) {
        return sendError(res, 409, "conflict", "entity is attached with another mount path");
      }
      return sendJson(res, 200, attached);
    }
    const slot = DISK_SLOTS.find((s) => !this.disks.has(s));
    if (slot === undefined) return sendError(res, 409, "conflict", "every disk slot is taken");
    const disk: Disk = {
      slot,
      device: `/dev/vd${String.fromCharCode("a".charCodeAt(0) + slot - 1)}`,
      entity_id: body.entity_id,
      capacity_gb: 50,
      attached_at: new Date().toISOString(),
      ...(body.mount_path === undefined ? {} : { mount_path: body.mount_path }),
    };
    this.disks.set(slot, disk);
    sendJson(res, 201, disk);
  }

  private async readFile(params: URLSearchParams, res: ServerResponse): Promise<void> {
    const path = params.get("path");
    if (!path?.startsWith("/"))
      return sendError(res, 400, "invalid_argument", "path must be absolute");
    const real = this.resolve(path);
    let info;
    try {
      info = await stat(real);
    } catch {
      return sendError(res, 404, "not_found", `no file ${path}`);
    }
    if (!info.isFile()) return sendError(res, 409, "conflict", "not a regular file");
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "last-modified": info.mtime.toUTCString(),
      "x-file-mode": formatMode(info.mode),
      "x-file-size": String(info.size),
    });
    await pipeline(createReadStream(real), res);
  }

  private async writeFile(
    params: URLSearchParams,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const path = params.get("path");
    if (!path?.startsWith("/"))
      return sendError(res, 400, "invalid_argument", "path must be absolute");
    const mode = params.get("mode") ?? "0644";
    if (!/^0?[0-7]{3,4}$/.test(mode)) return sendError(res, 400, "invalid_argument", "bad mode");
    const real = this.resolve(path);
    const parent = dirname(real);
    if (params.get("mkdir_parents") === "true") {
      await mkdir(parent, { recursive: true });
    } else {
      try {
        if (!(await stat(parent)).isDirectory()) throw new Error("not a dir");
      } catch {
        return sendError(res, 404, "not_found", `parent of ${path} does not exist`);
      }
    }
    const tmp = `${real}.tmp-${process.pid}-${Date.now()}`;
    try {
      await pipeline(req, createWriteStream(tmp, { mode: Number.parseInt(mode, 8) }));
      await rename(tmp, real);
    } catch (error) {
      await unlink(tmp).catch(() => undefined);
      throw error;
    }
    const info = await stat(real);
    const body: FileInfo = {
      path,
      size: info.size,
      mode: formatMode(info.mode),
      mod_time: info.mtime.toISOString(),
    };
    sendJson(res, 200, body);
  }

  private resolve(path: string): string {
    return join(this.root, normalize(path));
  }
}

class FakeProcess {
  readonly events = new EventEmitter();
  readonly exited: Promise<void>;
  /** Resolves when the timeout fires, right after the kill is issued; never for unlimited processes. */
  readonly deadline: Promise<void>;
  stdout = Buffer.alloc(0);
  stderr = Buffer.alloc(0);
  state: ProcessState = "running";
  private exitCode: number | undefined;
  private signal: string | undefined;
  private timedOut = false;
  private readonly child: ChildProcess;
  private readonly createdAt = new Date().toISOString();
  private finishedAt: string | undefined;

  constructor(
    readonly id: string,
    readonly spec: ProcessSpec,
    timeoutSeconds: number,
    fsRoot: string,
  ) {
    const [file, args] =
      spec.shell !== undefined
        ? ["/bin/sh", ["-c", spec.shell]]
        : [
            spec.cmd![0]!.startsWith("/") ? join(fsRoot, spec.cmd![0]!) : spec.cmd![0]!,
            spec.cmd!.slice(1),
          ];
    this.child = spawn(file, args, {
      cwd: spec.cwd,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: tmpdir(), ...spec.env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    this.child.stdout!.on("data", (chunk: Buffer) => {
      this.stdout = Buffer.concat([this.stdout, chunk]);
      this.events.emit("data");
    });
    this.child.stderr!.on("data", (chunk: Buffer) => {
      this.stderr = Buffer.concat([this.stderr, chunk]);
      this.events.emit("data");
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    this.deadline = new Promise<void>((resolve) => {
      if (timeoutSeconds <= 0) return;
      timer = setTimeout(() => {
        this.timedOut = true;
        this.killGroup();
        resolve();
      }, timeoutSeconds * 1000);
    });
    this.exited = new Promise<void>((resolve) => {
      this.child.once("error", () => {
        this.state = "lost";
        this.finish(resolve);
      });
      this.child.once("close", (code, signal) => {
        if (timer) clearTimeout(timer);
        if (signal) {
          this.state = "killed";
          this.signal = signal;
          this.exitCode = 128 + (signal === "SIGKILL" ? 9 : 15);
        } else {
          this.state = "exited";
          this.exitCode = code ?? -1;
        }
        this.finish(resolve);
      });
    });
  }

  private finish(resolve: () => void): void {
    this.finishedAt = new Date().toISOString();
    this.events.emit("exit");
    resolve();
  }

  kill(): void {
    if (this.state === "running") this.killGroup();
  }

  private killGroup(): void {
    if (this.child.pid === undefined) return;
    try {
      process.kill(-this.child.pid, "SIGKILL");
    } catch {
      this.child.kill("SIGKILL");
    }
  }

  snapshot(): Process {
    return {
      id: this.id,
      state: this.state,
      spec: this.spec,
      pid: this.child.pid,
      exit_code: this.exitCode,
      signal: this.signal,
      timed_out: this.timedOut ? true : this.state === "running" ? undefined : false,
      created_at: this.createdAt,
      started_at: this.createdAt,
      finished_at: this.finishedAt,
      stdout: { total_bytes: this.stdout.length, retained_from: 0, truncated: false },
      stderr: { total_bytes: this.stderr.length, retained_from: 0, truncated: false },
    };
  }

  exitEvent(): OutputEvent {
    return {
      type: "exit",
      state: this.state,
      exit_code: this.exitCode,
      signal: this.signal,
      timed_out: this.timedOut,
    };
  }
}

function validateSpec(spec: ProcessSpec): string | undefined {
  const hasCmd = spec.cmd !== undefined && spec.cmd.length > 0;
  const hasShell = spec.shell !== undefined;
  if (hasCmd === hasShell) return "exactly one of cmd or shell must be set";
  return undefined;
}

function specsEqual(a: ProcessSpec, b: ProcessSpec): boolean {
  const norm = (s: ProcessSpec) =>
    JSON.stringify({
      cmd: s.cmd ?? null,
      shell: s.shell ?? null,
      cwd: s.cwd ?? null,
      env: Object.fromEntries(Object.entries(s.env ?? {}).sort(([a], [b]) => a.localeCompare(b))),
      timeout_seconds: s.timeout_seconds ?? 0,
    });
  return norm(a) === norm(b);
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function sendError(
  res: ServerResponse,
  status: number,
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): void {
  sendJson(res, status, { error: { code, message, ...(details ? { details } : {}) } });
}

function formatMode(mode: number): string {
  return `0${(mode & 0o7777).toString(8).padStart(3, "0")}`;
}
