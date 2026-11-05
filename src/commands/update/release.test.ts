import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CliError } from "../../error"
import { fakeRelease } from "../../../test/fake-release"
import { releaseClient, verifyManifest } from "./release"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})
const scratch = () => {
  const root = mkdtempSync(join(tmpdir(), "azad-release-"))
  roots.push(root)
  return root
}
/** A fake release and a client of it. */
const served = (options?: Parameters<typeof fakeRelease>[1]) => {
  const fake = fakeRelease(scratch(), options)
  return {
    ...fake,
    client: releaseClient({
      origin: "https://releases.test",
      fetcher: fake.fetcher,
      trust: fake.trust,
    }),
  }
}
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex")

test("the manifest production published verifies with the pinned key, and a changed one does not", () => {
  // Recorded from https://api.azad.pro/api/v3/releases/4.26.1/manifest.json,
  // signed by the app's release workflow: proves this canonical form and
  // verification match the signer's.
  const bytes = readFileSync(
    join(import.meta.dir, "../../../test/fixtures/release-4.26.1-manifest.json")
  )
  expect(sha256(bytes)).toBe(
    "4c1a59f515df428ba03eb11609da944eda50a7aba221659891899522a375f1ac"
  )
  const manifest = verifyManifest(bytes)
  expect(manifest.version).toBe("4.26.1")
  expect(manifest.artifacts.updater.path).toBe("updater-4.26.1.tar.gz")
  const changed = JSON.parse(bytes.toString("utf8"))
  changed.artifacts.updater.sha256 = "0".repeat(64)
  expect(() =>
    verifyManifest(new TextEncoder().encode(JSON.stringify(changed)))
  ).toThrow("signature is invalid")
})

test("latest resolves through the pointer, and the updater unpacks privately after its digest matches", async () => {
  const { client, requested } = served()
  const release = await client.release("latest")
  expect(release.manifest.version).toBe("4.30.0")
  const directory = join(scratch(), "launcher")
  const entry = await client.updater(release.manifest, directory)
  expect(entry).toBe(join(directory, "payload", "updater", "updater.js"))
  expect(readFileSync(entry, "utf8")).toBe("// the updater\n")
  expect(statSync(directory).mode & 0o777).toBe(0o700)
  // The archive itself is not kept.
  expect(existsSync(join(directory, "updater-4.30.0.tar.gz"))).toBe(false)
  expect(requested).toEqual([
    "/api/v3/releases/latest.json",
    "/api/v3/releases/4.30.0/manifest.json",
    "/api/v3/releases/4.30.0/updater-4.30.0.tar.gz",
  ])
})

test("an exact version reads its manifest without the pointer", async () => {
  const { client, requested } = served()
  expect((await client.release("4.30.0")).manifest.version).toBe("4.30.0")
  expect(requested).toEqual(["/api/v3/releases/4.30.0/manifest.json"])
  await expect(client.release("v4.30")).rejects.toThrow("exact x.y.z")
})

test("every mismatch with the signed manifest or the pointer is refused", async () => {
  const cases: [Parameters<typeof fakeRelease>[1], string][] = [
    [{ tamper: "pointer-digest" }, "differs from the digest"],
    [{ tamper: "pointer-source" }, "names another source"],
    [{ tamper: "version" }, "names another version"],
    [{ keyId: "someone-else" }, "does not trust"],
  ]
  for (const [options, message] of cases) {
    const { client } = served(options)
    const outcome = client.release("latest")
    await expect(outcome).rejects.toBeInstanceOf(CliError)
    await expect(outcome).rejects.toThrow(message)
  }
  const { client } = served({ tamper: "archive" })
  const release = await client.release("latest")
  await expect(
    client.updater(release.manifest, join(scratch(), "launcher"))
  ).rejects.toThrow("does not match its signed manifest")
})
