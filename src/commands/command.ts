/**
 * A top-level command group: `azad <name> [arguments]`. Each group parses
 * its own arguments and returns the process exit code.
 */
export type Command = {
  name: string
  /** One line for `azad --help`. */
  summary: string
  run(argv: string[]): Promise<number>
}
