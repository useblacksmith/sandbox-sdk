<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./.github/assets/wordmark-white.svg" width="300">
    <source media="(prefers-color-scheme: light)" srcset="./.github/assets/wordmark-black.svg" width="300">
    <img alt="Blacksmith" src="./.github/assets/wordmark-black.svg" width="300">
  </picture>
</p>

Client libraries for [Blacksmith](https://blacksmith.sh) sandboxes: fast-booting
microVMs you drive over HTTP. Run commands, start long-lived processes and
stream their output, move files, expose ports, and pause or resume.

Each language has its own package under `packages/`, with a README that covers
installation and the full API.

| Language   | Package                                                                          | Path                  | Status  |
| ---------- | -------------------------------------------------------------------------------- | --------------------- | ------- |
| TypeScript | [`@useblacksmith/sandbox`](https://www.npmjs.com/package/@useblacksmith/sandbox) | `packages/typescript` | Preview |

## Quickstart (TypeScript)

Requires Node 20 or later. The package is ESM.

```sh
npm install @useblacksmith/sandbox
```

```ts
import { HttpControlPlaneClient, Sandbox } from "@useblacksmith/sandbox";

const cp = new HttpControlPlaneClient({ apiKey: process.env.BLACKSMITH_API_KEY! });
const sandbox = await Sandbox.create(cp, {
  image: "ubuntu-24.04",
  workload: "ci-repro",
  tenant: "acme",
});

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

A sandbox has two HTTP APIs, and each SDK keeps them apart.

The control plane is the Blacksmith API at `https://api.blacksmith.sh`. It
creates, lists, pauses, resumes and deletes sandboxes, and mints short-lived
tokens for the agent. You authenticate with your organization's API key.

The agent is the process inside the VM, at
`https://<sandbox_id>.<sandbox-domain>/v1`. It runs commands and processes,
streams output, and reads and writes files. It takes a per-sandbox JWT minted by
the control plane, so your API key is never sent to a sandbox.

Each SDK vendors the agent's OpenAPI spec and generates its low-level client
from it, which keeps the types in step with the agent. A handwritten layer on
top refreshes tokens, streams output incrementally and retries the requests that
are safe to replay.

## Status

The sandbox API is in preview, so expect breaking changes before 1.0. The agent
API is stable. The control-plane API (`/api/v1/sandboxes`) may still change;
each SDK keeps it behind a small adapter so the rest of the library is
unaffected.

## Contributing

File issues and feature requests for any SDK in the
[issue tracker](https://github.com/useblacksmith/sandbox-sdk/issues).

`packages/typescript` is mirrored from Blacksmith's internal monorepo. Changes
arrive as `copybara/sandbox-sdk` pull requests that are reviewed and merged
here, so a pull request against that directory is ported to the monorepo rather
than merged. Everything else (this README, CI, other language packages) is
edited here directly.

Each package has its own CI workflow, which runs only when that package changes.

## License

[MIT](./LICENSE)
