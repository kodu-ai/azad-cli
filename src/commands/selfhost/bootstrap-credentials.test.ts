import { afterEach, expect, test } from "bun:test"
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LocalConfig } from "./config"
import {
  saveBootstrapToken,
  validateBootstrapFile,
} from "./bootstrap-credentials"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "azad-bootstrap-credential-"))
  roots.push(root)
  return root
}

test("bootstrap token is separate from workload credentials and its path is safe to retain", () => {
  const root = fixture()
  const workload = new LocalConfig(root)
  workload.save({ CLERK_SECRET_KEY: "fixture-clerk" })
  const path = saveBootstrapToken(root, " fixture-bootstrap ")
  expect(path).not.toBe(workload.envPath)
  expect(readFileSync(workload.envPath, "utf8")).not.toContain(
    "fixture-bootstrap"
  )
  expect(readFileSync(path, "utf8")).toBe(
    "CLOUDFLARE_BOOTSTRAP_API_TOKEN='fixture-bootstrap'\n"
  )
  expect(statSync(path).mode & 0o777).toBe(0o600)
  const before = statSync(path)
  validateBootstrapFile(path)
  expect(statSync(path).mtimeMs).toBe(before.mtimeMs)
})

test("bootstrap status refuses readable-by-others files and symlinks without changing them", () => {
  const root = fixture()
  const path = saveBootstrapToken(root, "fixture-bootstrap")
  chmodSync(path, 0o644)
  expect(() => validateBootstrapFile(path)).toThrow("private regular file")
  expect(statSync(path).mode & 0o777).toBe(0o644)
  chmodSync(path, 0o600)
  const link = join(root, "link.env")
  symlinkSync(path, link)
  expect(() => validateBootstrapFile(link)).toThrow("private regular file")
})
