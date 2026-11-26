import * as z from "zod";
import { SandboxError } from "../errors.js";
import type {
  Disk as WireDisk,
  DiskAttachRequest,
  DiskList,
  FileInfo as WireFileInfo,
  OutputEvent,
  PortExposure as WirePortExposure,
  PortExposureList,
  Process as WireProcess,
  ProcessList,
  ProcessSpec as WireProcessSpec,
} from "../generated/types.gen.js";
import type {
  Disk,
  DiskAttachInput,
  FileInfo,
  OutputChunk,
  PortExposure,
  Process,
  ProcessOutputStats,
  ProcessSpec,
  ProcessState,
} from "../types.js";

export function toProcessSpec(input: ProcessSpec): WireProcessSpec {
  const spec: WireProcessSpec = {};
  if (input.cmd !== undefined) spec.cmd = input.cmd;
  if (input.shell !== undefined) spec.shell = input.shell;
  if (input.cwd !== undefined) spec.cwd = input.cwd;
  if (input.env !== undefined) spec.env = input.env;
  if (input.timeoutSeconds !== undefined) spec.timeout_seconds = input.timeoutSeconds;
  return spec;
}

export function toDiskAttachRequest(input: DiskAttachInput): DiskAttachRequest {
  const request: DiskAttachRequest = { entity_id: input.entityId, entity_jwt: input.entityJwt };
  if (input.mountPath !== undefined) request.mount_path = input.mountPath;
  return request;
}

const OUTPUT_EVENT_TYPES: ReadonlyArray<OutputEvent["type"]> = ["stdout", "stderr", "gap", "exit"];
const OUTPUT_STREAMS: ReadonlyArray<"stdout" | "stderr"> = ["stdout", "stderr"];
const PROCESS_STATES: ReadonlyArray<ProcessState> = ["running", "exited", "killed", "lost"];

function oneOf<T extends string>(values: ReadonlyArray<T>): (value: unknown) => value is T {
  return (value): value is T => values.some((v) => v === value);
}
const isNumber = (value: unknown): value is number => typeof value === "number";
const isString = (value: unknown): value is string => typeof value === "string";
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";

/** Validates one decoded NDJSON line against the vendored `OutputEvent` shape. */
export function parseOutputEvent(value: unknown): OutputEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SandboxError(`malformed output event: ${JSON.stringify(value)}`);
  }
  const raw: Record<string, unknown> = { ...value };
  const field = <T>(key: string, check: (v: unknown) => v is T): T | undefined => {
    const v = raw[key];
    if (v === undefined || v === null) return undefined;
    if (!check(v))
      throw new SandboxError(`malformed output event: bad ${key} ${JSON.stringify(v)}`);
    return v;
  };
  const type = field("type", oneOf(OUTPUT_EVENT_TYPES));
  if (type === undefined) throw new SandboxError("malformed output event: missing type");
  return {
    type,
    offset: field("offset", isNumber),
    data: field("data", isString),
    stream: field("stream", oneOf(OUTPUT_STREAMS)),
    from: field("from", isNumber),
    to: field("to", isNumber),
    state: field("state", oneOf(PROCESS_STATES)),
    exit_code: field("exit_code", isNumber),
    signal: field("signal", isString),
    timed_out: field("timed_out", isBoolean),
  };
}

export function toOutputChunk(value: unknown): OutputChunk {
  const event = parseOutputEvent(value);
  switch (event.type) {
    case "stdout":
    case "stderr":
      return {
        type: event.type,
        offset: event.offset ?? 0,
        data: new Uint8Array(Buffer.from(event.data ?? "", "base64")),
      };
    case "gap":
      return {
        type: "gap",
        stream: event.stream ?? "stdout",
        from: event.from ?? 0,
        to: event.to ?? 0,
      };
    case "exit":
      return {
        type: "exit",
        state: event.state ?? "lost",
        exitCode: event.exit_code,
        signal: event.signal,
        timedOut: event.timed_out ?? false,
      };
  }
}

const Timestamp = z.iso.datetime({ offset: true });

const OutputStatsBody = z.object({
  total_bytes: z.number().int(),
  retained_from: z.number().int(),
  truncated: z.boolean(),
});

const ProcessSpecBody = z.object({
  cmd: z.array(z.string()).optional(),
  shell: z.string().optional(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  timeout_seconds: z.number().int().optional(),
});

const ProcessBody = z.object({
  id: z.string(),
  state: z.enum(PROCESS_STATES),
  spec: ProcessSpecBody,
  pid: z.number().int().optional(),
  exit_code: z.number().int().optional(),
  signal: z.string().optional(),
  timed_out: z.boolean().optional(),
  created_at: Timestamp,
  started_at: Timestamp.optional(),
  finished_at: Timestamp.optional(),
  stdout: OutputStatsBody,
  stderr: OutputStatsBody,
}) satisfies z.ZodType<WireProcess>;

const PortExposureBody = z.object({
  port: z.number().int(),
  rand: z.string(),
  hostname: z.string(),
  url: z.string(),
  created_at: Timestamp,
}) satisfies z.ZodType<WirePortExposure>;

const FileInfoBody = z.object({
  path: z.string(),
  size: z.number().int(),
  mode: z.string(),
  mod_time: Timestamp,
}) satisfies z.ZodType<WireFileInfo>;

const DiskBody = z.object({
  slot: z.number().int(),
  device: z.string(),
  entity_id: z.number().int(),
  capacity_gb: z.number().int(),
  attached_at: Timestamp,
  detached_at: Timestamp.optional(),
  mount_path: z.string().optional(),
}) satisfies z.ZodType<WireDisk>;

const ProcessListBody = z.object({
  processes: z.array(ProcessBody),
}) satisfies z.ZodType<ProcessList>;
const PortExposureListBody = z.object({
  ports: z.array(PortExposureBody),
}) satisfies z.ZodType<PortExposureList>;
const DiskListBody = z.object({ disks: z.array(DiskBody) }) satisfies z.ZodType<DiskList>;

function optionalDate(value: string | undefined): Date | undefined {
  return value === undefined ? undefined : new Date(value);
}

function fromOutputStats(wire: WireProcess["stdout"]): ProcessOutputStats {
  return {
    totalBytes: wire.total_bytes,
    retainedFrom: wire.retained_from,
    truncated: wire.truncated,
  };
}

function fromProcessSpec(wire: WireProcessSpec): ProcessSpec {
  return {
    cmd: wire.cmd,
    shell: wire.shell,
    cwd: wire.cwd,
    env: wire.env,
    timeoutSeconds: wire.timeout_seconds,
  };
}

function fromProcess(wire: WireProcess): Process {
  return {
    id: wire.id,
    state: wire.state,
    spec: fromProcessSpec(wire.spec),
    pid: wire.pid,
    exitCode: wire.exit_code,
    signal: wire.signal,
    timedOut: wire.timed_out,
    createdAt: new Date(wire.created_at),
    startedAt: optionalDate(wire.started_at),
    finishedAt: optionalDate(wire.finished_at),
    stdout: fromOutputStats(wire.stdout),
    stderr: fromOutputStats(wire.stderr),
  };
}

function fromPortExposure(wire: WirePortExposure): PortExposure {
  return {
    port: wire.port,
    hostname: wire.hostname,
    url: wire.url,
    createdAt: new Date(wire.created_at),
  };
}

function fromFileInfo(wire: WireFileInfo): FileInfo {
  return {
    path: wire.path,
    size: wire.size,
    mode: wire.mode,
    lastModified: new Date(wire.mod_time),
  };
}

function fromDisk(wire: WireDisk): Disk {
  return {
    slot: wire.slot,
    device: wire.device,
    entityId: wire.entity_id,
    capacityGb: wire.capacity_gb,
    attachedAt: new Date(wire.attached_at),
    detachedAt: optionalDate(wire.detached_at),
    mountPath: wire.mount_path,
  };
}

/** Parses an agent JSON body, so a body that departs from the vendored spec fails here. */
function parseBody<T>(schema: z.ZodType<T>, what: string, body: Uint8Array): T {
  const json: unknown = JSON.parse(new TextDecoder().decode(body));
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new SandboxError(`malformed ${what} response from the sandbox agent`, {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

export const decodeProcess = (body: Uint8Array): Process =>
  fromProcess(parseBody(ProcessBody, "process", body));
export const decodeProcessList = (body: Uint8Array): Process[] =>
  parseBody(ProcessListBody, "process list", body).processes.map(fromProcess);
export const decodePortExposure = (body: Uint8Array): PortExposure =>
  fromPortExposure(parseBody(PortExposureBody, "port exposure", body));
export const decodePortExposureList = (body: Uint8Array): PortExposure[] =>
  parseBody(PortExposureListBody, "port exposure list", body).ports.map(fromPortExposure);
export const decodeFileInfo = (body: Uint8Array): FileInfo =>
  fromFileInfo(parseBody(FileInfoBody, "file info", body));
export const decodeDisk = (body: Uint8Array): Disk => fromDisk(parseBody(DiskBody, "disk", body));
export const decodeDiskList = (body: Uint8Array): Disk[] =>
  parseBody(DiskListBody, "disk list", body).disks.map(fromDisk);
