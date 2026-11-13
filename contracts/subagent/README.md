# Subagent compatibility contracts

These optional tests use separately locked DSH rc.1, rc.2 and rc.3 dependencies. Run them in an isolated non-production environment with Node.js 24.9 or later, with dependencies installed separately in each version directory:

```sh
cd contracts/subagent/rc1
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
cd ../rc2
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
cd ../rc3
pnpm install --ignore-workspace --frozen-lockfile --ignore-scripts
node --test contract.test.mjs
```

The runtime is real; agents, catalog storage and the external provider are in-memory substitutes. The rc.1 contracts cover release of a real runtime's catalogued external child and a separate mock local-child release path. The rc.2 and rc.3 tests check an external child and a later delegation, and that an in-flight external start is observed; they also demonstrate that uncatalogued caller-delivered work is waited for but not interrupted, that this project's `stopSubagents` can return normally despite an external provider's disposal failure, and that a local activation and its unclaimed inbox can remain parked after interruption. They do not prove subsequent wakeup, local activation release, persistence across restart, concurrent admission, real external process cleanup, full-profile behavior or crash recovery. These tests do not deploy or exercise a production service.
