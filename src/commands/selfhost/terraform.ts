import { createHash, randomUUID } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { CliError } from "../../error"
import type { Run } from "../../process"
import { localPath } from "./instance"

/**
 * The azad-terraform release this CLI deploys with: its Terraform roots and
 * modules and the drivers that run them. Bump it, and only it, to adopt a
 * new release.
 */
export const AZAD_TERRAFORM_VERSION = "0.0.1"

/**
 * The SHA-256 of each azad-terraform release tarball this CLI trusts, pinned
 * when the release is adopted. The download must match both the release's
 * own checksum file and this pin, so an asset replaced after publication is
 * refused even when its checksum file was replaced with it.
 */
export const AZAD_TERRAFORM_SHA256: Readonly<Record<string, string>> = {
  "0.0.1": "b997103ecb48fd97f39e4484254645efe8d08f37584826ea10b5861cc54566d4",
}

/** The GitHub repository that publishes azad-terraform releases. */
export const AZAD_TERRAFORM_REPOSITORY = "kodu-ai/azad-terraform"

/** The drivers in an azad-terraform tree, `scripts/<driver>.ts`. */
export type TerraformDriver = "cloudflare" | "gcp" | "bootstrap"
const DRIVERS: readonly TerraformDriver[] = ["cloudflare", "gcp", "bootstrap"]

/** Where the drivers come from for a run. */
export type TerraformSelection =
  | {
      /** The pinned release, downloaded once into the cache. */
      kind: "release"
      version: string
      /** `~/.azad/cache/azad-terraform/<version>`. */
      directory: string
      /** The release tarball; `<url>.sha256` holds its checksum. */
      url: string
    }
  | {
      /** A local checkout, from `--terraform-dir` or `AZAD_TERRAFORM_DIR`. */
      kind: "local"
      directory: string
    }

/** The release tarball of `version` on GitHub. */
export function terraformReleaseUrl(version: string): string {
  return `https://github.com/${AZAD_TERRAFORM_REPOSITORY}/releases/download/v${version}/azad-terraform-${version}.tar.gz`
}

/** Where a release is extracted: `~/.azad/cache/azad-terraform/<version>`. */
export function terraformCacheDirectory(
  version: string,
  home = homedir()
): string {
  return join(home, ".azad", "cache", "azad-terraform", version)
}

/**
 * The drivers a run uses: a local checkout named by `directory`
 * (`--terraform-dir`) or, failing that, `AZAD_TERRAFORM_DIR`; otherwise the
 * pinned release in the cache. Nothing is read or downloaded here.
 */
export function selectTerraform(
  options: {
    directory?: string
    env?: Record<string, string | undefined>
    home?: string
    cwd?: string
    version?: string
  } = {}
): TerraformSelection {
  const home = options.home ?? homedir()
  const override =
    options.directory?.trim() || options.env?.AZAD_TERRAFORM_DIR?.trim()
  if (override)
    return {
      kind: "local",
      directory: resolve(options.cwd ?? process.cwd(), localPath(override, home)),
    }
  const version = options.version ?? AZAD_TERRAFORM_VERSION
  return {
    kind: "release",
    version,
    directory: terraformCacheDirectory(version, home),
    url: terraformReleaseUrl(version),
  }
}

/** A driver's script in an azad-terraform tree. */
export function driverPath(directory: string, driver: TerraformDriver): string {
  return join(directory, "scripts", `${driver}.ts`)
}

/** How a selection reads in messages: `azad-terraform 0.0.1` or the local path. */
export function describeTerraform(selection: TerraformSelection): string {
  return selection.kind === "release"
    ? `azad-terraform ${selection.version}`
    : `azad-terraform from ${selection.directory}`
}

const READY_MARKER = ".azad-cli-ready.json"

function hasDrivers(directory: string): boolean {
  return DRIVERS.every((driver) => existsSync(driverPath(directory, driver)))
}

/**
 * True when the selection's drivers can run without a download: a local
 * checkout with the three drivers, or a release whose extraction and
 * dependency install completed.
 */
export function terraformReady(selection: TerraformSelection): boolean {
  if (!hasDrivers(selection.directory)) return false
  return (
    selection.kind === "local" ||
    existsSync(join(selection.directory, READY_MARKER))
  )
}

async function download(
  url: string,
  version: string,
  fetcher: typeof fetch
): Promise<Uint8Array> {
  const unreachable = `Could not download azad-terraform ${version} from ${url}. Check your internet connection and proxy settings, then retry. To deploy offline, point --terraform-dir at a local azad-terraform checkout.`
  let response: Response
  try {
    response = await fetcher(url, { redirect: "follow" })
  } catch {
    throw new CliError(unreachable)
  }
  if (!response.ok)
    throw new CliError(
      response.status === 404
        ? `azad-terraform ${version}, which this azad release deploys with, is not published at ${url} (HTTP 404). Install an azad release whose azad-terraform is published, or point --terraform-dir at a local azad-terraform checkout.`
        : `Could not download azad-terraform ${version} from ${url} (HTTP ${response.status}). Retry later.`
    )
  try {
    return new Uint8Array(await response.arrayBuffer())
  } catch {
    throw new CliError(unreachable)
  }
}

/**
 * The digest in a `sha256sum` line naming `name`: `<64 hex>  <name>`, with
 * `*` before the name for binary mode.
 */
export function checksumFor(text: string, name: string): string | undefined {
  for (const line of text.split(/\r?\n/u)) {
    const match = /^([a-f0-9]{64}) [ *](\S+)$/u.exec(line.trim())
    if (match && match[2] === name) return match[1]
  }
  return undefined
}

/** True for an archive member inside `top/`, with no absolute or parent path. */
function memberInside(name: string, top: string): boolean {
  const path = name.replace(/^\.\//u, "")
  if (path === "" || path === ".") return true
  if (path.startsWith("/") || /^[A-Za-z]:/u.test(path)) return false
  const parts = path.split(/[\\/]/u).filter(Boolean)
  return parts[0] === top && !parts.includes("..")
}

/**
 * Makes the selected drivers runnable and returns their directory.
 *
 * A local checkout is checked for the three drivers and gets
 * `bun install --frozen-lockfile` once, when it has no `node_modules`.
 *
 * The pinned release, unless already prepared, is downloaded with its
 * `.sha256` file from GitHub, verified, extracted (its single top-level
 * directory is `azad-terraform-<version>/`) into the cache directory, and
 * gets `bun install --frozen-lockfile` there. A marker file records the
 * completed preparation; an interrupted one is redone from the download.
 *
 * @throws CliError when the download fails (offline, unpublished), the
 * checksum does not match the release's checksum file or this CLI's pin, the archive is malformed, or the dependency
 * install fails. Nothing partial is ever used.
 */
export async function prepareTerraform(
  selection: TerraformSelection,
  options: {
    execute: Run
    fetcher?: typeof fetch
    note?: (message: string) => void
    /** Pinned release digests; defaults to {@link AZAD_TERRAFORM_SHA256}. */
    pins?: Readonly<Record<string, string>>
  }
): Promise<string> {
  const { execute } = options
  const install = (directory: string, failure: string) => {
    if (
      execute("bun", ["--no-env-file", "install", "--frozen-lockfile"], directory)
        .status !== 0
    )
      throw new CliError(failure)
  }
  if (selection.kind === "local") {
    if (!hasDrivers(selection.directory))
      throw new CliError(
        `${selection.directory} is not an azad-terraform checkout: it needs scripts/cloudflare.ts, scripts/gcp.ts and scripts/bootstrap.ts. Point --terraform-dir (or AZAD_TERRAFORM_DIR) at a clone of https://github.com/${AZAD_TERRAFORM_REPOSITORY}.`
      )
    if (!existsSync(join(selection.directory, "node_modules")))
      install(
        selection.directory,
        `Installing the dependencies of ${selection.directory} failed. Run bun install --frozen-lockfile there, then retry.`
      )
    return selection.directory
  }
  if (terraformReady(selection)) return selection.directory
  const { version, url, directory } = selection
  const name = `azad-terraform-${version}.tar.gz`
  const top = `azad-terraform-${version}`
  const fetcher = options.fetcher ?? fetch
  options.note?.(`Downloading azad-terraform ${version}…`)
  const expected = checksumFor(
    new TextDecoder().decode(await download(`${url}.sha256`, version, fetcher)),
    name
  )
  if (!expected)
    throw new CliError(
      `The checksum file of azad-terraform ${version} (${url}.sha256) does not list ${name}. Nothing was installed.`
    )
  const pinned = (options.pins ?? AZAD_TERRAFORM_SHA256)[version]
  if (pinned && expected !== pinned)
    throw new CliError(
      `The checksum published for azad-terraform ${version} does not match the one this CLI pins. Nothing was installed; report this to the Azad maintainers.`
    )
  const archive = await download(url, version, fetcher)
  if (createHash("sha256").update(archive).digest("hex") !== expected)
    throw new CliError(
      `The azad-terraform ${version} download does not match its published SHA-256 checksum. Nothing was installed; retry the download.`
    )
  const cache = dirname(directory)
  mkdirSync(cache, { recursive: true, mode: 0o700 })
  const scratch = join(cache, `.download-${randomUUID()}`)
  mkdirSync(scratch, { mode: 0o700 })
  try {
    const file = join(scratch, name)
    writeFileSync(file, archive, { mode: 0o600 })
    const listing = execute("tar", ["-tzf", file], scratch, true)
    const members = listing.stdout.split(/\r?\n/u).filter(Boolean)
    if (
      listing.status !== 0 ||
      !members.length ||
      !members.every((member) => memberInside(member, top))
    )
      throw new CliError(
        `The azad-terraform ${version} archive is not a single ${top}/ directory. Nothing was installed.`
      )
    if (execute("tar", ["-xzf", file, "-C", scratch], scratch, true).status !== 0)
      throw new CliError(
        `Could not extract the azad-terraform ${version} archive. Check the free space in ${cache}, then retry.`
      )
    const extracted = join(scratch, top)
    if (
      !hasDrivers(extracted) ||
      !existsSync(join(extracted, "package.json")) ||
      !existsSync(join(extracted, "bun.lock"))
    )
      throw new CliError(
        `The azad-terraform ${version} archive has no drivers (scripts/cloudflare.ts, gcp.ts and bootstrap.ts) or no bun.lock. Nothing was installed.`
      )
    rmSync(directory, { recursive: true, force: true })
    renameSync(extracted, directory)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  options.note?.(`Installing the dependencies of azad-terraform ${version}…`)
  install(
    directory,
    `Installing the dependencies of azad-terraform ${version} in ${directory} failed. Fix the reported problem and rerun; the download is repeated.`
  )
  writeFileSync(
    join(directory, READY_MARKER),
    `${JSON.stringify({ version, sha256: expected })}\n`,
    { mode: 0o600 }
  )
  return directory
}
