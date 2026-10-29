import {
  spawn,
  spawnSync,
  type ChildProcess,
  type SpawnOptions,
  type SpawnSyncOptionsWithStringEncoding,
} from "node:child_process"
import { statSync } from "node:fs"
import { win32 } from "node:path"
import { commandEnvironment } from "./command-environment"

/** `stderr` is present only for captured runs; callers never print it unfiltered. */
export type ProcessResult = {
  status: number | null
  stdout: string
  stderr?: string
}

/** Runs an external tool; `capture` pipes its output instead of handing it the terminal. */
export type Run = (
  command: string,
  args: string[],
  cwd: string,
  capture?: boolean
) => ProcessResult

/** How a tool is started on this platform. */
export type ToolCommand = {
  command: string
  args: string[]
  /** Set when `args` are already quoted for cmd.exe. */
  windowsVerbatimArguments?: boolean
}

type Environment = Record<string, string | undefined>

/** An environment variable by name; Windows names are case-insensitive. */
function variable(env: Environment, name: string): string | undefined {
  const key = Object.keys(env).find(
    (candidate) => candidate.toUpperCase() === name.toUpperCase()
  )
  return key === undefined ? undefined : env[key]
}

const isFile = (path: string) => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** The file Windows starts for `command`: PATH searched with PATHEXT, as cmd.exe does. */
function findWindowsCommand(
  command: string,
  env: Environment,
  exists: (path: string) => boolean
): string | undefined {
  // Windows file names are case-insensitive; lower case reads as installed.
  const extensions = (variable(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
    .toLowerCase()
    .split(";")
    .filter(Boolean)
  const named = extensions.some((extension) =>
    command.toLowerCase().endsWith(extension)
  )
  const candidates = (base: string) =>
    named ? [base] : extensions.map((extension) => `${base}${extension}`)
  const directories = /[\\/]/u.test(command)
    ? [""]
    : (variable(env, "PATH") ?? "").split(";").filter(Boolean)
  for (const directory of directories)
    for (const candidate of candidates(win32.join(directory, command)))
      if (exists(candidate)) return candidate
  return undefined
}

// cmd.exe metacharacters, escaped with ^ (https://qntm.org/cmd, as cross-spawn
// does): the quotes are escaped too, so cmd never enters quoted mode and every
// other escape applies.
const cmdMetaCharacters = /([()\][%!^"`<>&|;, *?])/gu

function cmdArgument(value: string, twice: boolean): string {
  let quoted = value
    .replace(/(?=(\\+?)?)\1"/gu, '$1$1\\"')
    .replace(/(?=(\\+?)?)\1$/u, "$1$1")
  quoted = `"${quoted}"`.replace(cmdMetaCharacters, "^$1")
  return twice ? quoted.replace(cmdMetaCharacters, "^$1") : quoted
}

/**
 * How to start `command` with `args`. Outside Windows it is unchanged. On
 * Windows a `.exe` or `.com` found on PATH (with PATHEXT) starts directly; a
 * `.cmd` or `.bat` shim (npx, npm and gcloud install as such) runs through
 * `cmd.exe /d /s /c` with every argument escaped for cmd, since Windows cannot
 * start a batch file directly and Node refuses to. A shim under
 * `node_modules/.bin` passes its arguments through cmd a second time, so they
 * are escaped twice. A command that is not found is returned unchanged, so
 * starting it fails with ENOENT as before.
 */
export function toolCommand(
  command: string,
  args: string[],
  options: {
    platform?: NodeJS.Platform
    env?: Environment
    exists?: (path: string) => boolean
  } = {}
): ToolCommand {
  if ((options.platform ?? process.platform) !== "win32")
    return { command, args }
  const env = options.env ?? process.env
  const file = findWindowsCommand(command, env, options.exists ?? isFile)
  if (!file) return { command, args }
  if (/\.(?:com|exe)$/iu.test(file)) return { command: file, args }
  const twice = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/iu.test(file)
  // The resolved path, quoted, so cmd does not search the working directory
  // first for a file of the same name.
  const line = [
    `"${win32.normalize(file)}"`,
    ...args.map((arg) => cmdArgument(arg, twice)),
  ].join(" ")
  return {
    command: variable(env, "ComSpec") ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    windowsVerbatimArguments: true,
  }
}

/** `spawnSync` for an external tool, resolved as {@link toolCommand} describes. */
export function spawnToolSync(
  command: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding
) {
  const tool = toolCommand(command, args, { env: options.env })
  return spawnSync(tool.command, tool.args, {
    ...options,
    windowsVerbatimArguments: tool.windowsVerbatimArguments,
  })
}

/** `spawn` for an external tool, resolved as {@link toolCommand} describes. */
export function spawnTool(
  command: string,
  args: string[],
  options: SpawnOptions
): ChildProcess {
  const tool = toolCommand(command, args, { env: options.env })
  return spawn(tool.command, tool.args, {
    ...options,
    windowsVerbatimArguments: tool.windowsVerbatimArguments,
  })
}

/**
 * Runs a tool with only operating-system plumbing in its environment
 * ({@link commandEnvironment}); with `capture` its output is returned instead
 * of shown.
 */
export const run: Run = (command, args, cwd, capture = false) => {
  const result = spawnToolSync(command, args, {
    cwd,
    env: commandEnvironment(),
    encoding: "utf8",
    stdio: capture
      ? ["ignore", "pipe", "pipe"]
      : ["inherit", "inherit", "inherit"],
  })
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  }
}
