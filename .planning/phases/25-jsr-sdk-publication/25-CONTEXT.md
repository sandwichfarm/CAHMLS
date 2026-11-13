# Phase 25: JSR SDK Publication — Context

**User outcome:** Deploy the CAHMLS SDK to JSR as `@sandwich/cahmls`, through CI in a workflow.

## Decisions

- Publish TypeScript sources from `packages/sdk` using a dedicated `jsr.json`. Keep the pnpm workspace identity `@cahmls/sdk` and existing application imports intact.
- Preserve all ten runtime entry points: root, client, contracts, coordinator, crypto, mls, relay, runtime, server, and storage/browser. `./package.json` is npm package metadata, not an SDK runtime entry point.
- Use the official JSR CLI from Node (`jsr@0.14.3`, current version verified through npm on 2026-11-13). A package-local `package.json` allows the current `.js` relative specifiers to resolve to TypeScript sources during publishing; dependency imports are rewritten by the publisher.
- Add a genuine publish dry run to ordinary CI, without publishing permissions. Do not hide package problems with `--no-check`, `--allow-slow-types`, or `continue-on-error`.
- Publish in a separate `workflow_run` workflow after successful `CI` on a push to `master` or `main`. Require the source repository to equal the current repository, reject pull-request events, and check out the exact successful `head_sha`.
- Grant `contents: read` and `id-token: write` only to the publishing job. Use JSR's GitHub OIDC authentication rather than a stored publishing token. Serialize publications without cancelling an active publish.
- JSR package creation and linking `@sandwich/cahmls` to `sandwichfarm/CAHMLS` are registry prerequisites. The orchestrator verified through the registry API that the package exists, is already linked to that repository, and has `versionCount: 0` on 2026-11-13. A dry run alone does not prove registry publication.
- Keep the JSR version equal to `packages/sdk/package.json`; the initial release is `0.1.0`. Later version bumps publish after successful default-branch CI; already-published versions are skipped by the JSR CLI.

## Non-goals

- Renaming the workspace package, changing wire protocols, restructuring SDK modules, changing UI, or publishing from a developer machine.
- Automatic PR merging or bypassing failed quality gates.

## Sources and evidence

- [JSR publishing documentation](https://jsr.io/docs/publishing-packages): TypeScript sources, package.json dependency and relative-import support, dry runs, GitHub repository linking, OIDC permissions, and already-published version behavior.
- Existing `.github/workflows/ci.yml` and `packages/sdk/package.json` inspected directly. The inherited graph has no usable SDK coverage; conclusions rely on current source/configuration reads rather than an absence claim from the graph.
