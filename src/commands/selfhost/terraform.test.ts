import { afterEach, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Fetcher } from "../../http"
import { run, type Run } from "../../process"
import {
  AZAD_TERRAFORM_SHA256,
  AZAD_TERRAFORM_VERSION,
  checksumFor,
  driverPath,
  prepareTerraform,
  selectTerraform,
  terraformReady,
  type TerraformSelection,
} from "./terraform"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

// A test version; each fake release below is pinned by its own digest.
const VERSION = "0.0.0-test"
const URL = `https://github.com/kodu-ai/azad-terraform/releases/download/v${VERSION}/azad-terraform-${VERSION}.tar.gz`

/**
 * A local stand-in for an azad-terraform release: a tarball of `tops`
 * (default the single `azad-terraform-<version>/` with its drivers) and its
 * sha256sum file, served by a fetcher that records each URL, and `pins`
 * naming its digest (or `pin`). `bun install` is recorded and answered with
 * `installStatus`; tar runs for real.
 */
function release(
  options: {
    tops?: string[]
    drivers?: string[]
    checksum?: (digest: string) => string
    pin?: string
    installStatus?: number
  } = {}
) {
  const root = mkdtempSync(join(tmpdir(), "azad-terraform-release-"))
  roots.push(root)
  const tree = join(root, "tree")
  const tops = options.tops ?? [`azad-terraform-${VERSION}`]
  for (const top of tops) {
    mkdirSync(join(tree, top, "scripts"), { recursive: true })
    writeFileSync(join(tree, top, "package.json"), '{"name":"azad-terraform"}')
    writeFileSync(join(tree, top, "bun.lock"), "{}")
    for (const driver of options.drivers ?? ["cloudflare", "gcp", "bootstrap"])
      writeFileSync(join(tree, top, "scripts", `${driver}.ts`), "// driver")
  }
  const archive = join(root, "archive.tar.gz")
  // COPYFILE_DISABLE keeps macOS tar from adding AppleDouble members.
  const packed = spawnSync("tar", ["-czf", archive, "-C", tree, ...tops], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  })
  expect(packed.status).toBe(0)
  const bytes = new Uint8Array(readFileSync(archive))
  const digest = createHash("sha256").update(bytes).digest("hex")
  const files = new Map<string, Uint8Array<ArrayBuffer> | string>([
    [URL, bytes],
    [
      `${URL}.sha256`,
      options.checksum?.(digest) ??
        `${digest}  azad-terraform-${VERSION}.tar.gz\n`,
    ],
  ])
  const requests: string[] = []
  const fetcher: Fetcher = async (url) => {
    requests.push(url)
    const body = files.get(url)
    return body === undefined
      ? new Response("Not Found", { status: 404 })
      : new Response(body)
  }
  const installs: string[] = []
  const execute: Run = (command, args, cwd, capture) => {
    if (command === "bun") {
      installs.push(`${cwd}: ${args.join(" ")}`)
      return { status: options.installStatus ?? 0, stdout: "" }
    }
    return run(command, args, cwd, capture)
  }
  const selection: TerraformSelection = {
    kind: "release",
    version: VERSION,
    directory: join(root, "home", ".azad", "cache", "azad-terraform", VERSION),
    url: URL,
  }
  const pins = { [VERSION]: options.pin ?? digest }
  return { root, files, fetcher, requests, execute, installs, selection, pins }
}

test("the pinned release resolves to its GitHub asset and cache folder; --terraform-dir, then AZAD_TERRAFORM_DIR, override it", () => {
  expect(selectTerraform({ home: "/home/person", env: {} })).toEqual({
    kind: "release",
    version: "0.0.2",
    directory: "/home/person/.azad/cache/azad-terraform/0.0.2",
    url: "https://github.com/kodu-ai/azad-terraform/releases/download/v0.0.2/azad-terraform-0.0.2.tar.gz",
  })
  // The release this CLI deploys with is always pinned.
  expect(AZAD_TERRAFORM_SHA256[AZAD_TERRAFORM_VERSION]).toMatch(
    /^[a-f0-9]{64}$/u
  )
  expect(
    selectTerraform({
      home: "/home/person",
      cwd: "/work",
      env: { AZAD_TERRAFORM_DIR: "~/azad-terraform" },
    })
  ).toEqual({ kind: "local", directory: "/home/person/azad-terraform" })
  expect(
    selectTerraform({
      directory: "checkout",
      cwd: "/work",
      env: { AZAD_TERRAFORM_DIR: "/elsewhere" },
    })
  ).toEqual({ kind: "local", directory: "/work/checkout" })
})

test("a release is downloaded, verified, extracted into the cache and installed once", async () => {
  const f = release()
  const notes: string[] = []
  const directory = await prepareTerraform(f.selection, {
    execute: f.execute,
    fetcher: f.fetcher,
    pins: f.pins,
    note: (message) => notes.push(message),
  })
  expect(directory).toBe(f.selection.directory)
  expect(f.requests).toEqual([`${URL}.sha256`, URL])
  expect(readFileSync(driverPath(directory, "cloudflare"), "utf8")).toBe(
    "// driver"
  )
  expect(f.installs).toEqual([
    `${directory}: --no-env-file install --frozen-lockfile`,
  ])
  expect(terraformReady(f.selection)).toBe(true)
  expect(notes[0]).toBe("Downloading azad-terraform 0.0.0-test…")
  // Only the version's folder remains in the cache: no scratch download.
  expect(readdirSync(join(directory, ".."))).toEqual([VERSION])

  await prepareTerraform(f.selection, {
    execute: f.execute,
    fetcher: f.fetcher,
    pins: f.pins,
  })
  expect(f.requests).toHaveLength(2)
  expect(f.installs).toHaveLength(1)
})

test("a download that does not match its published checksum installs nothing", async () => {
  const f = release({
    checksum: () => `${"0".repeat(64)}  azad-terraform-${VERSION}.tar.gz\n`,
    pin: "0".repeat(64),
  })
  await expect(
    prepareTerraform(f.selection, {
      execute: f.execute,
      fetcher: f.fetcher,
      pins: f.pins,
    })
  ).rejects.toThrow(
    "The azad-terraform 0.0.0-test download does not match its published SHA-256 checksum. Nothing was installed; retry the download."
  )
  expect(existsSync(f.selection.directory)).toBe(false)
  expect(f.installs).toEqual([])

  const unlisted = release({ checksum: (digest) => `${digest}  other.tar.gz\n` })
  await expect(
    prepareTerraform(unlisted.selection, {
      execute: unlisted.execute,
      fetcher: unlisted.fetcher,
      pins: unlisted.pins,
    })
  ).rejects.toThrow("does not list azad-terraform-0.0.0-test.tar.gz")
  expect(unlisted.requests).toEqual([`${URL}.sha256`])
})

test("a version this CLI pins no checksum for is refused before any download", async () => {
  const f = release()
  await expect(
    prepareTerraform(f.selection, {
      execute: f.execute,
      fetcher: f.fetcher,
      pins: {},
    })
  ).rejects.toThrow(
    "This azad release pins no checksum for azad-terraform 0.0.0-test, so it cannot verify the download."
  )
  expect(f.requests).toEqual([])
  expect(existsSync(f.selection.directory)).toBe(false)
})

test("a release whose published checksum differs from this CLI's pin installs nothing", async () => {
  const f = release()
  await expect(
    prepareTerraform(f.selection, {
      execute: f.execute,
      fetcher: f.fetcher,
      pins: { [VERSION]: "0".repeat(64) },
    })
  ).rejects.toThrow("does not match the one this CLI pins")
  expect(f.requests.some((url) => url === URL)).toBe(false)
  expect(f.installs).toEqual([])
})

test("offline and unpublished releases fail with what to do, and nothing is installed", async () => {
  const f = release()
  const offline: Fetcher = async () => {
    throw new TypeError("fetch failed")
  }
  await expect(
    prepareTerraform(f.selection, {
      execute: f.execute,
      fetcher: offline,
      pins: f.pins,
    })
  ).rejects.toThrow(
    `Could not download azad-terraform 0.0.0-test from ${URL}.sha256. Check your internet connection and proxy settings, then retry. To deploy offline, point --terraform-dir at a local azad-terraform checkout.`
  )
  f.files.clear()
  await expect(
    prepareTerraform(f.selection, {
      execute: f.execute,
      fetcher: f.fetcher,
      pins: f.pins,
    })
  ).rejects.toThrow(
    "azad-terraform 0.0.0-test, which this azad release deploys with, is not published at"
  )
  expect(existsSync(f.selection.directory)).toBe(false)
})

test("an archive that is not one azad-terraform-<version>/ directory with its drivers is refused", async () => {
  for (const options of [
    { tops: [`azad-terraform-${VERSION}`, "elsewhere"] },
    { tops: ["azad-terraform-9.9.9"] },
    { drivers: ["cloudflare", "gcp"] },
  ]) {
    const f = release(options)
    await expect(
      prepareTerraform(f.selection, {
      execute: f.execute,
      fetcher: f.fetcher,
      pins: f.pins,
    })
    ).rejects.toThrow("Nothing was installed.")
    expect(existsSync(f.selection.directory)).toBe(false)
    expect(f.installs).toEqual([])
    expect(readdirSync(join(f.selection.directory, ".."))).toEqual([])
  }
})

test("a failed dependency install leaves no ready release, and the next run starts again from the download", async () => {
  const f = release({ installStatus: 1 })
  await expect(
    prepareTerraform(f.selection, {
      execute: f.execute,
      fetcher: f.fetcher,
      pins: f.pins,
    })
  ).rejects.toThrow("Installing the dependencies of azad-terraform 0.0.0-test")
  expect(terraformReady(f.selection)).toBe(false)
  const retry = release()
  retry.selection.directory = f.selection.directory
  await prepareTerraform(retry.selection, {
    execute: retry.execute,
    fetcher: retry.fetcher,
    pins: retry.pins,
  })
  expect(retry.requests).toEqual([`${URL}.sha256`, URL])
  expect(terraformReady(f.selection)).toBe(true)
})

test("a local checkout must have the three drivers, and gets its dependencies installed only when it has none", async () => {
  const root = mkdtempSync(join(tmpdir(), "azad-terraform-local-"))
  roots.push(root)
  const installs: string[] = []
  const execute: Run = (command, args, cwd) => {
    installs.push(`${command} ${args.join(" ")} in ${cwd}`)
    return { status: 0, stdout: "" }
  }
  const local: TerraformSelection = { kind: "local", directory: root }
  await expect(prepareTerraform(local, { execute })).rejects.toThrow(
    `${root} is not an azad-terraform checkout`
  )
  mkdirSync(join(root, "scripts"))
  for (const driver of ["cloudflare", "gcp", "bootstrap"])
    writeFileSync(join(root, "scripts", `${driver}.ts`), "")
  const fetcher: Fetcher = () => {
    throw new Error("A local checkout is never downloaded")
  }
  expect(await prepareTerraform(local, { execute, fetcher })).toBe(root)
  expect(installs).toEqual([
    `bun --no-env-file install --frozen-lockfile in ${root}`,
  ])
  mkdirSync(join(root, "node_modules"))
  await prepareTerraform(local, { execute, fetcher })
  expect(installs).toHaveLength(1)
})

test("checksum files are read in sha256sum's text and binary formats", () => {
  const digest = "a".repeat(64)
  expect(checksumFor(`${digest}  azad.tar.gz\n`, "azad.tar.gz")).toBe(digest)
  expect(checksumFor(`${digest} *azad.tar.gz\r\n`, "azad.tar.gz")).toBe(digest)
  expect(checksumFor(`${digest}  other.tar.gz\n`, "azad.tar.gz")).toBeUndefined()
  expect(checksumFor("not a checksum\n", "azad.tar.gz")).toBeUndefined()
})
