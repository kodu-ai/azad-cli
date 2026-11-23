import { spawnSync } from "node:child_process"
import { createHash, createPublicKey, verify } from "node:crypto"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { z } from "zod"
import { CliError } from "../error"
import type { Fetcher } from "../http"

/**
 * The keys this CLI trusts for Azad release manifests, pinned here and never
 * read from the origin it downloads from: the Agent Connect release key, as
 * the app's `scripts/updater/trust.ts` pins it. A rotation adds the new key
 * in a CLI release before releases are signed with it.
 */
export const RELEASE_TRUST: readonly ReleaseKey[] = [
  {
    id: "branch-las-vegas",
    publicKey: "FIbhE6k8lpf/5POFajznY5EPniXGNYgKpwxiVWXb8o8=",
  },
]

/** A trusted Ed25519 release key: raw 32 bytes in base64. */
export type ReleaseKey = { id: string; publicKey: string }

/** Where production publishes public releases. */
export const RELEASE_ORIGIN = "https://api.azad.pro"

/** The updater entry point inside an unpacked updater payload. */
export const UPDATER_ENTRY = join("updater", "updater.js")

export const semverSchema = z.string().regex(/^\d+\.\d+\.\d+$/u)

/** Orders two `x.y.z` versions: negative when `a` is older, 0 when equal. */
export function compareVersions(a: string, b: string): number {
  const [left, right] = [a, b].map((version) => version.split(".").map(Number))
  for (let index = 0; index < 3; index++) {
    const difference = (left?.[index] ?? 0) - (right?.[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/**
 * The release origin: `value`, then AZAD_RELEASE_ORIGIN, then api.azad.pro.
 * Plain HTTP is accepted only on this machine, for tests. The trusted keys
 * never change with it.
 */
export function releaseOrigin(
  value: string | undefined,
  env: Record<string, string | undefined> = process.env
): string {
  const origin = value ?? env.AZAD_RELEASE_ORIGIN ?? RELEASE_ORIGIN
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    throw new CliError("--origin must be an https:// origin.")
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  if (
    url.origin !== origin.replace(/\/$/u, "") ||
    !(url.protocol === "https:" || (url.protocol === "http:" && loopback))
  )
    throw new CliError("--origin must be an https:// origin.")
  return url.origin
}

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u)
const sourceShaSchema = z.string().regex(/^[a-f0-9]{40}$/u)

/** `latest.json`: the release azad.pro runs now. */
const pointerSchema = z.strictObject({
  format: z.literal(1),
  version: semverSchema,
  sourceSha: sourceShaSchema,
  manifestSha256: sha256Schema,
})

const fileSchema = z.object({
  path: z.string().regex(/^[A-Za-z0-9._-]+$/u),
  sha256: sha256Schema,
  size: z.number().int().nonnegative(),
})
export type ReleaseFile = z.infer<typeof fileSchema>

/**
 * The fields of a signed release manifest this CLI reads. The signature
 * covers the whole manifest as published; everything else in it is the
 * updater's and installer's business, so unknown fields are kept, not
 * refused. `web` is null until a release's web build is published.
 */
const manifestSchema = z.looseObject({
  format: z.literal(1),
  type: z.literal("azad-release"),
  version: semverSchema,
  sourceSha: sourceShaSchema,
  publishedAt: z.string(),
  artifacts: z.looseObject({
    updater: fileSchema,
    web: fileSchema.nullish(),
    agentConnect: fileSchema.nullish(),
  }),
  compatible: z
    .looseObject({
      agentConnect: z.looseObject({ version: z.string().min(1) }).optional(),
    })
    .optional(),
  keyId: z.string().min(1),
  signature: z.string().min(1),
})
export type ReleaseManifest = z.infer<typeof manifestSchema>

/** The downloadable artifacts of a release this CLI uses. */
export type ArtifactName = "updater" | "web" | "agentConnect"

/** Any value JSON can produce. */
type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

function isJsonObject(
  value: JsonValue | undefined
): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * The canonical JSON a release signature covers: object keys sorted, no
 * whitespace. It must stay byte-identical to the app's `canonical`
 * (hosts/agent-connect/release/release.ts), which signs.
 */
export function canonical(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (isJsonObject(value))
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`
  return JSON.stringify(value)
}

export const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex")

const jsonValueSchema: z.ZodType<JsonValue> = z.json()

/**
 * Parses and verifies signed manifest bytes: Ed25519 over the canonical JSON
 * of the manifest without `signature`, by a pinned key.
 *
 * @throws CliError When the bytes are not a release manifest, the key is not
 *   trusted or the signature is invalid.
 */
export function verifyManifest(
  bytes: Uint8Array,
  trust: readonly ReleaseKey[] = RELEASE_TRUST
): ReleaseManifest {
  let raw: JsonValue
  try {
    raw = jsonValueSchema.parse(JSON.parse(new TextDecoder().decode(bytes)))
  } catch {
    throw new CliError("The release manifest is not JSON.")
  }
  const parsed = manifestSchema.safeParse(raw)
  if (!parsed.success || !isJsonObject(raw))
    throw new CliError("The release manifest is not an Azad release.")
  const manifest = parsed.data
  const key = trust.find((candidate) => candidate.id === manifest.keyId)
  if (!key)
    throw new CliError(
      `The release manifest is signed with key ${manifest.keyId}, which this azad does not trust. Update azad.`
    )
  const publicKey = Uint8Array.fromBase64(key.publicKey)
  if (publicKey.byteLength !== 32)
    throw new CliError("A trusted release key must be raw Ed25519.")
  const { signature: _signature, ...unsigned } = raw
  const valid = verify(
    null,
    new TextEncoder().encode(canonical(unsigned)),
    createPublicKey({
      key: {
        kty: "OKP",
        crv: "Ed25519",
        x: publicKey.toBase64({ alphabet: "base64url", omitPadding: true }),
      },
      format: "jwk",
    }),
    Uint8Array.fromBase64(manifest.signature)
  )
  if (!valid) throw new CliError("The release manifest signature is invalid.")
  return manifest
}

/**
 * The manifest's entry for `name`.
 *
 * @throws CliError When the release does not publish it.
 */
export function artifactOf(
  manifest: ReleaseManifest,
  name: ArtifactName
): ReleaseFile {
  const file = manifest.artifacts[name]
  if (!file)
    throw new CliError(
      `Azad ${manifest.version} has no published ${name === "web" ? "web build" : name === "agentConnect" ? "Agent Connect manifest" : name} yet. Choose another release.`
    )
  return file
}

/**
 * Checks `bytes` against the size and SHA-256 the signed manifest names for
 * the artifact `name`.
 *
 * @throws CliError When they differ.
 */
export function verifyArtifact(
  manifest: ReleaseManifest,
  name: ArtifactName,
  bytes: Uint8Array
): void {
  const file = artifactOf(manifest, name)
  if (bytes.byteLength !== file.size || sha256(bytes) !== file.sha256)
    throw new CliError(
      `The ${name === "web" ? "web build" : name} of Azad ${manifest.version} does not match its signed manifest.`
    )
}

/** A verified release: its manifest, the manifest's exact bytes and their digest. */
export type VerifiedRelease = {
  manifest: ReleaseManifest
  bytes: Uint8Array
  manifestSha256: string
}

/** A version the release routes do not publish (HTTP 404). */
export class ReleaseNotFoundError extends CliError {
  name = "ReleaseNotFoundError"
}

/** Reads the public release routes of `origin`, verifying everything. */
export function releaseClient(options: {
  origin?: string
  fetcher?: Fetcher
  trust?: readonly ReleaseKey[]
}) {
  const origin = options.origin ?? RELEASE_ORIGIN
  const fetcher = options.fetcher ?? fetch
  const get = async (path: string, timeoutMs = 60_000) => {
    const url = new URL(`/api/v3/releases/${path}`, origin).href
    let response: Response
    try {
      response = await fetcher(url, {
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch {
      throw new CliError(`Could not reach ${url}. Check the network and retry.`)
    }
    if (response.status === 404)
      throw new ReleaseNotFoundError(`${url} does not exist. Check the version.`)
    if (!response.ok)
      throw new CliError(`${url} answered HTTP ${response.status}. Retry later.`)
    try {
      return new Uint8Array(await response.arrayBuffer())
    } catch {
      throw new CliError(`Could not download ${url}. Check the network and retry.`)
    }
  }
  /**
   * The signed manifest of the exact `version`, checked against
   * `expectedSha256` when given (the digest the latest pointer names).
   */
  const manifestOf = async (
    version: string,
    expectedSha256?: string
  ): Promise<VerifiedRelease> => {
    const bytes = await get(`${version}/manifest.json`)
    const digest = sha256(bytes)
    if (expectedSha256 && digest !== expectedSha256)
      throw new CliError(
        `The manifest of Azad ${version} differs from the digest the latest pointer names.`
      )
    const manifest = verifyManifest(bytes, options.trust)
    if (manifest.version !== version)
      throw new CliError(
        `The manifest of Azad ${version} names another version.`
      )
    return { manifest, bytes, manifestSha256: digest }
  }
  /**
   * The latest pointer: the version azad.pro runs now and its manifest's
   * digest. Only the manifest it names is signed; `release` checks it.
   */
  const latest = async (): Promise<z.infer<typeof pointerSchema>> => {
    try {
      return pointerSchema.parse(
        JSON.parse(new TextDecoder().decode(await get("latest.json")))
      )
    } catch (error) {
      if (error instanceof CliError) throw error
      throw new CliError("The latest release pointer is not valid.")
    }
  }
  /** `latest` (the release azad.pro runs) or an exact `x.y.z`. */
  const release = async (version: string): Promise<VerifiedRelease> => {
    if (version !== "latest") {
      if (!semverSchema.safeParse(version).success)
        throw new CliError("Use --version latest or an exact x.y.z.")
      return await manifestOf(version)
    }
    const pointer = await latest()
    const resolved = await manifestOf(pointer.version, pointer.manifestSha256)
    if (resolved.manifest.sourceSha !== pointer.sourceSha)
      throw new CliError("The latest release pointer names another source.")
    return resolved
  }
  /**
   * Downloads the artifact `name` of a verified release and checks its size
   * and digest against the signed manifest.
   */
  const artifact = async (
    manifest: ReleaseManifest,
    name: ArtifactName
  ): Promise<Uint8Array> => {
    const file = artifactOf(manifest, name)
    const bytes = await get(`${manifest.version}/${file.path}`, 600_000)
    verifyArtifact(manifest, name, bytes)
    return bytes
  }
  /**
   * Downloads the release's updater payload into the new private directory
   * `directory`, checks it against the signed manifest and unpacks it to
   * `<directory>/payload`. The archive is not kept.
   *
   * @returns The path of the payload's `updater/updater.js`.
   */
  const updater = async (manifest: ReleaseManifest, directory: string) => {
    const bytes = await artifact(manifest, "updater")
    rmSync(directory, { recursive: true, force: true })
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const archive = join(directory, manifest.artifacts.updater.path)
    writeFileSync(archive, bytes, { mode: 0o600 })
    try {
      unpackArchive(archive, join(directory, "payload"))
    } finally {
      rmSync(archive, { force: true })
    }
    const entry = join(directory, "payload", UPDATER_ENTRY)
    if (!existsSync(entry))
      throw new CliError(
        `${manifest.artifacts.updater.path} has no ${UPDATER_ENTRY}.`
      )
    return entry
  }
  return { latest, manifest: manifestOf, release, artifact, updater }
}

/**
 * Unpacks the gzipped tarball `archive` into the new private directory
 * `into` (replacing anything there): `tar -xzf --no-same-owner`, run beside
 * the archive with its bare name, since GNU tar reads a Windows drive path
 * such as C:\… as a remote host.
 *
 * @throws CliError When tar is missing or fails.
 */
export function unpackArchive(archive: string, into: string): void {
  rmSync(into, { recursive: true, force: true })
  mkdirSync(into, { recursive: true, mode: 0o700 })
  const result = spawnSync(
    "tar",
    ["-xzf", basename(archive), "-C", into, "--no-same-owner"],
    {
      cwd: dirname(archive),
      stdio: ["ignore", "ignore", "pipe"],
      encoding: "utf8",
    }
  )
  if (result.status !== 0)
    throw new CliError(
      `Unpacking ${basename(archive)} failed${result.error ? " (is tar installed?)" : ""}.`
    )
}
