#!/usr/bin/env node
// Prove the built package works the way a consumer uses it: through its
// `exports` map, on plain Node, with nothing resolved from TypeScript sources.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const jsrManifest = JSON.parse(readFileSync(join(root, "jsr.json"), "utf8"));

const expectedExports = {
  ".": ["CoordinatorRuntime", "ChatRoomSession", "transportFactory", "contracts", "mls"],
  "./client": ["ChatCoordinatorClient", "ChatRoomSession", "configureRoomEnvironment", "createInviteUrl"],
  "./contracts": ["COORDINATOR_METHODS", "publishKeyPackageInputSchema"],
  "./coordinator": ["Coordinator", "createCoordinator", "InMemoryCoordinatorStorage"],
  "./crypto": ["BrowserNostrSigner", "KeyManager", "KeyStorage"],
  "./mls": ["decodeKeyPackage", "isLastResortKeyPackage"],
  "./relay": ["createRequiredRelayPool", "shareableRelayUrls"],
  "./runtime": ["CoordinatorRuntime", "SingleInstanceGuard", "transitionCoordinator"],
  "./server": ["TransportFactory", "CoordinatorAdapter", "registerCoordinatorMethods"],
  "./storage/browser": ["createBrowserCoordinatorStorage", "clearPersistedCoordinatorState"],
};

const failures = [];
const fail = (message) => failures.push(message);

const runtimeExports = Object.fromEntries(
  Object.entries(manifest.exports).filter(([subpath]) => subpath !== "./package.json"),
);
const jsrSourceFor = (target) => target.default
  .replace(/^\.\/dist\//, "./src/")
  .replace(/\.js$/, ".ts");

if (jsrManifest.name !== "@sandwich/cahmls") {
  fail(`JSR package name must be @sandwich/cahmls, received ${jsrManifest.name}`);
}
if (jsrManifest.version !== manifest.version) {
  fail(`JSR version ${jsrManifest.version} does not match package version ${manifest.version}`);
}
if (jsrManifest.license !== "MIT" || manifest.license !== jsrManifest.license) {
  fail("SDK and JSR manifests must declare the selected MIT license");
}
if (!existsSync(join(root, "LICENSE"))) fail("SDK license file is missing");

const runtimeExportPaths = Object.keys(runtimeExports).sort();
const jsrExportPaths = Object.keys(jsrManifest.exports ?? {}).sort();
if (JSON.stringify(jsrExportPaths) !== JSON.stringify(runtimeExportPaths)) {
  fail(`JSR exports do not match runtime exports: ${JSON.stringify(jsrExportPaths)}`);
}
for (const [subpath, target] of Object.entries(runtimeExports)) {
  const expectedSource = jsrSourceFor(target);
  const actualSource = jsrManifest.exports?.[subpath];
  if (actualSource !== expectedSource) {
    fail(`${subpath} must map to ${expectedSource} in jsr.json, received ${actualSource}`);
  }
  if (!existsSync(join(root, actualSource ?? ""))) {
    fail(`${subpath} points at missing JSR source ${actualSource}`);
  }
}

for (const [subpath, target] of Object.entries(runtimeExports)) {
  if (!expectedExports[subpath]) fail(`no verification listed for export ${subpath}`);
  for (const file of Object.values(target)) {
    if (!existsSync(join(root, file))) fail(`${subpath} points at missing file ${file}`);
  }
}

for (const [subpath, names] of Object.entries(expectedExports)) {
  const specifier = subpath === "." ? manifest.name : `${manifest.name}/${subpath.slice(2)}`;
  try {
    const loaded = await import(specifier);
    for (const name of names) {
      if (loaded[name] === undefined) fail(`${specifier} does not export ${name}`);
    }
  } catch (error) {
    fail(`could not import ${specifier}: ${error.message}`);
  }
}

const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path) : [path];
});
for (const file of walk(join(root, "dist")).filter((path) => path.endsWith(".js"))) {
  const text = readFileSync(file, "utf8");
  if (/from "svelte|\.svelte(\.js)?"/.test(text)) fail(`${file} imports Svelte`);
  if (/from "(\.\.\/){3,}/.test(text)) fail(`${file} imports outside the package`);
}

const packed = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  cwd: root,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "ignore"],
}))[0].files.map((entry) => entry.path);
for (const required of ["package.json", "README.md", "LICENSE", "dist/index.js", "dist/index.d.ts"]) {
  if (!packed.includes(required)) fail(`tarball is missing ${required}`);
}
for (const path of packed) {
  if (/^(tests|src|scripts|coverage)\//.test(path)) fail(`tarball should not contain ${path}`);
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}
console.log(`Verified ${Object.keys(expectedExports).length} entry points, JSR source exports, and ${packed.length} packed files.`);
