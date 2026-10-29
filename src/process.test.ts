import { expect, test } from "bun:test"
import { toolCommand } from "./process"

const args = [
  "--yes",
  "clerk@4.0.0",
  "api",
  "-d",
  '{"name":"Azad (a&b)"}',
  "/v1/x?y=1%20",
]
const nodeDirectory = "C:\\Program Files\\nodejs"
const windows = (files: string[], extra: Record<string, string> = {}) => ({
  platform: "win32" as const,
  env: {
    Path: `C:\\Windows\\System32;${nodeDirectory};C:\\work\\node_modules\\.bin`,
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    ComSpec: "C:\\Windows\\system32\\cmd.exe",
    ...extra,
  },
  exists: (path: string) => files.includes(path),
})

test("Linux and macOS start a tool as named", () => {
  for (const platform of ["linux", "darwin"] as const)
    expect(toolCommand("npx", args, { platform })).toEqual({
      command: "npx",
      args,
    })
})

test("Windows starts an .exe found on PATH directly", () => {
  expect(
    toolCommand(
      "terraform",
      ["version"],
      windows(["C:\\work\\node_modules\\.bin\\terraform.exe"])
    )
  ).toEqual({
    command: "C:\\work\\node_modules\\.bin\\terraform.exe",
    args: ["version"],
  })
})

test("Windows runs a .cmd shim through cmd.exe with every argument escaped as cross-spawn escapes it", () => {
  expect(
    toolCommand("npx", args, windows([`${nodeDirectory}\\npx.cmd`]))
  ).toEqual({
    command: "C:\\Windows\\system32\\cmd.exe",
    args: [
      "/d",
      "/s",
      "/c",
      // The resolved path is quoted, so cmd does not look in the working directory first.
      `""${nodeDirectory}\\npx.cmd" ^"--yes^" ^"clerk@4.0.0^" ^"api^" ^"-d^" ^"{\\^"name\\^":\\^"Azad^ ^(a^&b^)\\^"}^" ^"/v1/x^?y=1^%20^""`,
    ],
    windowsVerbatimArguments: true,
  })
})

test("a node_modules/.bin shim passes its arguments through cmd twice, so they are escaped twice", () => {
  const shim = "C:\\work\\node_modules\\.bin\\wrangler.cmd"
  const command = toolCommand("wrangler", ["a&b"], windows([shim]))
  expect(command.args.at(-1)).toBe(`""${shim}" ^^^"a^^^&b^^^""`)
})

test("a tool missing from PATH is left for the spawn to report as not found", () => {
  expect(toolCommand("gcloud", ["--version"], windows([]))).toEqual({
    command: "gcloud",
    args: ["--version"],
  })
})
