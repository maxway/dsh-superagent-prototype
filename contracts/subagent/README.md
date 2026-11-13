# Subagent compatibility contracts

These optional tests use separately locked DSH rc.1 and rc.2 dependencies. Run them in an isolated non-production environment with Node.js 24.9 or later, with dependencies installed separately in each version directory:

```sh
cd contracts/subagent/rc1
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
cd ../rc2
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
```

The runtime is real; agents, catalog storage and the external provider are in-memory substitutes. The rc.1 release-path check itself uses a mock service. The rc.2 test checks an external child, bounded stop and a later delegation; it does not prove local activation release, inbox preservation, concurrent admission, real external process cleanup, full-profile behavior or crash recovery. These tests do not deploy or exercise a production service.
