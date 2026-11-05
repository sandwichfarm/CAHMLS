#!/usr/bin/env bash
set -euo pipefail

upstream_url="${CORDN_UPSTREAM_URL:-https://github.com/Cordn-msg/cordn.git}"
upstream_ref="${CORDN_UPSTREAM_REF:-master}"
workdir="$(mktemp -d /tmp/cordn-upstream-parity-XXXXXX)"

cleanup() {
  if command -v gio >/dev/null 2>&1; then
    gio trash "$workdir" >/dev/null 2>&1 || true
    return
  fi

  printf 'Temporary upstream checkout remains at %s\n' "$workdir" >&2
}
trap cleanup EXIT

git clone --depth=1 --filter=blob:none --sparse --branch "$upstream_ref" "$upstream_url" "$workdir" >/dev/null
git -C "$workdir" sparse-checkout set packages/server/src packages/core/src >/dev/null
upstream_commit="$(git -C "$workdir" rev-parse HEAD)"

node --input-type=module - "$workdir" "$upstream_commit" <<'NODE'
import { readFileSync } from "node:fs";
import { relative } from "node:path";

const upstreamDir = process.argv[2];
const upstreamCommit = process.argv[3];
const upstreamContracts = readFileSync(`${upstreamDir}/packages/core/src/contracts.ts`, "utf8");
const browserContracts = readFileSync("packages/sdk/src/contracts/index.ts", "utf8");

function methodMap(source, label) {
  const body = source.match(
    /export const COORDINATOR_METHODS = \{([\s\S]*?)\} as const;/,
  )?.[1];
  if (!body) throw new Error(`Could not find ${label} COORDINATOR_METHODS export`);
  return new Map(
    [...body.matchAll(/\s*([A-Za-z0-9_]+):\s*"([^"]+)"/g)]
      .map((match) => [match[1], match[2]]),
  );
}

function schemaKeys(source, name, label) {
  const body = source.match(
    new RegExp(`export const ${name} = z\\.object\\(\\{([\\s\\S]*?)\\n\\}\\);`),
  )?.[1];
  if (body === undefined) throw new Error(`Could not find ${label} ${name}`);
  return [...body.matchAll(/^\s*([A-Za-z0-9_]+):/gm)].map((match) => match[1]);
}

const upstreamMethods = methodMap(upstreamContracts, "upstream");
const browserMethods = methodMap(browserContracts, "browser");
const missingOrChangedMethods = [...upstreamMethods].flatMap(([key, value]) =>
  browserMethods.get(key) === value ? [] : [{ key, expected: value, actual: browserMethods.get(key) }],
);

const canonicalSchemas = [
  "fetchPendingWelcomesInputSchema",
  "storeJoinRequestInputSchema",
  "fetchManyPendingJoinRequestsInputSchema",
  "postGroupMessageInputSchema",
  "fetchGroupMessagesInputSchema",
  "fetchManyGroupMessagesInputSchema",
  "subscribeManyGroupMessagesInputSchema",
];
const schemaDrift = canonicalSchemas.flatMap((name) => {
  const upstreamKeys = schemaKeys(upstreamContracts, name, "upstream");
  const browserKeys = schemaKeys(browserContracts, name, "browser");
  const missing = upstreamKeys.filter((key) => !browserKeys.includes(key));
  return missing.length > 0 ? [{ name, missing }] : [];
});

if (missingOrChangedMethods.length > 0 || schemaDrift.length > 0) {
  process.stderr.write("Cordn canonical contract parity failed\n");
  process.stderr.write(`${JSON.stringify({ missingOrChangedMethods, schemaDrift }, null, 2)}\n`);
  process.exit(1);
}

process.stdout.write(
  `Cordn canonical contract parity passed: ${upstreamMethods.size} methods and ${canonicalSchemas.length} schemas match ${upstreamCommit} at ${relative(process.cwd(), upstreamDir)}\n`,
);
NODE
