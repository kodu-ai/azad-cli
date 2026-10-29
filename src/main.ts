#!/usr/bin/env bun
import { COMMANDS, selectCommand } from "./commands"

const selected = selectCommand(process.argv.slice(2))
if (selected) {
  process.exitCode = await selected.command.run(selected.argv)
} else {
  // The unknown word is not repeated: it may be a mistyped secret.
  process.stderr.write(
    `Unknown command. Commands: ${COMMANDS.map((command) => command.name).join(", ")}. Run azad --help for usage.\n`
  )
  process.exitCode = 2
}
