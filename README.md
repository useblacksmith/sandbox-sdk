# Blacksmith Sandbox SDKs

Client libraries for [Blacksmith](https://blacksmith.sh) sandboxes: fast-booting
microVMs with an HTTP API for running commands, managing long-lived processes,
streaming their output, moving files, exposing ports and pausing/resuming.
This repository hosts one SDK per language under `packages/`.

| Language   | Package                                                                  | Path                  | Status  |
| ---------- | ------------------------------------------------------------------------ | --------------------- | ------- |
| TypeScript | [`@useblacksmith/sandbox`](https://www.npmjs.com/package/@useblacksmith/sandbox) | `packages/typescript` | Preview |
| Python     |                                                                          | `packages/python`     | Planned |

Each package ships its own README with installation, a quickstart and the full
API reference.

## Quickstart (TypeScript)

```sh
npm install @useblacksmith/sandbox
```

```ts
import { HttpControlPlaneClient, Sandbox } from "@useblacksmith/sandbox";

const cp = new HttpControlPlaneClient({ apiKey: process.env.BLACKSMITH_API_KEY! });
const sandbox = await Sandbox.create(cp, { image: "ubuntu-24.04" });

const { exit_code, stdout } = await sandbox.exec({ cmd: ["uname", "-a"] });
console.log(exit_code, stdout);

await sandbox.writeFile("/work/build.sh", "#!/bin/sh\necho building\n", { mode: 0o755, mkdirParents: true });
await sandbox.startProcess("build", { cmd: ["/work/build.sh"], cwd: "/work" });
for await (const chunk of sandbox.streamOutput("build", { follow: true })) {
  if (chunk.type === "stdout") process.stdout.write(chunk.data);
}

await sandbox.delete();
```

## How the SDKs are built

Every sandbox exposes two HTTP surfaces, and each SDK keeps them apart:

- **Control plane** — the Blacksmith API (`https://api.blacksmith.sh`). Creates,
  lists, pauses, resumes and deletes sandboxes and mints short-lived tokens for
  the agent. Authenticated with your organization's API key.
- **Agent** — the process inside the VM, reachable at
  `https://<sandbox_id>.<sandbox-domain>/v1`. Runs commands and processes,
  streams output, reads and writes files. Authenticated with a per-sandbox JWT
  minted by the control plane; the API key is never sent to a sandbox.

The agent API is defined by an OpenAPI specification that each SDK vendors and
generates its low-level client from, so types stay in lockstep with the agent.
A handwritten layer on top adds retries that are safe to replay, token refresh
and incremental output streaming.

## Repository layout

```text
packages/
  typescript/   @useblacksmith/sandbox (Node >= 20, ESM, no runtime dependencies)
.github/
  workflows/    one workflow per package; each runs only when its package changes
```

## Status

The sandbox API is in preview. The agent API is stable; the control-plane API
(`/api/v1/sandboxes`) may still change, and each SDK isolates it behind a small
adapter so the rest of the library is unaffected. Expect breaking changes before
1.0.

## Contributing

Issues and feature requests for any SDK are welcome in this repository's
[issue tracker](https://github.com/useblacksmith/sandbox-sdk/issues).

`packages/typescript` is mirrored from Blacksmith's internal monorepo: every
change there arrives as a `copybara/sandbox-sdk` pull request that is reviewed
and merged here, so it is not edited in this repository directly and pull
requests against it will be ported rather than merged. Everything else in this
repository (this README, CI, other language packages) is maintained in place.

## License

[MIT](./LICENSE)
