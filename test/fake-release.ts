import { expect } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { Fetcher } from "../src/http"
import { canonical } from "../src/release/signed"

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex")

/** The installer entrypoints a release payload carries. */
const INSTALLER = [
  "installer/settings.js",
  "installer/cloudflare-install.js",
  "installer/celld-install.js",
  "installer/install-store.js",
]

/** A gzipped tarball of `files` (path → text), built under `root`. */
function tarball(
  root: string,
  files: Record<string, string>
): Uint8Array<ArrayBuffer> {
  const tree = mkdtempSync(join(root, "tree-"))
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(tree, path)), { recursive: true })
    writeFileSync(join(tree, path), text)
  }
  const archive = `${tree}.tar.gz`
  expect(spawnSync("tar", ["-czf", archive, "-C", tree, "."]).status).toBe(0)
  return new Uint8Array(readFileSync(archive))
}

/** `bytes` with one byte appended: a download that differs from its digest. */
const tampered = (bytes: Uint8Array<ArrayBuffer>) => {
  const changed = new Uint8Array(bytes.byteLength + 1)
  changed.set(bytes)
  return changed
}

/** The source commit of a version among several fake `versions`. */
export const fakeSourceSha = (version: string) =>
  createHash("sha1").update(version).digest("hex")

/**
 * Signed releases served from memory, as the public release routes serve
 * them, with their own trusted key. Each version has an updater payload
 * (`payload.json`, `updater/updater.js` and, unless `installer` is false, the
 * install entrypoints), a web build and an Agent Connect manifest. The
 * pointer names `latest` (default the last of `versions`). `root` holds the
 * build files.
 */
export function fakeRelease(
  root: string,
  options: {
    version?: string
    versions?: string[]
    latest?: string
    keyId?: string
    installer?: boolean
    /**
     * The source commit of every version; default `a…a` for one version and
     * {@link fakeSourceSha} for several.
     */
    sourceSha?: string
    tamper?:
      | "archive"
      | "web"
      | "pointer-digest"
      | "pointer-source"
      | "version"
      | "signature"
  } = {}
) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  const raw = Buffer.from(
    publicKey.export({ format: "jwk" }).x ?? "",
    "base64url"
  ).toString("base64")
  const versions = options.versions ?? [options.version ?? "5.30.0"]
  const latest = options.latest ?? versions.at(-1) ?? "5.30.0"
  const files = new Map<string, Uint8Array<ArrayBuffer> | string>()
  for (const version of versions) {
    const sourceSha =
      options.sourceSha ??
      (options.versions ? fakeSourceSha(version) : "a".repeat(40))
    const contents: Record<string, string> = {
      "updater/updater.js": "// the updater\n",
      ...(options.installer === false
        ? {}
        : Object.fromEntries(
            INSTALLER.map((path) => [path, `// ${path} ${version}\n`])
          )),
    }
    const index = {
      format: 1,
      sourceSha,
      wranglerVersion: "4.0.0",
      files: Object.entries(contents)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([path, text]) => ({
          path,
          sha256: sha256(new TextEncoder().encode(text)),
          size: text.length,
        })),
    }
    const updater = tarball(root, {
      ...contents,
      "payload.json": JSON.stringify(index),
    })
    const web = tarball(root, { "index.html": `<!-- web ${version} -->\n` })
    const agentConnect = new TextEncoder().encode(
      JSON.stringify({ fixture: "agent-connect", version: "0.4.0" })
    )
    const unsigned = {
      format: 1,
      type: "azad-release",
      version: options.tamper === "version" ? "5.29.0" : version,
      sourceSha,
      publishedAt: "2026-11-05T01:00:00.000Z",
      artifacts: {
        api: { path: `api-${version}.tar.gz`, sha256: "1".repeat(64), size: 1 },
        updater: {
          path: `updater-${version}.tar.gz`,
          sha256: sha256(updater),
          size: updater.byteLength,
        },
        web: {
          path: `web-${version}.tar.gz`,
          sha256: sha256(web),
          size: web.byteLength,
        },
        agentConnect: {
          path: "agent-connect-manifest.json",
          sha256: sha256(agentConnect),
          size: agentConnect.byteLength,
        },
      },
      migrations: [
        { tag: "0001_a", when: 1, postDeploy: false, maintenance: false },
      ],
      compatible: { agentConnect: { version: "0.4.0" } },
      keyId: options.keyId ?? "test-key",
    }
    const signature = sign(
      null,
      new TextEncoder().encode(canonical(unsigned)),
      privateKey
    ).toString("base64")
    const manifest = new TextEncoder().encode(
      JSON.stringify({
        ...unsigned,
        // A signature over something else: valid base64, wrong bytes.
        ...(options.tamper === "signature"
          ? { publishedAt: "2026-11-06T01:00:00.000Z" }
          : {}),
        signature,
      })
    )
    const base = `/api/v3/releases/${version}`
    files.set(`${base}/manifest.json`, manifest)
    files.set(
      `${base}/updater-${version}.tar.gz`,
      options.tamper === "archive" ? tampered(updater) : updater
    )
    files.set(
      `${base}/web-${version}.tar.gz`,
      options.tamper === "web" ? tampered(web) : web
    )
    files.set(`${base}/agent-connect-manifest.json`, agentConnect)
    if (version === latest)
      files.set(
        "/api/v3/releases/latest.json",
        JSON.stringify({
          format: 1,
          version,
          sourceSha:
            options.tamper === "pointer-source" ? "b".repeat(40) : sourceSha,
          manifestSha256:
            options.tamper === "pointer-digest"
              ? "3".repeat(64)
              : sha256(manifest),
        })
      )
  }
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

/**
 * An unpacked release directory as `scripts/self-host/local-release.ts`
 * writes one (unsigned by default), in the new directory `directory`.
 */
export function fakeReleaseDirectory(
  directory: string,
  options: { version?: string; sourceSha?: string; signed?: boolean } = {}
) {
  const version = options.version ?? "0.0.0"
  const sourceSha = options.sourceSha ?? "e".repeat(40)
  const payload = join(directory, "payload")
  for (const path of ["updater/updater.js", ...INSTALLER]) {
    mkdirSync(dirname(join(payload, path)), { recursive: true })
    writeFileSync(join(payload, path), `// ${path}\n`)
  }
  writeFileSync(
    join(payload, "payload.json"),
    JSON.stringify({
      format: 1,
      sourceSha,
      wranglerVersion: "4.0.0",
      files: ["updater/updater.js", ...INSTALLER].sort().map((path) => ({
        path,
        sha256: "0".repeat(64),
        size: 1,
      })),
    })
  )
  mkdirSync(join(directory, "web"), { recursive: true })
  writeFileSync(join(directory, "web", "index.html"), "<!-- web -->\n")
  writeFileSync(
    join(directory, "release.json"),
    JSON.stringify({
      format: 1,
      version,
      sourceSha,
      signed: options.signed ?? false,
      agentConnect: null,
    })
  )
  return { directory, version, sourceSha, signed: options.signed ?? false }
}
