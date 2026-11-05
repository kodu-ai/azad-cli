import { spawn } from "node:child_process"
import { CliError } from "../../error"
import { commandEnvironment } from "../../command-environment"
import { toolCommand } from "../../process"

/** Runs a payload's updater; resolves with its exit code. */
export type RunUpdater = (
  args: string[],
  options: { cwd: string; capture?: boolean }
) => Promise<{ status: number; stdout: string }>

/**
 * Runs `bun <args>` (a payload's `updater/updater.js`) with only
 * operating-system plumbing and Google auth in its environment
 * ({@link commandEnvironment}), so no credential this process holds reaches
 * it except through the files it is given. Without `capture` it shares the
 * terminal. SIGINT and SIGTERM are passed on and this process waits: in a
 * container this process is PID 1 and the only one the platform signals, and
 * the updater must release its operation before it exits.
 */
export const runUpdater: RunUpdater = async (args, options) => {
  const tool = toolCommand("bun", args)
  const child = spawn(tool.command, tool.args, {
    cwd: options.cwd,
    env: commandEnvironment(),
    stdio: options.capture
      ? ["ignore", "pipe", "inherit"]
      : ["inherit", "inherit", "inherit"],
    windowsVerbatimArguments: tool.windowsVerbatimArguments,
  })
  const chunks: Buffer[] = []
  child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk))
  const forward = (signal: NodeJS.Signals) => () => {
    child.kill(signal)
  }
  const onInterrupt = forward("SIGINT")
  const onTerminate = forward("SIGTERM")
  process.on("SIGINT", onInterrupt)
  process.on("SIGTERM", onTerminate)
  try {
    const status = await new Promise<number>((resolve, reject) => {
      child.once("error", (error: NodeJS.ErrnoException) => {
        reject(
          error.code === "ENOENT"
            ? new CliError(
                "Bun is not installed. Install Bun 1.4.4 or newer (https://bun.sh), then retry."
              )
            : error
        )
      })
      child.once("exit", (code, signal) => {
        resolve(code ?? (signal ? 128 + signalNumber(signal) : 1))
      })
    })
    return { status, stdout: Buffer.concat(chunks).toString("utf8") }
  } finally {
    process.off("SIGINT", onInterrupt)
    process.off("SIGTERM", onTerminate)
  }
}

function signalNumber(signal: NodeJS.Signals): number {
  return signal === "SIGINT" ? 2 : signal === "SIGTERM" ? 15 : 9
}
