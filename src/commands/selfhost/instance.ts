import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { CliError } from "../../error"

/** The instance `azad` uses without `--instance` or `--directory`. */
export const DEFAULT_INSTANCE = "default"

/**
 * Where instances live: `~/.azad/instances`, under the person's home folder
 * (`%USERPROFILE%\.azad\instances` on Windows). `~/.azad` is shared with
 * other Azad tools (the iOS simulator keeps `~/.azad/remote-ios`), so
 * instances get their own folder and a name can never collide with theirs.
 */
export function instancesDirectory(home = homedir()): string {
  return join(home, ".azad", "instances")
}

/**
 * A path as a person typed it, for the local file system: surrounding quotes
 * removed (Windows' "Copy as path" adds them) and a leading `~` expanded to
 * the home folder, which cmd.exe and PowerShell leave to the program.
 */
export function localPath(path: string, home = homedir()): string {
  const trimmed = path.trim()
  const unquoted = /^(["'])(.*)\1$/su.exec(trimmed)?.[2] ?? trimmed
  if (unquoted === "~") return home
  return /^~[\\/]/u.test(unquoted) ? join(home, unquoted.slice(2)) : unquoted
}

/** Validates an `--instance` name: a folder name, never a path. */
export function validateInstanceName(name: string): string | undefined {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/u.test(name)
    ? undefined
    : "Use an instance name of letters, digits, hyphens and underscores, such as staging."
}

/** The instance directory a run uses, and how to select it again. */
export type InstanceLocation = {
  directory: string
  /** The flags that select this instance on a later run; empty for the default instance. */
  flags: string[]
}

/**
 * Resolves the instance directory without creating it: `--directory PATH`
 * as given (relative to `cwd`), otherwise `--instance NAME` (default
 * `default`) under {@link instancesDirectory}.
 *
 * @throws CliError for both flags at once or an invalid name.
 */
export function instanceLocation(options: {
  instance?: string
  directory?: string
  cwd?: string
  home?: string
}): InstanceLocation {
  const home = options.home ?? homedir()
  const cwd = options.cwd ?? process.cwd()
  if (options.instance !== undefined && options.directory !== undefined)
    throw new CliError("Use --instance or --directory, not both.")
  if (options.directory !== undefined) {
    const directory = resolve(cwd, localPath(options.directory, home))
    return { directory, flags: ["--directory", directory] }
  }
  const name = options.instance ?? DEFAULT_INSTANCE
  const invalid = validateInstanceName(name)
  if (invalid) throw new CliError(invalid)
  return {
    directory: join(instancesDirectory(home), name),
    flags: options.instance === undefined ? [] : ["--instance", name],
  }
}

/** The command that resumes this instance, for messages. */
export function rerunCommand(
  location: Pick<InstanceLocation, "flags">,
  extra: string[] = []
): string {
  return ["azad", ...location.flags, ...extra]
    .map((word) =>
      /^[\w@%+=:,./\\-]+$/u.test(word)
        ? word
        : `"${word.replaceAll('"', '\\"')}"`
    )
    .join(" ")
}
