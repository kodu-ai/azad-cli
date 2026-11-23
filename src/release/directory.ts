import { randomUUID } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { z } from "zod"
import { CliError } from "../error"
import type { Fetcher } from "../http"
import type { Run } from "../process"
import {
  artifactOf,
  releaseClient,
  ReleaseNotFoundError,
  semverSchema,
  sha256,
  unpackArchive,
  verifyArtifact,
  verifyManifest,
  type ArtifactName,
  type ReleaseKey,
  type ReleaseManifest,
  type VerifiedRelease,
} from "./signed"

/**
 * The release directory every install deploys, as azad-terraform's drivers
 * take it (`--release DIR`) and the app's `scripts/self-host/release-directory.ts`
 * reads it:
 *
 * ```text
 * <release>/
 *   release.json                 {@link releaseInfoSchema}
 *   manifest.json                the signed manifest, verbatim (signed releases)
 *   agent-connect-manifest.json  its Agent Connect manifest, verbatim (signed releases)
 *   payload/                     the unpacked updater artifact
 *   web/                         the unpacked web artifact
 * ```
 *
 * A downloaded release also keeps its two archives beside them: the cache is
 * verified against them, never against the unpacked tree, which the
 * installer adds to (it installs Wrangler under `payload/runtime`).
 */
export const RELEASE_LAYOUT = {
  info: "release.json",
  manifest: "manifest.json",
  agentConnectManifest: "agent-connect-manifest.json",
  payload: "payload",
  web: "web",
} as const

/**
 * The first Azad release whose payload carries the install entrypoints the
 * azad-terraform drivers run ({@link INSTALLER_ENTRIES}). Older releases are
 * refused, with this version named.
 */
export const FIRST_INSTALLER_RELEASE = "4.496.29"

/** The installer entrypoints a release payload must carry, by payload path. */
export const INSTALLER_ENTRIES = [
  "installer/settings.js",
  "installer/cloudflare-install.js",
  "installer/celld-install.js",
  "installer/install-store.js",
] as const

const sourceShaSchema = z.string().regex(/^[a-f0-9]{40}$/u)

/** `release.json`: what the release is, and whether this CLI verified its signature. */
export const releaseInfoSchema = z.strictObject({
  format: z.literal(1),
  version: semverSchema,
  sourceSha: sourceShaSchema,
  signed: z.boolean(),
  agentConnect: z.strictObject({ version: z.string().min(1) }).nullable(),
})
export type ReleaseInfo = z.infer<typeof releaseInfoSchema>

const payloadIndexSchema = z.looseObject({
  sourceSha: sourceShaSchema,
  files: z.array(z.looseObject({ path: z.string() })),
})

/** One release directory, ready for the drivers. */
export type InstallRelease = {
  /** The directory the drivers get as `--release`. */
  directory: string
  version: string
  sourceSha: string
  /** False for a local build (`--source`). */
  signed: boolean
}

/** What an installation runs or records: a release version and its commit. */
export type ReleaseIdentity = { version: string; sourceSha: string }

/** Where releases are cached: `~/.azad/cache/releases`. */
export function releasesDirectory(home = homedir()): string {
  return join(home, ".azad", "cache", "releases")
}

/** The cache directory of a public release, `<cache>/<version>`. */
export function publicReleaseDirectory(version: string, home = homedir()) {
  return join(releasesDirectory(home), version)
}

/** The cache directory of a local build, `<cache>/local-<sourceSha>`. */
export function localReleaseDirectory(sourceSha: string, home = homedir()) {
  return join(releasesDirectory(home), `local-${sourceSha}`)
}

/** How a release reads in messages. */
export function describeRelease(release: InstallRelease): string {
  return release.signed
    ? `Azad ${release.version} (${release.sourceSha.slice(0, 12)})`
    : `a local build of ${release.sourceSha.slice(0, 12)}`
}

function installerMissing(version: string): CliError {
  return new CliError(
    `Azad ${version} cannot be installed by this azad: its release has no installer (installer/cloudflare-install.js). Installs start with Azad ${FIRST_INSTALLER_RELEASE}; choose that release or a newer one.`
  )
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return undefined
  }
}

const isDirectory = (path: string) => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Checks an unpacked payload: its `payload.json` is built from `sourceSha`
 * and lists the installer, and every installer entrypoint is there.
 *
 * @throws CliError naming what is missing or inconsistent.
 */
function checkPayload(payload: string, version: string, sourceSha: string) {
  const index = payloadIndexSchema.safeParse(
    readJson(join(payload, "payload.json"))
  )
  if (!index.success)
    throw new CliError(`${payload} has no payload.json this azad can read.`)
  if (index.data.sourceSha !== sourceSha)
    throw new CliError(
      `${payload} was not built from the commit its release names.`
    )
  if (!index.data.files.some((file) => file.path === INSTALLER_ENTRIES[1]))
    throw installerMissing(version)
  for (const entry of INSTALLER_ENTRIES)
    if (!existsSync(join(payload, entry)))
      throw new CliError(`${join(payload, entry)} is missing.`)
}

/**
 * Reads and checks a release directory: `release.json`, a payload built from
 * the same commit that carries the installer, and a web build.
 *
 * @throws CliError naming what is missing or inconsistent.
 */
export function readRelease(directory: string): InstallRelease {
  const root = resolve(directory)
  const info = releaseInfoSchema.safeParse(
    readJson(join(root, RELEASE_LAYOUT.info))
  )
  if (!info.success)
    throw new CliError(
      `${root} is not an Azad release directory: it has no ${RELEASE_LAYOUT.info} this azad can read.`
    )
  const { version, sourceSha, signed } = info.data
  checkPayload(join(root, RELEASE_LAYOUT.payload), version, sourceSha)
  if (!isDirectory(join(root, RELEASE_LAYOUT.web)))
    throw new CliError(`${join(root, RELEASE_LAYOUT.web)} is missing.`)
  return { directory: root, version, sourceSha, signed }
}

/** {@link readRelease}, or undefined when the directory is not a usable release. */
export function tryReadRelease(directory: string): InstallRelease | undefined {
  try {
    return readRelease(directory)
  } catch {
    return undefined
  }
}

/** The archive file names a downloaded release keeps, by artifact. */
const ARCHIVES: readonly { name: ArtifactName; into: string }[] = [
  { name: "updater", into: RELEASE_LAYOUT.payload },
  { name: "web", into: RELEASE_LAYOUT.web },
]

/** `release.json` of a verified release. */
function infoOf(manifest: ReleaseManifest): ReleaseInfo {
  const agentConnect = manifest.compatible?.agentConnect?.version
  return {
    format: 1,
    version: manifest.version,
    sourceSha: manifest.sourceSha,
    signed: true,
    agentConnect:
      agentConnect && manifest.artifacts.agentConnect
        ? { version: agentConnect }
        : null,
  }
}

/**
 * A cached public release, when everything in it still verifies: its
 * manifest's signature (and digest, when `expectedSha256` is known), both
 * archives and the Agent Connect manifest against it, and its
 * `release.json`. A payload or web tree that is missing or incomplete is
 * unpacked again, fresh, from the verified archive. Undefined when the
 * release must be downloaded again.
 */
function cachedRelease(
  directory: string,
  version: string,
  trust: readonly ReleaseKey[] | undefined,
  expectedSha256?: string
): InstallRelease | undefined {
  let manifest: ReleaseManifest
  try {
    const bytes = new Uint8Array(
      readFileSync(join(directory, RELEASE_LAYOUT.manifest))
    )
    if (expectedSha256 && sha256(bytes) !== expectedSha256) return undefined
    manifest = verifyManifest(bytes, trust)
    if (manifest.version !== version) return undefined
    for (const { name } of ARCHIVES)
      verifyArtifact(
        manifest,
        name,
        new Uint8Array(
          readFileSync(join(directory, artifactOf(manifest, name).path))
        )
      )
    if (manifest.artifacts.agentConnect)
      verifyArtifact(
        manifest,
        "agentConnect",
        new Uint8Array(
          readFileSync(join(directory, RELEASE_LAYOUT.agentConnectManifest))
        )
      )
    const info = releaseInfoSchema.safeParse(
      readJson(join(directory, RELEASE_LAYOUT.info))
    )
    if (
      !info.success ||
      JSON.stringify(info.data) !== JSON.stringify(infoOf(manifest))
    )
      return undefined
  } catch {
    return undefined
  }
  const ready = tryReadRelease(directory)
  if (ready) return ready
  try {
    for (const { name, into } of ARCHIVES)
      unpackArchive(
        join(directory, artifactOf(manifest, name).path),
        join(directory, into)
      )
  } catch {
    return undefined
  }
  return tryReadRelease(directory)
}

/** Dependencies of a release download; tests replace the network and keys. */
export type ReleaseSource = {
  origin?: string
  fetcher?: Fetcher
  /** Replaces the pinned release keys (tests). */
  trust?: readonly ReleaseKey[]
  /** The home folder whose `~/.azad/cache/releases` is used. */
  home?: string
  note?: (message: string) => void
}

/**
 * Downloads a verified release into a fresh private directory beside the
 * cache, unpacks it, writes its `release.json` last and moves it into place.
 * The updater comes first: a release without the installer is refused before
 * its web build is downloaded.
 */
async function downloadRelease(
  verified: VerifiedRelease,
  directory: string,
  source: ReleaseSource
): Promise<InstallRelease> {
  const { manifest } = verified
  const client = releaseClient(source)
  artifactOf(manifest, "web")
  const cache = releasesDirectory(source.home)
  mkdirSync(cache, { recursive: true, mode: 0o700 })
  const scratch = join(cache, `.download-${randomUUID()}`)
  mkdirSync(scratch, { mode: 0o700 })
  try {
    source.note?.(
      `Downloading Azad ${manifest.version} (${manifest.sourceSha.slice(0, 12)}), verified with its signed manifest…`
    )
    writeFileSync(join(scratch, RELEASE_LAYOUT.manifest), verified.bytes, {
      mode: 0o600,
    })
    for (const { name, into } of ARCHIVES) {
      const archive = join(scratch, artifactOf(manifest, name).path)
      writeFileSync(archive, await client.artifact(manifest, name), {
        mode: 0o600,
      })
      unpackArchive(archive, join(scratch, into))
      if (name === "updater")
        checkPayload(
          join(scratch, RELEASE_LAYOUT.payload),
          manifest.version,
          manifest.sourceSha
        )
    }
    if (manifest.artifacts.agentConnect)
      writeFileSync(
        join(scratch, RELEASE_LAYOUT.agentConnectManifest),
        await client.artifact(manifest, "agentConnect"),
        { mode: 0o600 }
      )
    writeFileSync(
      join(scratch, RELEASE_LAYOUT.info),
      `${JSON.stringify(infoOf(manifest), null, 2)}\n`,
      { mode: 0o600 }
    )
    readRelease(scratch)
    rmSync(directory, { recursive: true, force: true })
    renameSync(scratch, directory)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  return readRelease(directory)
}

/**
 * A verified public release in `~/.azad/cache/releases/<version>`: `latest`
 * (the release azad.pro runs now) or an exact `x.y.z`. A cached exact version
 * is verified offline against its own signed manifest and reused without a
 * network call; `latest` reads the pointer first and reuses the cache when
 * the pointer names the cached manifest. Anything that does not verify is
 * downloaded again.
 *
 * @throws CliError When the release cannot be reached, does not verify, has
 *   no web build, or predates the installer ({@link FIRST_INSTALLER_RELEASE}).
 */
export async function publicRelease(
  version: string,
  source: ReleaseSource = {}
): Promise<InstallRelease> {
  const client = releaseClient(source)
  const pointer = version === "latest" ? await client.latest() : undefined
  if (!pointer && !semverSchema.safeParse(version).success)
    throw new CliError("Use --version latest or an exact x.y.z.")
  const exact = pointer?.version ?? version
  const directory = publicReleaseDirectory(exact, source.home)
  const cached = cachedRelease(
    directory,
    exact,
    source.trust,
    pointer?.manifestSha256
  )
  if (cached) return cached
  const verified = await client.manifest(exact, pointer?.manifestSha256)
  if (pointer && verified.manifest.sourceSha !== pointer.sourceSha)
    throw new CliError("The latest release pointer names another source.")
  return await downloadRelease(verified, directory, source)
}

/**
 * Builds an unsigned release from an Azad app checkout, for development:
 * `bun --no-env-file <checkout>/scripts/self-host/local-release.ts --out DIR`
 * into a new empty directory, kept as `~/.azad/cache/releases/local-<sourceSha>`.
 * The checkout's dependencies are installed first when it has none. When Git
 * reads a clean checkout whose commit is already built, that build is reused.
 *
 * @throws CliError When `source` is not an app checkout or the build fails.
 */
export function localRelease(
  checkout: string,
  options: { execute: Run; home?: string; note?: (message: string) => void }
): InstallRelease {
  const source = resolve(checkout)
  const builder = join(source, "scripts", "self-host", "local-release.ts")
  if (!existsSync(builder))
    throw new CliError(
      `--source must be an Azad app checkout with scripts/self-host/local-release.ts; ${source} has none.`
    )
  const { execute } = options
  const git = (args: string[]) => {
    try {
      return execute("git", ["-C", source, ...args], source, true)
    } catch {
      return { status: 1, stdout: "" }
    }
  }
  const head = git(["rev-parse", "HEAD"])
  const sha = head.stdout.trim()
  const clean = () => {
    const status = git(["status", "--porcelain"])
    return status.status === 0 && status.stdout.trim() === ""
  }
  if (head.status === 0 && sourceShaSchema.safeParse(sha).success && clean()) {
    const built = tryReadRelease(localReleaseDirectory(sha, options.home))
    if (built && !built.signed && built.sourceSha === sha) {
      options.note?.(`Using the local build of ${sha.slice(0, 12)}.`)
      return built
    }
  }
  if (!existsSync(join(source, "node_modules")))
    if (
      execute("bun", ["--no-env-file", "install", "--frozen-lockfile"], source)
        .status !== 0
    )
      throw new CliError(
        `Installing the dependencies of ${source} failed. Fix the reported error, then retry.`
      )
  const cache = releasesDirectory(options.home)
  mkdirSync(cache, { recursive: true, mode: 0o700 })
  const scratch = join(cache, `.build-${randomUUID()}`)
  mkdirSync(scratch, { mode: 0o700 })
  try {
    options.note?.(`Building a local release from ${source}…`)
    if (
      execute("bun", ["--no-env-file", builder, "--out", scratch], source)
        .status !== 0
    )
      throw new CliError(
        `Building a local release from ${source} failed; the reason is above. Nothing was deployed.`
      )
    const built = readRelease(scratch)
    if (built.signed)
      throw new CliError(
        `${builder} wrote a release marked signed; a local build never is.`
      )
    const directory = localReleaseDirectory(built.sourceSha, options.home)
    rmSync(directory, { recursive: true, force: true })
    renameSync(scratch, directory)
    return readRelease(directory)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/**
 * The release an installation recorded, from the cache when it is there (a
 * local build as `local-<sourceSha>`, a public release verified offline),
 * otherwise downloaded.
 *
 * @throws CliError When it is a local build that is no longer cached, or the
 *   published release of that version is another commit.
 */
export async function recordedRelease(
  recorded: ReleaseIdentity,
  source: ReleaseSource = {}
): Promise<InstallRelease> {
  const local = tryReadRelease(
    localReleaseDirectory(recorded.sourceSha, source.home)
  )
  if (local && local.version === recorded.version) return local
  const fromLocalBuild = `This installation records Azad ${recorded.version} built from ${recorded.sourceSha.slice(0, 12)}: a local build that is no longer cached. Rerun with --source and a checkout of that commit.`
  let release: InstallRelease
  try {
    release = await publicRelease(recorded.version, source)
  } catch (error) {
    if (error instanceof ReleaseNotFoundError) throw new CliError(fromLocalBuild)
    throw error
  }
  if (release.sourceSha !== recorded.sourceSha) throw new CliError(fromLocalBuild)
  return release
}
