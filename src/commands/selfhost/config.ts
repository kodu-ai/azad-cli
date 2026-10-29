import { CliError } from "../../error"
import { randomUUID } from "node:crypto"
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs"
import { dirname, join, resolve } from "node:path"
import { parse } from "dotenv"

/**
 * True when only the owner can read and write a file or directory. On Linux
 * and macOS that is the absence of group and other permission bits. Windows
 * has no such bits (Node reports 0o666 or 0o444 for every file); there a file
 * is protected by the access control list it inherits from its folder. The
 * default instance directory is under the person's profile
 * (`%USERPROFILE%\.azad`), whose list admits only that account,
 * Administrators and SYSTEM. azad does not change access lists.
 */
export function ownerOnly(
  stat: Pick<Stats, "mode">,
  platform: NodeJS.Platform = process.platform
): boolean {
  return platform === "win32" || (stat.mode & 0o077) === 0
}

/** Reads a protected file without chmod, writes, shell evaluation or displaying its contents. */
export function readPrivateText(path: string): string {
  let fd: number | undefined
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = fstatSync(fd)
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      !ownerOnly(stat) ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error("Not a private owned regular file")
    return readFileSync(fd, "utf8")
  } catch {
    throw new CliError(
      `Credentials must be a readable, private regular file owned by you${process.platform === "win32" ? "" : " (chmod 600)"}. No credential values were displayed.`
    )
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** Reads dotenv through the same protected, read-only file boundary. */
export function readPrivateEnv(path: string): Record<string, string> {
  return parse(readPrivateText(path))
}

/** Serializes values for the deployment helper's dotenv parser, never a shell. */
export function serializeEnv(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([key, value]) => {
      if (!/^[A-Z][A-Z0-9_]*$/u.test(key) || value.includes("\0")) {
        throw new CliError(
          "Configuration contains an unsupported key or NUL character."
        )
      }
      // dotenv's quoting rules are not JSON or shell escaping. Verify each candidate
      // with the same parser that the maintained deployment helper consumes.
      for (const quote of ["'", '"', "`", ""]) {
        const line = `${key}=${quote}${value}${quote}\n`
        const parsed = parse(line)
        if (Object.keys(parsed).length === 1 && parsed[key] === value)
          return line
      }
      throw new CliError(
        `${key} cannot be represented losslessly in dotenv. Use a value without mixed quote delimiters.`
      )
    })
    .join("")
}

/**
 * Replaces a private file atomically: the text goes to a new mode 0600 file
 * beside it, is flushed, then renamed over the original.
 */
export function writePrivateText(path: string, text: string): void {
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`)
  const fd = openSync(temporary, "wx", 0o600)
  try {
    try {
      writeFileSync(fd, text)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temporary, path)
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}

/** dotenv's own entry grammar, so a quoted multi-line value is one entry. */
const dotenvEntry =
  /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?$/gmu

/**
 * Sets `entries` in an existing private dotenv file and keeps every other line
 * as written (line endings become \n); an entry whose value is undefined is
 * removed. The result is
 * parsed before it replaces the file: every other setting must read back
 * unchanged and every entry as given, or nothing is written. Throws
 * CliError, without values, when the file is not a private owned
 * regular file or cannot be edited losslessly.
 */
export function upsertPrivateEnv(
  path: string,
  entries: Record<string, string | undefined>
): void {
  // dotenv reads \r\n and \r as \n; editing in that form keeps a file
  // written on Windows intact.
  const text = readPrivateText(path).replace(/\r\n?/gu, "\n")
  const before = parse(text)
  const keys = new Set(Object.keys(entries))
  const set: Record<string, string> = {}
  for (const [key, value] of Object.entries(entries))
    if (value !== undefined) set[key] = value
  let kept = ""
  let from = 0
  for (const entry of text.matchAll(dotenvEntry)) {
    if (!keys.has(entry[1])) continue
    kept += text.slice(from, entry.index)
    from = entry.index + entry[0].length
    if (text[from] === "\n") from += 1
  }
  kept += text.slice(from)
  if (kept && !kept.endsWith("\n")) kept += "\n"
  const next = `${kept}${serializeEnv(set)}`
  const after = parse(next)
  const unchanged = Object.entries(before).every(
    ([key, value]) => keys.has(key) || after[key] === value
  )
  const applied = Object.entries(entries).every(([key, value]) =>
    value === undefined ? !Object.hasOwn(after, key) : after[key] === value
  )
  const expected = new Set([
    ...Object.keys(before).filter((key) => !keys.has(key)),
    ...Object.keys(set),
  ])
  if (!unchanged || !applied || Object.keys(after).length !== expected.size)
    throw new CliError(
      "A private settings file could not be updated without changing other settings. It was left as it was."
    )
  writePrivateText(path, next)
}

function checkFile(path: string): void {
  if (!existsSync(path)) return
  const stat = lstatSync(path)
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    (process.getuid && stat.uid !== process.getuid())
  ) {
    throw new CliError(
      "Configuration must be a regular file owned by the current user."
    )
  }
  chmodSync(path, 0o600)
}

/** A private local instance directory. Only its own files are written or tightened. */
export class LocalConfig {
  readonly directory: string
  readonly envPath: string

  constructor(directory: string) {
    this.directory = resolve(directory)
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const stat = lstatSync(this.directory)
    if (
      !stat.isDirectory() ||
      (process.getuid && stat.uid !== process.getuid())
    ) {
      throw new CliError(
        "Choose an instance directory owned by the current user."
      )
    }
    chmodSync(this.directory, 0o700)
    this.envPath = join(this.directory, ".env")
    if (!existsSync(join(this.directory, ".gitignore"))) {
      writeFileSync(join(this.directory, ".gitignore"), "*\n", {
        flag: "wx",
        mode: 0o600,
      })
    }
  }

  read(): Record<string, string> {
    checkFile(this.envPath)
    return existsSync(this.envPath) ? parse(readFileSync(this.envPath)) : {}
  }

  save(values: Record<string, string>): void {
    const serialized = serializeEnv(values)
    checkFile(this.envPath)
    const temporary = join(this.directory, `.env-${randomUUID()}`)
    const fd = openSync(temporary, "wx", 0o600)
    try {
      try {
        writeFileSync(fd, serialized)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(temporary, this.envPath)
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary)
    }
  }
}
