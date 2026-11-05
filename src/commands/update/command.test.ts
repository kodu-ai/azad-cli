import { afterEach, expect, spyOn, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fakeRelease } from "../../../test/fake-release"
import { releaseOrigin, statusLines, updateMain } from "./command"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
  delete process.env.AZAD_INSTALL_SECRETS
})
const scratch = () => {
  const root = mkdtempSync(join(tmpdir(), "azad-update-"))
  roots.push(root)
  return root
}

/** A Google Cloud instance as a deploy and azad-terraform's init leave it. */
function deployedInstance(options: { handoff?: boolean } = {}) {
  const directory = join(scratch(), "instance")
  const terraform = join(directory, "terraform", "gcp-celld")
  const state = join(terraform, "celld-install")
  mkdirSync(state, { recursive: true, mode: 0o700 })
  writeFileSync(
    join(directory, ".env"),
    "AZAD_CLI_TARGET=gcp\nAZAD_CLI_SOURCE_REVISION=" + "c".repeat(40) + "\n",
    { mode: 0o600 }
  )
  const store = { kind: "gcs", bucket: "azad-1a2b3c4d-install", project_id: "my-project" }
  writeFileSync(join(terraform, "backend.json"), JSON.stringify({ store }))
  writeFileSync(
    join(terraform, "terraform.tfvars.json"),
    JSON.stringify({
      project_id: "my-project",
      deployment: {
        revision: "c".repeat(40),
        env_file: join(directory, ".env"),
        state_directory: state,
      },
    })
  )
  if (options.handoff) writeFileSync(join(state, "handoff.json"), "{}\n")
  return { directory, state, store }
}

test("a laptop update runs the verified release's updater with the instance's store, settings and key cache", async () => {
  const instance = deployedInstance({ handoff: true })
  const release = fakeRelease(scratch())
  const runs: { args: string[]; cwd: string }[] = []
  const status = await updateMain(
    ["--directory", instance.directory, "--accept-maintenance"],
    {
      fetcher: release.fetcher,
      trust: release.trust,
      run: async (args, options) => {
        runs.push({ args, cwd: options.cwd })
        return { status: 0, stdout: "" }
      },
    }
  )
  expect(status).toBe(0)
  const work = join(instance.directory, "update")
  expect(runs).toEqual([
    {
      cwd: work,
      args: [
        join(work, "launcher", "payload", "updater", "updater.js"),
        "update",
        "--store",
        JSON.stringify(instance.store),
        "--work",
        join(work, "run"),
        "--state",
        instance.state,
        "--settings",
        join(instance.directory, ".env"),
        "--handoff",
        join(instance.state, "handoff.json"),
        "--host",
        "cli",
        "--version",
        "5.30.0",
        "--origin",
        "https://api.azad.pro",
        "--accept-maintenance",
      ],
    },
  ])
})

test("the updater's exit code is the command's, and an instance that was never deployed is refused", async () => {
  const instance = deployedInstance()
  const release = fakeRelease(scratch())
  expect(
    await updateMain(["--directory", instance.directory], {
      fetcher: release.fetcher,
      trust: release.trust,
      run: async () => ({ status: 75, stdout: "" }),
    })
  ).toBe(75)
  const fresh = join(scratch(), "fresh")
  mkdirSync(fresh)
  await expect(
    updateMain(["--directory", fresh], {
      fetcher: release.fetcher,
      trust: release.trust,
    })
  ).rejects.toThrow("has no deployed installation")
})

test("a release older than the first updater azad can run is refused before anything runs", async () => {
  const instance = deployedInstance()
  const release = fakeRelease(scratch(), { version: "4.20.0" })
  const runs: string[][] = []
  await expect(
    updateMain(["--directory", instance.directory, "--version", "4.20.0"], {
      fetcher: release.fetcher,
      trust: release.trust,
      run: async (args) => {
        runs.push(args)
        return { status: 0, stdout: "" }
      },
    })
  ).rejects.toThrow("older than azad update can install")
  expect(runs).toEqual([])
})

test("--status prints the installation's state beside the latest release", async () => {
  const instance = deployedInstance()
  const release = fakeRelease(scratch())
  const written: string[] = []
  const write = spyOn(process.stdout, "write").mockImplementation((chunk) => {
    written.push(String(chunk))
    return true
  })
  try {
    const status = await updateMain(
      ["--directory", instance.directory, "--status", "--json"],
      {
        fetcher: release.fetcher,
        trust: release.trust,
        run: async (args, options) => {
          expect(options.capture).toBe(true)
          expect(args.slice(1)).toEqual([
            "status",
            "--store",
            JSON.stringify(instance.store),
            "--settings",
            join(instance.directory, ".env"),
          ])
          return {
            status: 0,
            stdout: JSON.stringify({
              operation: null,
              release: { version: "5.29.0", sourceSha: "d".repeat(40), manifestSha256: null },
              infrastructure: { revision: 1, capabilities: [] },
            }),
          }
        },
      }
    )
    expect(status).toBe(0)
  } finally {
    write.mockRestore()
  }
  expect(JSON.parse(written.join(""))).toMatchObject({
    status: "ok",
    latest: { version: "5.30.0", sourceSha: "a".repeat(40) },
    installed: { version: "5.29.0" },
    operation: null,
  })
})

test("the status lines say what runs, what is newer and how to resume a stopped update", () => {
  expect(
    statusLines({
      latest: { version: "5.30.0", publishedAt: "2026-11-05T01:00:00.000Z" },
      installed: { version: null, sourceSha: "e".repeat(40) },
      operation: {
        id: "op1",
        kind: "release-update",
        status: "stopped",
        outcome: null,
        target: { version: "5.30.0" },
        holder: null,
        error: "Wrangler failed.",
        updatedAt: "2026-11-05T01:00:00.000Z",
      },
    })
  ).toEqual([
    "Installed: deployed from source eeeeeeeeeeee.",
    "Latest: Azad 5.30.0, published 2026-11-05T01:00:00.000Z.",
    "Stopped: release-update to 5.30.0 (operation op1): Wrangler failed. Run azad update --version 5.30.0 to resume it.",
  ])
})

test("a Cloudflare container's secrets reach the updater only as a private file, removed afterwards", async () => {
  const work = join(scratch(), "work")
  const release = fakeRelease(scratch(), { version: "5.31.0" })
  process.env.AZAD_INSTALL_SECRETS = JSON.stringify({
    settings: "CLOUDFLARE_API_TOKEN=secret\n",
    "release-key": "-----BEGIN PRIVATE KEY-----\n",
  })
  const store = { kind: "r2", bucket: "azad-x-1a2b3c4d-install", account_id: "f".repeat(32) }
  let seen: string[] = []
  const status = await updateMain(
    [
      "--host",
      "cloudflare-container",
      "--store",
      JSON.stringify(store),
      "--version",
      "5.31.0",
      "--executor",
      "cloudflare-container:abc",
      "--work",
      work,
      "--confirm-stopped",
      "cloudflare-container:old",
    ],
    {
      fetcher: release.fetcher,
      trust: release.trust,
      run: async (args) => {
        seen = args
        const file = args[args.indexOf("--secrets") + 1]
        expect(statSync(file).mode & 0o777).toBe(0o600)
        expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
          settings: "CLOUDFLARE_API_TOKEN=secret\n",
          "release-key": "-----BEGIN PRIVATE KEY-----\n",
        })
        expect(readFileSync(args[args.indexOf("--settings") + 1], "utf8")).toBe(
          "CLOUDFLARE_API_TOKEN=secret\n"
        )
        expect(args).not.toContain("--handoff")
        expect(process.env.AZAD_INSTALL_SECRETS).toBeUndefined()
        return { status: 0, stdout: "" }
      },
    }
  )
  expect(status).toBe(0)
  expect(seen.slice(1)).toEqual([
    "update",
    "--store",
    JSON.stringify(store),
    "--work",
    join(work, "run"),
    "--host",
    "cloudflare-container",
    "--executor",
    "cloudflare-container:abc",
    "--secrets",
    join(work, "secrets.json"),
    "--settings",
    join(work, "settings.env"),
    "--version",
    "5.31.0",
    "--origin",
    "https://api.azad.pro",
    "--confirm-stopped",
    "cloudflare-container:old",
  ])
  expect(existsSync(join(work, "secrets.json"))).toBe(false)
  expect(existsSync(join(work, "settings.env"))).toBe(false)
})

test("a host run needs its store, executor and an exact version; plain HTTP origins only on loopback", async () => {
  const store = JSON.stringify({ kind: "gcs", bucket: "azad-1a2b3c4d-install", project_id: "my-project" })
  await expect(
    updateMain(["--host", "gke-job", "--store", store, "--version", "5.30.0"])
  ).rejects.toThrow("--executor")
  await expect(
    updateMain(["--host", "gke-job", "--store", store, "--version", "latest", "--executor", "j"])
  ).rejects.toThrow("exact --version")
  await expect(
    updateMain(["--host", "gke-job", "--store", "{}", "--version", "5.30.0", "--executor", "j"])
  ).rejects.toThrow("Pass --store")
  await expect(updateMain(["--host", "laptop"])).rejects.toThrow("--host is")
  expect(releaseOrigin("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787")
  expect(() => releaseOrigin("http://releases.example")).toThrow("https://")
  expect(() => releaseOrigin("https://releases.example/path")).toThrow("https://")
})
