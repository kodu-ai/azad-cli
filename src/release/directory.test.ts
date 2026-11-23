import { afterEach, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Run } from "../process"
import {
  fakeRelease,
  fakeReleaseDirectory,
  fakeSourceSha,
} from "../../test/fake-release"
import {
  FIRST_INSTALLER_RELEASE,
  localRelease,
  localReleaseDirectory,
  publicRelease,
  publicReleaseDirectory,
  recordedRelease,
  releasesDirectory,
} from "./directory"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})
const scratch = () => {
  const root = mkdtempSync(join(tmpdir(), "azad-release-directory-"))
  roots.push(root)
  return root
}

/** A fake release server and a home folder whose cache it fills. */
function served(options?: Parameters<typeof fakeRelease>[1]) {
  const root = scratch()
  const fake = fakeRelease(root, options)
  const home = join(root, "home")
  return {
    ...fake,
    home,
    source: { fetcher: fake.fetcher, trust: fake.trust, home },
  }
}

test("latest is downloaded, verified and unpacked into the cache as the drivers read it", async () => {
  const f = served()
  const release = await publicRelease("latest", f.source)
  const directory = publicReleaseDirectory("5.30.0", f.home)
  expect(release).toEqual({
    directory,
    version: "5.30.0",
    sourceSha: "a".repeat(40),
    signed: true,
  })
  expect(f.requested).toEqual([
    "/api/v3/releases/latest.json",
    "/api/v3/releases/5.30.0/manifest.json",
    "/api/v3/releases/5.30.0/updater-5.30.0.tar.gz",
    "/api/v3/releases/5.30.0/web-5.30.0.tar.gz",
    "/api/v3/releases/5.30.0/agent-connect-manifest.json",
  ])
  expect(JSON.parse(readFileSync(join(directory, "release.json"), "utf8"))).toEqual({
    format: 1,
    version: "5.30.0",
    sourceSha: "a".repeat(40),
    signed: true,
    agentConnect: { version: "0.4.0" },
  })
  // The signed manifest verbatim, the archives kept beside the unpacked trees.
  expect(
    readFileSync(join(directory, "manifest.json")).equals(
      Buffer.from(
        await (
          await f.fetcher("https://api.azad.pro/api/v3/releases/5.30.0/manifest.json", {})
        ).arrayBuffer()
      )
    )
  ).toBe(true)
  expect(readdirSync(directory).sort()).toEqual([
    "agent-connect-manifest.json",
    "manifest.json",
    "payload",
    "release.json",
    "updater-5.30.0.tar.gz",
    "web",
    "web-5.30.0.tar.gz",
  ])
  expect(
    readFileSync(join(directory, "payload", "installer", "cloudflare-install.js"), "utf8")
  ).toBe("// installer/cloudflare-install.js 5.30.0\n")
  expect(existsSync(join(directory, "web", "index.html"))).toBe(true)
  expect(statSync(releasesDirectory(f.home)).mode & 0o777).toBe(0o700)
  // Nothing is left of the download's scratch directory.
  expect(readdirSync(releasesDirectory(f.home))).toEqual(["5.30.0"])
})

test("a cached release is reused: offline for an exact version, after the pointer for latest", async () => {
  const f = served()
  await publicRelease("latest", f.source)
  f.requested.length = 0
  expect((await publicRelease("5.30.0", f.source)).version).toBe("5.30.0")
  expect(f.requested).toEqual([])
  expect((await publicRelease("latest", f.source)).version).toBe("5.30.0")
  expect(f.requested).toEqual(["/api/v3/releases/latest.json"])
  // The installer adds to the payload (Wrangler under runtime/); that stays.
  const directory = publicReleaseDirectory("5.30.0", f.home)
  mkdirSync(join(directory, "payload", "runtime", "node_modules"), {
    recursive: true,
  })
  await publicRelease("5.30.0", f.source)
  expect(existsSync(join(directory, "payload", "runtime", "node_modules"))).toBe(true)
})

test("a cached release whose unpacked tree is incomplete is unpacked again from its verified archives", async () => {
  const f = served()
  await publicRelease("5.30.0", f.source)
  const directory = publicReleaseDirectory("5.30.0", f.home)
  rmSync(join(directory, "payload", "installer"), { recursive: true })
  f.requested.length = 0
  await publicRelease("5.30.0", f.source)
  expect(f.requested).toEqual([])
  expect(existsSync(join(directory, "payload", "installer", "settings.js"))).toBe(true)
})

test("a cached archive that no longer matches the signed manifest is downloaded again", async () => {
  const f = served()
  await publicRelease("5.30.0", f.source)
  const directory = publicReleaseDirectory("5.30.0", f.home)
  writeFileSync(join(directory, "web-5.30.0.tar.gz"), "changed")
  f.requested.length = 0
  await publicRelease("5.30.0", f.source)
  expect(f.requested).toContain("/api/v3/releases/5.30.0/web-5.30.0.tar.gz")
  expect(readFileSync(join(directory, "web-5.30.0.tar.gz")).length).toBeGreaterThan(7)
})

test("a manifest whose signature does not verify is refused, and nothing is cached", async () => {
  const f = served({ tamper: "signature" })
  await expect(publicRelease("latest", f.source)).rejects.toThrow(
    "The release manifest signature is invalid."
  )
  expect(f.requested).not.toContain("/api/v3/releases/5.30.0/updater-5.30.0.tar.gz")
  expect(existsSync(publicReleaseDirectory("5.30.0", f.home))).toBe(false)
})

test("an artifact whose digest differs from the signed manifest is refused, and nothing is cached", async () => {
  for (const [tamper, message] of [
    ["archive", "The updater of Azad 5.30.0 does not match its signed manifest."],
    ["web", "The web build of Azad 5.30.0 does not match its signed manifest."],
    ["pointer-digest", "differs from the digest the latest pointer names"],
  ] as const) {
    const f = served({ tamper })
    await expect(publicRelease("latest", f.source)).rejects.toThrow(message)
    expect(existsSync(publicReleaseDirectory("5.30.0", f.home))).toBe(false)
    // The pointer's digest fails before anything is written.
    const cache = releasesDirectory(f.home)
    expect(existsSync(cache) ? readdirSync(cache) : []).toEqual([])
  }
})

test("a release without the installer is refused, naming the first release that has it, before its web build is downloaded", async () => {
  const f = served({ installer: false })
  await expect(publicRelease("latest", f.source)).rejects.toThrow(
    `Azad 5.30.0 cannot be installed by this azad: its release has no installer (installer/cloudflare-install.js). Installs start with Azad ${FIRST_INSTALLER_RELEASE}`
  )
  expect(f.requested).not.toContain("/api/v3/releases/5.30.0/web-5.30.0.tar.gz")
  expect(existsSync(publicReleaseDirectory("5.30.0", f.home))).toBe(false)
})

/** An app checkout whose local-release.ts the fake `bun` plays, and a record of what ran. */
function checkout(root: string, git: { sha?: string; dirty?: boolean } = {}) {
  const source = join(root, "app")
  mkdirSync(join(source, "scripts", "self-host"), { recursive: true })
  mkdirSync(join(source, "node_modules"))
  writeFileSync(join(source, "scripts", "self-host", "local-release.ts"), "")
  const sha = git.sha ?? "e".repeat(40)
  const builds: string[] = []
  const execute: Run = (command, args) => {
    if (command === "git")
      return args[2] === "rev-parse"
        ? { status: 0, stdout: `${sha}\n` }
        : { status: 0, stdout: git.dirty ? " M file\n" : "" }
    const out = args[args.indexOf("--out") + 1]
    expect(readdirSync(out)).toEqual([])
    builds.push(out)
    fakeReleaseDirectory(out, { sourceSha: sha })
    return { status: 0, stdout: "" }
  }
  return { source, execute, builds, sha }
}

test("--source builds an unsigned local release into the cache, and reuses it for a clean checkout of the same commit", () => {
  const root = scratch()
  const home = join(root, "home")
  const c = checkout(root)
  const built = localRelease(c.source, { execute: c.execute, home })
  expect(built).toEqual({
    directory: localReleaseDirectory(c.sha, home),
    version: "0.0.0",
    sourceSha: c.sha,
    signed: false,
  })
  expect(c.builds).toHaveLength(1)
  expect(localRelease(c.source, { execute: c.execute, home })).toEqual(built)
  expect(c.builds).toHaveLength(1)
  // A dirty checkout is built again (local-release.ts decides whether it may).
  const dirty = checkout(join(root, "dirty"), { dirty: true })
  mkdirSync(join(root, "dirty"), { recursive: true })
  localRelease(dirty.source, { execute: dirty.execute, home })
  localRelease(dirty.source, { execute: dirty.execute, home })
  expect(dirty.builds).toHaveLength(2)
  expect(() =>
    localRelease(join(root, "nothing"), { execute: c.execute, home })
  ).toThrow("--source must be an Azad app checkout")
})

test("a recorded release comes from the cache, a local build by its commit, and otherwise is downloaded", async () => {
  const f = served({ versions: ["5.30.0"] })
  const sha = fakeSourceSha("5.30.0")
  const local = fakeReleaseDirectory(localReleaseDirectory("f".repeat(40), f.home), {
    sourceSha: "f".repeat(40),
  })
  expect(
    (await recordedRelease({ version: "0.0.0", sourceSha: local.sourceSha }, f.source))
      .directory
  ).toBe(local.directory)
  expect(f.requested).toEqual([])
  expect(
    (await recordedRelease({ version: "5.30.0", sourceSha: sha }, f.source)).signed
  ).toBe(true)
  // A local build that is gone, or a version published from another commit.
  await expect(
    recordedRelease({ version: "0.0.0", sourceSha: "d".repeat(40) }, f.source)
  ).rejects.toThrow("Rerun with --source and a checkout of that commit")
  await expect(
    recordedRelease({ version: "5.30.0", sourceSha: "d".repeat(40) }, f.source)
  ).rejects.toThrow("a local build that is no longer cached")
})
