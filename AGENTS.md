## Repository navigation

This repository is a Rust workspace; `Cargo.toml` is the authoritative list of
members. `moli` contains the CLI, `moli-core` the browser core, and
`moli-protocol-server` and `moli-protocol-cdp` the automation server and CDP
implementation. See `README.md` for the supported interfaces and CLI usage.
Project work items are tracked in `docs/Todo.md`.
The experimental FlareSolverr bridge, CDP gateway, container build and remaining
verification steps are documented in `flaresolverr-bridge/README.md` and
`docs/flaresolverr-bridge-investigation.md`. Upstream dependencies, licenses,
and synchronization procedures are recorded in `docs/UPSTREAMS.md`.

For changes to CDP client behavior, consult `moli-cdp-smoke/README.md` for the
Playwright and raw-CDP integration suite. Keep narrow protocol contract tests
near their owning Rust boundary as well. Release procedures are documented in
`docs/RELEASING.md`.

The workspace Cargo configuration clears proxy environment variables in Cargo
processes; see `.cargo/config.toml` before diagnosing proxy-dependent test results
or changing its linker and native-library settings.

## Architecture constraint

Any future FlareSolverr bridge must isolate its Moli instance and control plane
from external Playwright clients, including resource isolation sufficient to
prevent those clients from disrupting the bridge. Verify the isolation with
concurrent clients and destructive control operations; this is a requirement,
not a claim that the bridge or isolation is implemented.

## Required checks

Before committing changes that modify Rust source code or Rust build metadata
(such as `Cargo.toml`, `Cargo.lock`, or `rust-toolchain`), run all of the
following from the repository root and ensure they pass:

```sh
cargo fmt --all
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo nextest run --no-fail-fast
```

These commands are not required when the change set contains no Rust source or
Rust build metadata changes.
