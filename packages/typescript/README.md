# @useblacksmith/sandbox

TypeScript SDK for Blacksmith sandboxes: create a VM, run commands, move files,
stream process output, expose ports on public hostnames, pause/resume/delete.
Node >= 20, ESM, no runtime dependencies.

## Install

```sh
npm install @useblacksmith/sandbox
```

## Quickstart

```ts
import { Blacksmith } from "@useblacksmith/sandbox";

const bs = new Blacksmith(); // reads BLACKSMITH_API_KEY; or new Blacksmith({ apiKey })
const sandbox = await bs.sandboxes.create({ image: "ubuntu24", workload: "ci-repro" });

const { exitCode, timedOut, stdout } = await sandbox.exec({ cmd: ["uname", "-a"] });
console.log(timedOut ? "timed out" : exitCode, stdout);

await sandbox.writeFile(
  "/work/build.sh",
  "#!/bin/sh\nfor i in 1 2 3; do echo step $i; sleep 1; done\n",
  {
    mode: 0o755,
    mkdirParents: true,
  },
);

const build = await sandbox.startProcess({ cmd: ["/work/build.sh"], cwd: "/work" });
for await (const chunk of sandbox.streamOutput(build.id, { follow: true })) {
  if (chunk.type === "stdout") process.stdout.write(chunk.data);
  if (chunk.type === "exit") console.log("exit", chunk.exitCode);
}

await sandbox.delete();
```

`bs.sandboxes.connect(id)` returns a handle on an existing sandbox;
`bs.sandboxes.get(id)`, `list()` and `delete(id)` read and delete records
without one. Create one `Blacksmith` and reuse it.

## Workload and tenant

`create` requires `workload`: the kind of work this sandbox does, such as
`agent-session`, `test-runner` or `pr-review`. Blacksmith reports usage per
workload, so a clear, stable name lets you see what each kind of work costs.
Keep the set small and reuse values: a name used by one sandbox tells you
nothing.

`tenant` is optional: whose work this is, when you run sandboxes on behalf of
your own customers or teams, such as `acme`. Use a stable id or name, and
always send it in the same form. Leave it out when every sandbox is your own.

```ts
await bs.sandboxes.create({ image: "ubuntu24", workload: "test-runner", tenant: "acme" });
```

Both are letters, digits, `.`, `_` and `-`, start with a letter or digit, and
are at most 1024 characters; `workload` is lowercase only. `create` throws
a `TypeError` for a value that breaks these rules before any request is sent. The record returns
them as `workload` and `tenant`. Anything that differs per sandbox (a session
id, a branch) belongs in `labels`.

## Lifetime

Three create options bound how long a sandbox lives. All are off by default, so
a sandbox created without them runs until you delete it.

- `idleTimeoutSeconds` (60 to 604800): pause the sandbox after this long with
  no request to it and no process output. Pausing keeps the boot disk and does
  not delete the sandbox; `resume()` brings it back.
- `ttlSeconds` (60 to 2592000): delete the sandbox this long after creation,
  whatever its state. Activity and resume do not extend it.
- `idleDeleteTimeoutSeconds` (3600 to 2592000): delete the sandbox once it is
  paused or failed and this long has passed since its last activity. It never
  deletes a running sandbox, so pair it with `idleTimeoutSeconds`.

```ts
await bs.sandboxes.create({
  image: "ubuntu24",
  workload: "agent-session",
  idleTimeoutSeconds: 15 * 60,
  idleDeleteTimeoutSeconds: 24 * 60 * 60,
  ttlSeconds: 7 * 24 * 60 * 60,
});
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
await sandbox.startProcess({ shell: "python3 -m http.server 8080 --bind 0.0.0.0" });
const exposure = await sandbox.exposePort(8080);
console.log(exposure.url);

for (const p of await sandbox.listPorts()) console.log(p.port, p.hostname);
await sandbox.unexposePort(8080);
```

`exposePort` is idempotent: a later call for the same port returns the same
`hostname` and `createdAt`. Nothing checks that
the port is listening; the hostname answers 502 until it is. The agent refuses
its own shim port (`invalid_argument`) and more than 32 exposures (`conflict`);
`unexposePort` on a port that is not exposed is `not_found`. Exposures are
recorded on the sandbox's boot disk, so they survive pause/resume (the hostname
is stable and its DNS record follows the sandbox) and disappear with the
sandbox.

## Image snapshots

`create` takes `image`: a catalog image reference or a sandbox image snapshot
id (`snap-…`). A snapshot is a paused sandbox's boot disk, kept for a bounded
time (7 days by default) so new sandboxes can start from it. The source must be
`paused`, and a sandbox created from a snapshot cannot itself be snapshotted.

```ts
await sandbox.pause(); // resolves once the boot disk is kept
const snapshot = await bs.snapshots.create({ sandbox: sandbox.id, ttlSeconds: 86_400 });

const child = await bs.sandboxes.create({ image: snapshot.id, workload: "ci-repro" });

await bs.snapshots.list({ state: "ready" });
await bs.snapshots.delete(snapshot.id);
```

A snapshot lives in the source sandbox's region and arch; children are created
there too. After `expiresAt` the snapshot can no longer be used, and the backend
deletes it.

## How it works

A sandbox has two HTTP surfaces and `Blacksmith` talks to both for you:

- **Blacksmith API**: creates, lists, pauses, resumes and deletes sandboxes and
  mints short-lived agent tokens. Authenticated with your **org API key**.
- **Agent**: the process inside the VM at
  `https://<sandbox_id>.<sandbox-domain>/v1`. Runs commands and processes,
  reads and writes files, streams output. Authenticated with a **per-sandbox
  token** minted by the Blacksmith API. The org API key is never sent to the
  agent.

A `Sandbox` handle sends lifecycle calls (`pause`, `resume`, `delete`) to the
API and everything else straight to the agent.

## Token lifecycle

Agent tokens expire (~1h). A `Sandbox` refreshes its token at ~80% of the
token's lifetime, and on a `401 token_expired` it refreshes once and retries
the request; it never loops. A long-lived `Sandbox` keeps working across token
expiry without any caller involvement.

`POST /api/v1/sandboxes` returns the first token as `token` and `create`
uses it, so a create fan-out costs one control-plane call per sandbox. Only
refreshes hit `POST /api/v1/sandboxes/{id}/tokens`, which is capped at 30 mints
per minute per sandbox and 600 per org.

Every `Sandbox` from the same `Blacksmith` instance shares one token
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

The SDK retries agent transport errors with bounded backoff for idempotent
calls only: every `GET`, `PUT /processes/{id}`, `PUT /ports/{port}`, every
`DELETE` (a replay that finds the resource already gone counts as success) and `PUT /fs/file` when the body can be replayed (`Uint8Array` or `string`, not a
`ReadableStream`).

`exec` is built on those: the SDK picks a process id (`exec-<uuid>`) and runs `PUT /processes/{id}` → `GET
/processes/{id}/output?follow=true` → `DELETE /processes/{id}`. The agent keys
processes by id, so a start whose reply was lost is replayed under the same id
and the command still runs once; the output stream resumes from the last byte
offsets after a cut. The agent's `POST /exec` is not used, because it carries no
client id and cannot be retried safely. The `DELETE` runs once the call has its
answer, or when the call's deadline or your `signal` cuts the command short; it
is bounded to 5s in total, retries included.

`startProcess` works the same way: the SDK picks the id (`proc-<uuid>`) before
the first attempt and returns it as `Process.id`, so its own retries start the
command once. You do not choose process ids. A second `startProcess` call always
starts a second process; keep the returned id, or find the process again with
`listProcesses()`.

This also covers a client that resolved a stale DNS answer right after create or
resume: it reaches a host whose sandbox-router does not own the sandbox, the
router holds the connection for a moment and then closes it without a byte, and
the SDK sees a `SandboxTransportError` and tries again.

`Sandbox` adds the "which side am I talking to" re-check on top: after a
transport error it asks the API for the sandbox's state; if the sandbox is not `running` you get
`SandboxNotRunningError`, otherwise the call is retried once (and
`streamOutput` resumes from the last delivered byte offsets; `exec` keeps its
process id). `connect` on a `paused` sandbox returns without
waiting for the agent; call `resume()` before using it. `pause()` resolves once
the sandbox is `paused` and `resume()` once it is `running` and answers; each
takes an optional `timeoutMs` and waits 30s by default. The last state read
starts at `timeoutMs`, so a call settles up to one request after it and returns
the target state if that read reports it. `create`/`connect` on a
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
`follow: true` stream; Node ignores the option and cuts a response that sends
no bytes for 300s. `exec` resumes its output stream from the last offsets each
time that happens, however often, until its own deadline; a `streamOutput`
caller on Node resumes the same way or passes a `fetch` without that timeout.

```ts
for await (const chunk of sandbox.streamOutput("build", { follow: true, idleTimeoutMs: 600_000 })) {
  // throws SandboxTransportError if the process prints nothing for 10 minutes
}
```

## Control plane is provisional

The `/api/v1/sandboxes` backend API is not finalized. `SandboxRecord`
deliberately models only `id`, `state`, `hostname`, `hostnames`, `createdAt`;
the full backend response is available as `raw`.

## Internal entry

`@useblacksmith/sandbox/internal` exports the layers `Blacksmith` is built
from (`HttpControlPlaneClient`, `SandboxControlPlane`, `SandboxClient`,
`TokenProvider`) and the `Sandbox` class itself, whose `Sandbox.create(cp, …)`
and `Sandbox.connect(cp, …)` take a control plane. The main entry exports
`Sandbox` as a type only: get one from `bs.sandboxes.create` or
`bs.sandboxes.connect`. Blacksmith's own services use it. It is not covered by
semver: pin an exact version if you import it.

In the source, `src/internal/` holds everything only that entry exports. The
main entry (`src/index.ts`) exports nothing from `src/internal/`: `Sandbox`
there is an interface in `src/sandbox.ts`, which the class in
`src/internal/sandbox.ts` implements. `test/entry.test.ts` checks this.

## Agent spec

The agent HTTP API is defined by `FastActions/fa` at
`agent/sandboxapi/openapi.yaml`. This package vendors that spec under `spec/`
and generates types into `src/generated/`.

The generated types describe the wire and stay private. The types callers see
are handwritten in `src/types.ts` and `src/errors.ts`, in camelCase with `Date`
timestamps, so a spec or generator change cannot rename a public type. Two rules
keep it that way, and `test/entry.test.ts` checks both:

- No file outside `src/internal/` and `test/` imports or exports a generated type.
- A file under `src/internal/` imports a generated type only to read agent JSON
  or write a request body. Today that is `src/internal/wire.ts` alone, which
  converts between the two shapes. Each imported name is listed in the test, so
  adding one is a reviewed change.

`wire.ts` parses each agent JSON body with a handwritten zod schema before
converting it, so a body that departs from the spec throws a `SandboxError`
naming the response, with the zod error as its `cause`.

After a spec bump, a field the spec renames or removes fails the type check in
`wire.ts`. A field the spec adds reaches callers once it is added to the
handwritten type and its converter.

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
