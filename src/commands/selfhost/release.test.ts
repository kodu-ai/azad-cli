import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  fakeRelease,
  fakeReleaseDirectory,
  fakeSourceSha,
} from "../../../test/fake-release"
import {
  localReleaseDirectory,
  publicReleaseDirectory,
} from "../../release/directory"
import type { Run } from "../../process"
import type { RunUpdater } from "../update/run"
import { releaseResolver } from "./release"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

const VERSIONS = ["5.29.0", "5.30.0", "5.31.0"]

/**
 * Three published releases (latest 5.31.0), an instance directory and an
 * updater whose `status` reports `installed` as the installation's receipt.
 */
function fixture(
  options: {
    recorded?: string
    installed?: string | null
    initialized?: boolean
    statusFails?: boolean
  } = {}
) {
  const root = mkdtempSync(join(tmpdir(), "azad-release-select-"))
  roots.push(root)
  const fake = fakeRelease(root, { versions: VERSIONS })
  const home = join(root, "home")
  const directory = join(root, "instance")
  const terraform = join(directory, "terraform", "postgres")
  mkdirSync(terraform, { recursive: true })
  const values: Record<string, string> = options.recorded
    ? {
        AZAD_CLI_RELEASE_VERSION: options.recorded,
        AZAD_CLI_RELEASE_SHA: fakeSourceSha(options.recorded),
      }
    : {}
  writeFileSync(
    join(directory, ".env"),
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
    { mode: 0o600 }
  )
  if (options.initialized !== false) {
    writeFileSync(
      join(terraform, "backend.json"),
      JSON.stringify({
        store: { kind: "r2", bucket: "azad-install", account_id: "b".repeat(32) },
      })
    )
    writeFileSync(
      join(terraform, "terraform.tfvars.json"),
      JSON.stringify({
        deployment: {
          env_file: join(directory, ".env"),
          state_directory: join(terraform, "installer-state"),
        },
      })
    )
  }
  const statusRuns: string[][] = []
  const run: RunUpdater = async (args) => {
    statusRuns.push(args)
    if (options.statusFails) return { status: 1, stdout: "" }
    const installed = options.installed
    return {
      status: 0,
      stdout: JSON.stringify({
        operation: null,
        release:
          installed === undefined
            ? null
            : {
                version: installed,
                sourceSha: installed ? fakeSourceSha(installed) : "c".repeat(40),
              },
        infrastructure: null,
      }),
    }
  }
  const notes: string[] = []
  const resolve = (request: { source?: string; version?: string } = {}, execute?: Run) =>
    releaseResolver(directory, request, {
      fetcher: fake.fetcher,
      trust: fake.trust,
      home,
      run,
      execute,
      note: (message) => notes.push(message),
    })(values)
  return { ...fake, home, directory, values, statusRuns, notes, resolve }
}

const downloaded = (requested: string[]) =>
  [...new Set(requested.map((path) => path.split("/")[4]))].filter(
    (version) => version && version !== "latest.json"
  )

test("a new install takes the latest release, or the one --version names", async () => {
  const f = fixture()
  expect((await f.resolve()).version).toBe("5.31.0")
  expect((await f.resolve({ version: "5.29.0" })).version).toBe("5.29.0")
  expect(f.statusRuns).toEqual([])
})

test("an existing install deploys the newer of its recorded release and its receipt's", async () => {
  // A console update moved it past the recorded release.
  const moved = fixture({ recorded: "5.29.0", installed: "5.30.0" })
  const release = await moved.resolve()
  expect(release.version).toBe("5.30.0")
  expect(release.directory).toBe(publicReleaseDirectory("5.30.0", moved.home))
  expect(moved.notes.join("\n")).toContain(
    "This installation runs Azad 5.30.0, newer than the 5.29.0 its settings record"
  )
  // The receipt is read with the recorded release's own updater.
  expect(moved.statusRuns[0][0]).toBe(
    join(publicReleaseDirectory("5.29.0", moved.home), "payload", "updater", "updater.js")
  )
  expect(moved.statusRuns[0][1]).toBe("status")
  // Never the latest: the installation keeps the release it runs.
  expect(downloaded(moved.requested)).toEqual(["5.29.0", "5.30.0"])

  // A receipt older than the record (an unfinished deploy) keeps the record.
  const behind = fixture({ recorded: "5.30.0", installed: "5.29.0" })
  expect((await behind.resolve()).version).toBe("5.30.0")
  expect(downloaded(behind.requested)).toEqual(["5.30.0"])
})

test("without a readable receipt the recorded release is used, and why is noted", async () => {
  const before = fixture({ recorded: "5.30.0", initialized: false })
  expect((await before.resolve()).version).toBe("5.30.0")
  expect(before.statusRuns).toEqual([])
  const failing = fixture({ recorded: "5.30.0", statusFails: true })
  expect((await failing.resolve()).version).toBe("5.30.0")
  expect(failing.notes.join("\n")).toContain(
    "Reading the installation's status failed"
  )
  const versionless = fixture({ recorded: "5.30.0", installed: null })
  expect((await versionless.resolve()).version).toBe("5.30.0")
})

test("a cached recorded release is reused without downloading it again", async () => {
  const f = fixture({ recorded: "5.30.0", installed: "5.30.0" })
  await f.resolve()
  f.requested.length = 0
  expect((await f.resolve()).version).toBe("5.30.0")
  expect(f.requested).toEqual([])
})

test("--version moves an existing install to a newer release and refuses an older one before downloading it", async () => {
  const f = fixture({ recorded: "5.29.0", installed: "5.30.0" })
  expect((await f.resolve({ version: "5.31.0" })).version).toBe("5.31.0")
  f.requested.length = 0
  await expect(f.resolve({ version: "5.29.0" })).rejects.toThrow(
    "This installation runs Azad 5.30.0, which is newer than Azad 5.29.0. An older release is never deployed over a newer one"
  )
  expect(downloaded(f.requested)).not.toContain("5.29.0")
  expect((await f.resolve({ version: "5.30.0" })).version).toBe("5.30.0")
})

test("--source deploys a local build, unless the installation runs a newer release", async () => {
  const f = fixture({ recorded: "5.30.0", installed: "5.30.0" })
  const checkout = join(f.directory, "..", "app")
  mkdirSync(join(checkout, "scripts", "self-host"), { recursive: true })
  mkdirSync(join(checkout, "node_modules"))
  writeFileSync(join(checkout, "scripts", "self-host", "local-release.ts"), "")
  const build = (version: string): Run => (command, args) => {
    if (command === "git") return { status: 1, stdout: "" }
    fakeReleaseDirectory(args[args.indexOf("--out") + 1], {
      version,
      sourceSha: "e".repeat(40),
    })
    return { status: 0, stdout: "" }
  }
  await expect(f.resolve({ source: checkout }, build("0.0.0"))).rejects.toThrow(
    "This installation runs Azad 5.30.0, which is newer than a local build of eeeeeeeeeeee (version 0.0.0)"
  )
  const local = await f.resolve({ source: checkout }, build("5.31.0"))
  expect(local).toEqual({
    directory: localReleaseDirectory("e".repeat(40), f.home),
    version: "5.31.0",
    sourceSha: "e".repeat(40),
    signed: false,
  })
})
