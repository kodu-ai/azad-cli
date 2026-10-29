import { afterEach, expect, test } from "bun:test"
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parse } from "dotenv"
import {
  LocalConfig,
  ownerOnly,
  serializeEnv,
  upsertPrivateEnv,
} from "./config"

const directories: string[] = []
function directory() {
  const path = mkdtempSync(join(tmpdir(), "azad-cli-config-"))
  directories.push(path)
  return path
}
afterEach(() => {
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true })
})

test("credentials round-trip literally without shell interpolation", () => {
  const values = {
    TOKEN: '  literal $(touch nope) `id` $HOME # = "quoted"  ',
    PEM: "-----BEGIN PRIVATE KEY-----\nfixture-only\n-----END PRIVATE KEY-----\n",
    PASSWORD: "backslash\\n and 'single' quote",
    EMPTY: "",
  }
  expect(parse(serializeEnv(values))).toEqual(values)
})

test("checkpoint resumes values and keeps private modes when replacing a file", () => {
  const root = directory()
  const config = new LocalConfig(join(root, "instance"))
  config.save({ TOKEN: "fixture-first" })
  const resumed = new LocalConfig(config.directory)
  expect(resumed.read()).toEqual({ TOKEN: "fixture-first" })
  resumed.save({ TOKEN: "fixture-rotated", PEM: "a\nb\n" })
  expect(config.read()).toEqual({ TOKEN: "fixture-rotated", PEM: "a\nb\n" })
  expect(statSync(config.directory).mode & 0o777).toBe(0o700)
  expect(statSync(config.envPath).mode & 0o777).toBe(0o600)
  expect(readFileSync(join(config.directory, ".gitignore"), "utf8")).toBe("*\n")
})

test("a symlink cannot redirect a secret checkpoint to another file", () => {
  const root = directory()
  const target = join(root, "outside")
  writeFileSync(target, "keep")
  const config = new LocalConfig(join(root, "instance"))
  symlinkSync(target, config.envPath)
  expect(() => config.save({ TOKEN: "fixture-only" })).toThrow("regular file")
  expect(readFileSync(target, "utf8")).toBe("keep")
})

test("invalid dotenv values fail before overwriting the saved configuration", () => {
  const config = new LocalConfig(directory())
  config.save({ TOKEN: "keep" })
  expect(() => config.save({ TOKEN: "bad\0value" })).toThrow("NUL")
  expect(config.read()).toEqual({ TOKEN: "keep" })
})

test("a private settings file can drop a setting while every other line stays as written", () => {
  const path = join(directory(), ".env.self-host")
  const text =
    "# kept comment\nCLERK_SECRET_KEY='fixture-clerk'\nPEM=\"a\\nb\"\nAZAD_CLI_GOOGLE_CLIENT_ID=old\n"
  writeFileSync(path, text, { mode: 0o600 })
  upsertPrivateEnv(path, {
    AZAD_CLI_GOOGLE_CLIENT_ID: undefined,
    AZAD_CLI_CLERK_NATIVE: "disabled",
  })
  const after = readFileSync(path, "utf8")
  expect(
    after.startsWith("# kept comment\nCLERK_SECRET_KEY='fixture-clerk'\n")
  ).toBe(true)
  expect(parse(after)).toEqual({
    CLERK_SECRET_KEY: "fixture-clerk",
    PEM: "a\nb",
    AZAD_CLI_CLERK_NATIVE: "disabled",
  })
  expect(statSync(path).mode & 0o777).toBe(0o600)
})

test("a settings file written with Windows line endings is edited without changing its other settings", () => {
  const path = join(directory(), ".env.self-host")
  writeFileSync(path, "# note\r\nA='one'\r\nPEM=\"a\\nb\"\r\nB=two\r\n", {
    mode: 0o600,
  })
  upsertPrivateEnv(path, { A: "uno", B: undefined })
  expect(readFileSync(path, "utf8")).toBe("# note\nPEM=\"a\\nb\"\nA='uno'\n")
})

test("Windows files count as private: they have no permission bits, and their folder's access list protects them", () => {
  expect(ownerOnly({ mode: 0o100600 }, "linux")).toBe(true)
  expect(ownerOnly({ mode: 0o100644 }, "darwin")).toBe(false)
  // Node reports every writable Windows file as 0o666.
  expect(ownerOnly({ mode: 0o100666 }, "win32")).toBe(true)
})
