# @useblacksmith/sandbox

TypeScript SDK for Blacksmith sandboxes: create a VM, run commands, move files,
stream process output, expose ports on public hostnames, attach sticky disks,
pause/resume/delete.
Node >= 20, ESM, no runtime dependencies.

## Install

```sh
npm install @useblacksmith/sandbox
```

## Quickstart

```ts
import { HttpControlPlaneClient, Sandbox } from "@useblacksmith/sandbox";

const cp = new HttpControlPlaneClient({ apiKey: process.env.BLACKSMITH_API_KEY! });
const sandbox = await Sandbox.create(cp, { image: "ubuntu-24.04" });

const { exit_code, timed_out, stdout } = await sandbox.exec({ cmd: ["uname", "-a"] });
console.log(timed_out ? "timed out" : exit_code, stdout);

await sandbox.writeFile(
  "/work/build.sh",
  "#!/bin/sh\nfor i in 1 2 3; do echo step $i; sleep 1; done\n",
  {
    mode: 0o755,
    mkdirParents: true,
  },
);

await sandbox.startProcess("build", { cmd: ["/work/build.sh"], cwd: "/work" });
for await (const chunk of sandbox.streamOutput("build", { follow: true })) {
  if (chunk.type === "stdout") process.stdout.write(chunk.data);
  if (chunk.type === "exit") console.log("exit", chunk.exitCode);
}

await sandbox.delete();
```

## Exposed ports

`exposePort(port)` gives a guest TCP port a public hostname,
`port-<port>-<rand>-<sandbox_id>.<sandbox-domain>`, on which the host
terminates TLS and reverse-proxies HTTP/1.1, WebSocket upgrades and streaming
responses to the port inside the VM. The process must listen on `0.0.0.0` (or
`[::]`), not just loopback. Traffic on the hostname is **unauthenticated**: the
8-letter `rand` in the hostname is the only secret, so treat `url` like a
capability.

```ts
await sandbox.startProcess("web", { shell: "python3 -m http.server 8080 --bind 0.0.0.0" });
const { exposure, created } = await sandbox.exposePort(8080);
console.log(created ? "exposed" : "already exposed", exposure.url);

for (const p of await sandbox.listPorts()) console.log(p.port, p.hostname);
await sandbox.unexposePort(8080);
```

`exposePort` is idempotent: the first call answers 201 (`created: true`), later
calls 200 with the same `hostname`, `rand` and `created_at`. Nothing checks that
the port is listening; the hostname answers 502 until it is. The agent refuses
its own shim port (`invalid_argument`) and more than 32 exposures (`conflict`);
`unexposePort` on a port that is not exposed is `not_found`. Exposures are
recorded on the sandbox's boot disk, so they survive pause/resume (the hostname
is stable and its DNS record follows the sandbox) and disappear with the
sandbox.

## Sticky disks

`attachDisk` serves an existing sticky disk entity on a free drive slot of the
running VM. The caller brings the credential: an entity-scoped storage-agent JWT
the control plane mints for this sandbox (same installation, region and storage
agent as the sandbox's boot disk; 1 h TTL). With `mountPath` the host mounts the
disk there in the guest, formatting a disk with no filesystem as ext4 first;
without it the guest only sees a block device at `device`.

```ts
const { disk, created } = await sandbox.attachDisk({
  entityId: credential.entity_id,
  entityJwt: credential.entity_jwt,
  mountPath: "/home/blacksmith/.gradle",
});
for (const d of await sandbox.listDisks()) console.log(d.slot, d.device, d.mount_path);
await sandbox.detachDisk(disk.slot);
```

Writes to an attached disk are discarded: nothing is ever committed back to the
entity. `attachDisk` is idempotent per entity (201 `created: true`, then 200 with
the same attachment); re-attaching with a different `mountPath` is `conflict`, as
is a full set of slots. The host answers `forbidden` when the storage agent
rejects the JWT and `not_found` when it does not know the entity. `detachDisk`
unmounts the disk and fails its drive; the slot stays taken until the VM stops.
`attachDisk` defaults to a 180s timeout and `detachDisk` to 60s. Neither is
retried: a replay while the first attempt is still running gets `conflict`.

**Attachments last for the current VM only.** `pause()`/`resume()`, an idle
pause or a crash drops them, so re-attach after every resume.

## Image snapshots

`create` takes `image`: a catalog image reference or a sandbox image snapshot
id (`snap-…`). A snapshot is a paused sandbox's boot disk, kept for a bounded
time (7 days by default) so new sandboxes can start from it. The source must be
`paused`, and a sandbox created from a snapshot cannot itself be snapshotted.
`baseImage` still works but is deprecated; use `image`.

```ts
// pause() returns once the request is accepted; the snapshot needs the boot disk persisted.
let { state } = await sandbox.pause();
while (state === "pausing") {
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  ({ state } = await sandbox.refresh());
}
const snapshot = await cp.images.snapshots.create({ sandbox: sandbox.id, ttlSeconds: 86_400 });

const child = await Sandbox.create(cp, { image: snapshot.id });

await cp.images.snapshots.list({ state: "ready" });
await cp.images.snapshots.delete(snapshot.id);
```

A snapshot lives in the source sandbox's region and arch; children are created
there too. After `expiresAt` the snapshot can no longer be used, and the backend
deletes it.

## Two clients

A sandbox has two HTTP surfaces and the SDK keeps them separate:

- **Control plane** (`SandboxControlPlane`, `HttpControlPlaneClient`): the
  Blacksmith backend. Creates, lists, pauses, resumes and deletes sandboxes and
  mints short-lived agent tokens. Authenticated with your **org API key**.
- **Agent** (`SandboxClient`): the process inside the VM at
  `https://<sandbox_id>.<sandbox-domain>/v1`. Runs commands and processes,
  reads and writes files, streams output. Authenticated with a **per-sandbox
  JWT** minted by the control plane. The org API key is never sent to the agent.

`Sandbox` combines both: it takes the token from the create response (or mints
one on `connect`), builds a `SandboxClient` and waits for `GET /health`. Use
`SandboxClient` directly when you already hold a token
(for example inside a job that was handed one) and don't need lifecycle calls.

```ts
import { SandboxClient } from "@useblacksmith/sandbox";

const client = new SandboxClient({ hostname: "sbx-123.sandboxes.blacksmith.sh", token });
await client.exec({ shell: "echo hi" });
```

## Token lifecycle

Agent tokens expire (~1h). `SandboxClient` accepts either a fixed `token` or a
`tokenProvider: () => Promise<{ token, expiresAt }>`. With a provider the client
refreshes proactively at ~80% of the token's lifetime, and on a `401
token_expired` it refreshes once and retries the request; it never loops.
`Sandbox` wires `cp.mintToken(id)` in as the provider, so a long-lived
`Sandbox` keeps working across token expiry without any caller involvement.

`POST /api/v1/sandboxes` returns the first token as `token` and `Sandbox.create`
uses it, so a create fan-out costs one control-plane call per sandbox. Only
refreshes hit `POST /api/v1/sandboxes/{id}/tokens`, which is capped at 30 mints
per minute per sandbox and 600 per org.

Every `Sandbox` attached through the same control-plane client shares one token
per sandbox: `connect` reuses the last token minted (or returned by create) for
that id until ~80% of its lifetime, and concurrent mints for one id share a
request. A 429 makes that sandbox's mints fail with the same `ControlPlaneError`
until its `Retry-After` passes, without asking the control plane again. Nothing
is retried for you.

## Errors

| Class                    | Meaning                                                                                                                                                                                                                                                                       |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SandboxApiError`        | The agent answered with an error envelope. Branch on `code` (`unauthorized`, `token_expired`, `forbidden`, `not_found`, `conflict`, `invalid_argument`, `timeout`, `unavailable`, `insufficient_storage`, `internal`); `status`, `details` and `requestId` are informational. |
| `SandboxTransportError`  | No usable HTTP response: DNS not yet propagated after create/resume, TLS EOF, `ECONNRESET`, request timeout. Carries `method`, `url`, `attempts` and the `cause`.                                                                                                             |
| `SandboxNotRunningError` | A `Sandbox` call hit a transport error and the control plane says the sandbox is not `running` (`state` tells you what it is, e.g. `paused`).                                                                                                                                 |
| `ControlPlaneError`      | The control plane answered with an error. `status` and `code` are provisional. A 429 `concurrency_limit` means one of the organization's sandbox caps is used up — concurrent vCPUs in a region (`scope: "sandbox"`), live sandboxes + snapshots across regions (`scope: "live"`), or the assigner's CI+sandbox budget (`scope: "org"`); `concurrencyLimit(err)` parses its `details` (`limit`, `inUse`, `requested`, `region`, `scope`) and `retryAfterMs` says when to try again — the SDK does not retry it for you.                                                                                                                                                                                                |

`SandboxClient` retries transport errors with bounded backoff for idempotent
calls only: every `GET`, `PUT /processes/{id}`, `PUT /ports/{port}`, every
`DELETE` except `DELETE /disks/{slot}` (a replay that finds the resource already
gone counts as success) and `PUT /fs/file` when the body can be replayed (`Uint8Array` or `string`, not a
`ReadableStream`).

`exec` is built on those: the SDK picks a process id (`exec-<uuid>`, or
`options.processId`) and runs `PUT /processes/{id}` → `GET
/processes/{id}/output?follow=true` → `DELETE /processes/{id}`. The agent keys
processes by id, so a start whose reply was lost is replayed under the same id
and the command still runs once; the output stream resumes from the last byte
offsets after a cut. The agent's `POST /exec` is not used, because it carries no
client id and cannot be retried safely. The `DELETE` runs once the call has its
answer, or when the call's deadline or your `signal` cuts the command short. If
you passed a `processId` and the call fails with a transport error, the process is
left in place so a replay under the same id finds it instead of starting the
command again; a generated id is never replayed, so that process is deleted even
when the start's own response was lost. The `DELETE` is bounded to 5s in total,
retries included.

This also covers a client that resolved a stale DNS answer right after create or
resume: it reaches a host whose sandbox-router does not own the sandbox, the
router holds the connection for a moment and then closes it without a byte, and
the SDK sees a `SandboxTransportError` and tries again.

`Sandbox` adds the "which side am I talking to" re-check on top: after a
transport error it calls `cp.get(id)`; if the sandbox is not `running` you get
`SandboxNotRunningError`, otherwise the call is retried once (and
`streamOutput` resumes from the last delivered byte offsets; `exec` keeps its
process id). `Sandbox.connect` on a `paused` sandbox returns without
waiting for the agent; call `resume()` before using it. `create`/`connect` on a
`deleting`, `deleted` or `failed` sandbox throws `SandboxNotRunningError` right
away instead of waiting for an agent that will never answer.

## Timeouts

`timeoutMs` (client option, overridable per call; default 30s) is a deadline on
the whole request. `exec` bounds each of its requests by it and the whole call
by the process's `timeoutSeconds` plus `timeoutMs` (pass `timeoutMs` to `exec`
to replace that), and
for `streamOutput` / `readFileStream` it only covers time-to-headers. Once a
stream is open it stays open until the agent ends it or the caller's `signal`
fires; pass `idleTimeoutMs` to fail the stream with `SandboxTransportError`
(`cause.name === "TimeoutError"`) when a read waits that long for the next
bytes. The timer only runs while the SDK is waiting on the network, so a slow
consumer is never counted as idle, and `Sandbox.streamOutput` does not resume a
stream that hit it. Stream requests are sent with `timeout: false` in the fetch
init so Bun's own 5-minute socket idle timeout cannot cut a quiet
`follow: true` stream; Node ignores the option.

```ts
for await (const chunk of sandbox.streamOutput("build", { follow: true, idleTimeoutMs: 600_000 })) {
  // throws SandboxTransportError if the process prints nothing for 10 minutes
}
```

## Control plane is provisional

The `/api/v1/sandboxes` backend API is not finalized. Everything that touches
it lives in `src/control-plane.ts` and is expected to change; the rest of the
SDK depends only on the `SandboxControlPlane` interface, so custom or future
adapters plug into `Sandbox` unchanged. `SandboxRecord` deliberately models
only `id`, `state`, `hostname`, `hostnames`, `createdAt` and (on create) `token`; the full
backend response is available as `raw`.

## Agent spec

The agent HTTP API is defined by `FastActions/fa` at
`agent/sandboxapi/openapi.yaml`. This package vendors that spec under `spec/`
and generates types into `src/generated/`.

## Development

The SDK is developed in a Blacksmith-internal repository and mirrored to
`packages/typescript` of
[useblacksmith/sandbox-sdk](https://github.com/useblacksmith/sandbox-sdk) by
Copybara as a pull request on every change. The mirror is output: file issues
there; code changes land through the mirror.

```sh
pnpm install
pnpm run generate    # regenerate src/generated from spec/agent-openapi.yaml
pnpm run check:types
pnpm run check:lint
pnpm run test
```

## Vendored agent spec

`spec/agent-openapi.yaml` is a byte-exact copy of the fa spec at the commit
recorded in `spec/agent-openapi.source.json`. CI re-fetches that commit and
fails if the vendored copy or `src/generated/` differs. The scripts below live
in the monorepo only; they need access to `FastActions/fa`.

```sh
scripts/check-spec-drift                    # compare against fa (network)
FA_DIR=~/fa scripts/check-spec-drift        # compare against a local fa clone
scripts/check-spec-drift --skip-fetch       # only check src/generated is current

scripts/bump-spec <fa-commit>               # re-vendor at a new commit and regenerate
```

Never edit `spec/agent-openapi.yaml` or `src/generated/` by hand; fa is the
single source of truth and `bump-spec` is the only way the pin moves.
