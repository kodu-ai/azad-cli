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

const script = join(import.meta.dir, "..", "install.sh")
const releases = "https://github.com/kodu-ai/azad-cli/releases"
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

/**
 * A local stand-in for GitHub Releases: a curl shim that serves
 * `<root>/releases/<tag>/<asset>` for `releases/download/<tag>/<asset>` and
 * answers `releases/latest` with `LATEST_TAG`, failing like `curl --fail`
 * for anything missing. uname is pinned, so every case runs anywhere.
 */
function fakeRelease(options: {
  tag?: string
  binary?: string
  sums?: (digest: string) => string
  system?: string
  machine?: string
}) {
  const root = mkdtempSync(join(tmpdir(), "azad-install-"))
  roots.push(root)
  const binary = options.binary ?? "#!/bin/sh\necho fixture-azad\n"
  const asset = "azad-linux-x64"
  if (options.tag) {
    const directory = join(root, "releases", options.tag)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, asset), binary)
    const digest = createHash("sha256")
      .update("#!/bin/sh\necho fixture-azad\n")
      .digest("hex")
    writeFileSync(
      join(directory, "SHA256SUMS"),
      options.sums?.(digest) ??
        `${"0".repeat(64)}  azad-darwin-arm64\n${digest}  ${asset}\n`
    )
  }
  const shims = join(root, "shims")
  mkdirSync(shims)
  writeFileSync(
    join(shims, "curl"),
    `#!/bin/sh
out=""; format=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift ;;
    -w) format="$2"; shift ;;
    https://*) url="$1" ;;
  esac
  shift
done
printf '%s\\n' "$url" >> "$FIXTURE_ROOT/requests.log"
if [ "$url" = "${releases}/latest" ]; then
  if [ -n "\${LATEST_TAG:-}" ]; then printf '%s' "${releases}/tag/$LATEST_TAG"; else printf '%s' "${releases}"; fi
  exit 0
fi
file="$FIXTURE_ROOT/releases/\${url#${releases}/download/}"
[ -f "$file" ] || exit 22
cp "$file" "$out"
`,
    { mode: 0o755 }
  )
  writeFileSync(
    join(shims, "uname"),
    `#!/bin/sh\nif [ "$1" = -m ]; then echo ${options.machine ?? "x86_64"}; else echo ${options.system ?? "Linux"}; fi\n`,
    { mode: 0o755 }
  )
  return { root, binary, installDir: join(root, "bin") }
}

function install(
  fixture: { root: string; installDir: string },
  env: Record<string, string> = {}
) {
  const result = spawnSync("sh", [script], {
    encoding: "utf8",
    env: {
      PATH: `${join(fixture.root, "shims")}:/usr/bin:/bin`,
      HOME: fixture.root,
      FIXTURE_ROOT: fixture.root,
      AZAD_INSTALL_DIR: fixture.installDir,
      ...env,
    },
  })
  const requests = existsSync(join(fixture.root, "requests.log"))
    ? readFileSync(join(fixture.root, "requests.log"), "utf8")
        .trim()
        .split("\n")
    : []
  return { ...result, requests }
}

test("the latest release is resolved once, verified against its SHA256SUMS and installed atomically", () => {
  const f = fakeRelease({ tag: "v0.0.3" })
  const result = install(f, { LATEST_TAG: "v0.0.3" })
  expect(result.stderr).toBe("")
  expect(result.status).toBe(0)
  expect(result.stdout).toContain(
    `Installed azad 0.0.3 at ${f.installDir}/azad`
  )
  expect(readFileSync(join(f.installDir, "azad"), "utf8")).toBe(f.binary)
  expect(readdirSync(f.installDir)).toEqual(["azad"])
  expect(result.requests).toEqual([
    `${releases}/latest`,
    `${releases}/download/v0.0.3/SHA256SUMS`,
    `${releases}/download/v0.0.3/azad-linux-x64`,
  ])
})

test("AZAD_VERSION pins a release, with or without its v prefix", () => {
  for (const version of ["0.0.1", "v0.0.1"]) {
    const f = fakeRelease({ tag: "v0.0.1" })
    const result = install(f, { AZAD_VERSION: version, LATEST_TAG: "v9.9.9" })
    expect(result.status).toBe(0)
    expect(result.requests[0]).toBe(`${releases}/download/v0.0.1/SHA256SUMS`)
    expect(readFileSync(join(f.installDir, "azad"), "utf8")).toBe(f.binary)
  }
})

test("a download that does not match its checksum installs nothing", () => {
  const f = fakeRelease({ tag: "v0.0.1", binary: "tampered" })
  const result = install(f, { AZAD_VERSION: "0.0.1" })
  expect(result.status).toBe(1)
  expect(result.stderr).toBe(
    "The download of azad-linux-x64 does not match its SHA-256 checksum. Nothing was installed.\n"
  )
  expect(readdirSync(f.installDir)).toEqual([])
})

test("a release without this platform's build, or no release at all, installs nothing", () => {
  const missing = fakeRelease({
    tag: "v0.0.1",
    sums: (digest) => `${digest}  azad-darwin-arm64\n`,
  })
  const result = install(missing, { AZAD_VERSION: "0.0.1" })
  expect(result.status).toBe(1)
  expect(result.stderr).toBe("azad 0.0.1 has no azad-linux-x64 build.\n")
  expect(readdirSync(missing.installDir)).toEqual([])

  const none = fakeRelease({})
  const unpublished = install(none)
  expect(unpublished.status).toBe(1)
  expect(unpublished.stderr).toBe(
    `No azad release is published yet at ${releases}.\n`
  )
  expect(existsSync(none.installDir)).toBe(false)

  const unknown = install(fakeRelease({}), { AZAD_VERSION: "0.0.1" })
  expect(unknown.status).toBe(1)
  expect(unknown.stderr).toContain("Could not download")
})

test("an invalid AZAD_VERSION is refused before any download", () => {
  const f = fakeRelease({ tag: "v0.0.1" })
  const result = install(f, { AZAD_VERSION: "latest; rm -rf /" })
  expect(result.status).toBe(1)
  expect(result.stderr).toBe(
    "AZAD_VERSION must be a release version, such as 0.0.1.\n"
  )
  expect(result.requests).toEqual([])
})

test("on Windows the script installs nothing and points to the .exe and WSL", () => {
  const f = fakeRelease({ tag: "v0.0.1", system: "MINGW64_NT-10.0" })
  const result = install(f)
  expect(result.status).toBe(1)
  expect(result.stderr).toBe(
    `This script installs azad on Linux and macOS. On Windows, download azad-windows-x64.exe from ${releases}/latest and check it against SHA256SUMS there, or run this script in WSL.\n`
  )
  expect(existsSync(f.installDir)).toBe(false)
})
