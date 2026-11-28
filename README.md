<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./.github/assets/wordmark-white.svg" width="300">
    <source media="(prefers-color-scheme: light)" srcset="./.github/assets/wordmark-black.svg" width="300">
    <img alt="Blacksmith" src="./.github/assets/wordmark-black.svg" width="300">
  </picture>
</p>

Client libraries for [Blacksmith](https://blacksmith.sh) sandboxes: fast-booting
microVMs you drive over HTTP. Run commands, start long-lived processes and
stream their output, move files, expose ports, pause or resume, and start new
sandboxes from a snapshot.

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
import { Blacksmith } from "@useblacksmith/sandbox";

const bs = new Blacksmith(); // reads BLACKSMITH_API_KEY
const sandbox = await bs.sandboxes.create({
  image: "ubuntu24",
  workload: "ci-repro",
  tenant: "acme",
});

const { exitCode, stdout } = await sandbox.exec({ cmd: ["uname", "-a"] });
console.log(exitCode, stdout);

await sandbox.writeFile("/work/build.sh", "#!/bin/sh\necho building\n", { mode: 0o755, mkdirParents: true });
const build = await sandbox.startProcess({ cmd: ["/work/build.sh"], cwd: "/work" });
for await (const chunk of sandbox.streamOutput(build.id, { follow: true })) {
  if (chunk.type === "stdout") process.stdout.write(chunk.data);
}

await sandbox.delete();
```

The [TypeScript README](./packages/typescript/README.md) covers the full API:
lifetime limits, exposed ports, snapshots, errors and timeouts, and how the SDK
authenticates to a sandbox.

## Status

The SDKs are in preview, so expect breaking changes before 1.0. The
control-plane API (`/api/v1/sandboxes`) is not final, so the sandbox record an
SDK returns may change.

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
