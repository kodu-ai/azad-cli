import type { Command } from "./command"
import { selfhost } from "./selfhost/command"

/** Every command group, by the name that selects it: `azad <name> …`. */
export const COMMANDS: readonly Command[] = [selfhost]

/** The group that runs when the first argument names none: `azad [options]`. */
export const DEFAULT_COMMAND: Command = selfhost

/**
 * The group `argv` selects and the arguments it receives: a leading group
 * name is consumed; no arguments, or a leading option, select the default
 * group with every argument. Undefined for any other leading word.
 */
export function selectCommand(
  argv: string[]
): { command: Command; argv: string[] } | undefined {
  const [first, ...rest] = argv
  const named = COMMANDS.find((command) => command.name === first)
  if (named) return { command: named, argv: rest }
  if (first === undefined || first.startsWith("-"))
    return { command: DEFAULT_COMMAND, argv }
  return undefined
}
