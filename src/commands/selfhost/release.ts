import { join } from "node:path"
import { CliError } from "../../error"
import { run as runTool, type Run } from "../../process"
import {
  describeRelease,
  localRelease,
  publicRelease,
  recordedRelease,
  RELEASE_LAYOUT,
  type InstallRelease,
  type ReleaseIdentity,
  type ReleaseSource,
} from "../../release/directory"
import { compareVersions, UPDATER_ENTRY } from "../../release/signed"
import {
  localInstallation,
  readInstallationStatus,
  RELEASE_SHA_KEY,
  RELEASE_VERSION_KEY,
} from "../update/installation"
import { runUpdater, type RunUpdater } from "../update/run"

/** The release an instance's saved settings record, if a deploy has started. */
export function recordedIdentity(
  values: Record<string, string>
): ReleaseIdentity | undefined {
  const version = values[RELEASE_VERSION_KEY]
  const sourceSha = values[RELEASE_SHA_KEY]
  return version && sourceSha ? { version, sourceSha } : undefined
}

/** Records `release` as the one this instance deploys. */
export function recordRelease(
  values: Record<string, string>,
  release: InstallRelease
): void {
  values[RELEASE_VERSION_KEY] = release.version
  values[RELEASE_SHA_KEY] = release.sourceSha
}

/**
 * What a run asks for: an Azad app checkout to build a local release from
 * (`--source`, for development), or a published version (`--version`).
 * Neither: the latest release for a new install, the one it runs for an
 * existing one.
 */
export type ReleaseRequest = { source?: string; version?: string }

/**
 * Prepares the release a deploy of an instance uses, from its saved
 * settings. Deploys call it only after their tools are checked.
 */
export type ReleaseResolver = (
  values: Record<string, string>
) => Promise<InstallRelease>

export type ReleaseDependencies = ReleaseSource & {
  /** Runs git and the local build (`--source`). */
  execute?: Run
  /** Runs the updater that reads the installation's receipt. */
  run?: RunUpdater
}

/**
 * The release the installation in `directory` runs, from its receipt, read
 * with `release`'s own updater the way `azad update --status` reads it.
 * Undefined before the deploy created the installation's store, for a
 * receipt without a version, or when the receipt cannot be read (noted).
 */
export async function installedRelease(
  directory: string,
  release: InstallRelease,
  dependencies: ReleaseDependencies = {}
): Promise<ReleaseIdentity | undefined> {
  let installation: ReturnType<typeof localInstallation>
  try {
    installation = localInstallation(directory)
  } catch {
    return undefined
  }
  try {
    const status = await readInstallationStatus(
      installation,
      join(release.directory, RELEASE_LAYOUT.payload, UPDATER_ENTRY),
      dependencies.run ?? runUpdater
    )
    const receipt = status.release
    return receipt?.version
      ? { version: receipt.version, sourceSha: receipt.sourceSha }
      : undefined
  } catch (error) {
    dependencies.note?.(
      `${error instanceof CliError ? `${error.message} ` : ""}Using the release this instance recorded; the installer still refuses to deploy over a newer one.`
    )
    return undefined
  }
}

/** The newer of two releases by version; `a` when they are equal. */
function newer(
  a: ReleaseIdentity,
  b: ReleaseIdentity | undefined
): ReleaseIdentity {
  return b && compareVersions(b.version, a.version) > 0 ? b : a
}

function olderError(current: ReleaseIdentity, what: string): CliError {
  return new CliError(
    `This installation runs Azad ${current.version}, which is newer than ${what}. An older release is never deployed over a newer one; choose ${current.version} or later.`
  )
}

/** @throws CliError when `current` is newer than `release` and another commit. */
function assertNotOlder(release: InstallRelease, current: ReleaseIdentity) {
  if (
    current.sourceSha !== release.sourceSha &&
    compareVersions(current.version, release.version) > 0
  )
    throw olderError(
      current,
      release.signed
        ? `Azad ${release.version}`
        : `${describeRelease(release)} (version ${release.version})`
    )
}

/**
 * The release a deploy of the instance in `directory` uses:
 *
 * - `--source`: a local build of that checkout, refused when the
 *   installation runs a newer release.
 * - A new install: `--version`, else the latest published release.
 * - An existing install: the release it runs now, which is the newer of the
 *   one its settings record and the one its receipt names (a console update
 *   or `azad update` moves it past the recorded one). `--version` may move it
 *   to a newer release, never to an older one.
 *
 * Each is verified and kept in `~/.azad/cache/releases`, and downloaded only
 * when the cache does not hold it.
 */
export function releaseResolver(
  directory: string,
  request: ReleaseRequest,
  dependencies: ReleaseDependencies = {}
): ReleaseResolver {
  const execute = dependencies.execute ?? runTool
  return async (values) => {
    const recorded = recordedIdentity(values)
    if (request.source) {
      const release = localRelease(request.source, {
        execute,
        home: dependencies.home,
        note: dependencies.note,
      })
      if (recorded)
        assertNotOlder(
          release,
          newer(
            recorded,
            await installedRelease(directory, release, dependencies)
          )
        )
      return release
    }
    if (!recorded)
      return await publicRelease(request.version ?? "latest", dependencies)
    const current = await recordedRelease(recorded, dependencies)
    const runs = newer(
      recorded,
      await installedRelease(directory, current, dependencies)
    )
    if (request.version !== undefined && request.version !== runs.version) {
      if (
        request.version !== "latest" &&
        compareVersions(request.version, runs.version) < 0
      )
        throw olderError(runs, `Azad ${request.version}`)
      const chosen = await publicRelease(request.version, dependencies)
      if (chosen.version !== runs.version) {
        assertNotOlder(chosen, runs)
        return chosen
      }
    }
    if (runs === recorded) return current
    dependencies.note?.(
      `This installation runs Azad ${runs.version}, newer than the ${recorded.version} its settings record; deploying ${runs.version}.`
    )
    return await publicRelease(runs.version, dependencies)
  }
}
