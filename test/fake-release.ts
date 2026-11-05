import { expect } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Fetcher } from "../src/http"
import { canonical } from "../src/commands/update/release"

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex")

/**
 * A signed release served from memory, as the public release routes serve
 * it, with its own trusted key. `root` holds the build files.
 */
export function fakeRelease(
  root: string,
  options: {
    version?: string
    keyId?: string
    tamper?: "archive" | "pointer-digest" | "pointer-source" | "version"
  } = {}
) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  const raw = Buffer.from(
    publicKey.export({ format: "jwk" }).x ?? "",
    "base64url"
  ).toString("base64")
  const version = options.version ?? "4.30.0"
  const build = mkdtempSync(join(root, "build-"))
  mkdirSync(join(build, "updater"))
  writeFileSync(join(build, "updater", "updater.js"), "// the updater\n")
  const archivePath = join(build, "updater.tar.gz")
  expect(
    spawnSync("tar", ["-czf", archivePath, "-C", build, "updater"]).status
  ).toBe(0)
  const archive = readFileSync(archivePath)
  const unsigned = {
    format: 1,
    type: "azad-release",
    version: options.tamper === "version" ? "4.29.0" : version,
    sourceSha: "a".repeat(40),
    publishedAt: "2026-11-05T01:00:00.000Z",
    artifacts: {
      api: { path: `api-${version}.tar.gz`, sha256: "1".repeat(64), size: 1 },
      updater: {
        path: `updater-${version}.tar.gz`,
        sha256: sha256(archive),
        size: archive.byteLength,
      },
      web: null,
      agentConnect: {
        path: "agent-connect-manifest.json",
        sha256: "2".repeat(64),
        size: 1,
      },
    },
    migrations: [
      { tag: "0001_a", when: 1, postDeploy: false, maintenance: false },
    ],
    keyId: options.keyId ?? "test-key",
  }
  const manifest = new TextEncoder().encode(
    JSON.stringify({
      ...unsigned,
      signature: sign(
        null,
        new TextEncoder().encode(canonical(unsigned)),
        privateKey
      ).toString("base64"),
    })
  )
  const pointer = JSON.stringify({
    format: 1,
    version,
    sourceSha:
      options.tamper === "pointer-source" ? "b".repeat(40) : "a".repeat(40),
    manifestSha256:
      options.tamper === "pointer-digest" ? "3".repeat(64) : sha256(manifest),
  })
  const files = new Map<string, Uint8Array<ArrayBuffer> | string>([
    ["/api/v3/releases/latest.json", pointer],
    [`/api/v3/releases/${version}/manifest.json`, manifest],
    [
      `/api/v3/releases/${version}/updater-${version}.tar.gz`,
      options.tamper === "archive"
        ? Buffer.concat([archive, Buffer.from("x")])
        : archive,
    ],
  ])
  const requested: string[] = []
  const fetcher: Fetcher = async (url) => {
    const path = new URL(url).pathname
    requested.push(path)
    const body = files.get(path)
    return body === undefined
      ? new Response("missing", { status: 404 })
      : new Response(body)
  }
  return {
    requested,
    fetcher,
    trust: [{ id: "test-key", publicKey: raw }] as const,
  }
}
