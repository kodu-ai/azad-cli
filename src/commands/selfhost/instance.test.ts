import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { instanceLocation, localPath, rerunCommand } from "./instance"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

/** A home folder and a separate working directory. */
function machine() {
  const root = mkdtempSync(join(tmpdir(), "azad-cli-instance-"))
  roots.push(root)
  const home = join(root, "home")
  const cwd = join(root, "work")
  mkdirSync(home)
  mkdirSync(cwd)
  return { home, cwd }
}

test("instances live in the home folder: default without flags, --instance NAME beside it", () => {
  const { home, cwd } = machine()
  const instances = join(home, ".azad", "instances")
  expect(instanceLocation({ home, cwd })).toEqual({
    directory: join(instances, "default"),
    flags: [],
  })
  expect(instanceLocation({ home, cwd, instance: "staging" })).toEqual({
    directory: join(instances, "staging"),
    flags: ["--instance", "staging"],
  })
  expect(rerunCommand(instanceLocation({ home, cwd }))).toBe("azad")
  expect(
    rerunCommand(instanceLocation({ home, cwd, instance: "staging" }))
  ).toBe("azad --instance staging")
})

test("--directory overrides the home folder, relative to the working directory or from ~", () => {
  const { home, cwd } = machine()
  expect(instanceLocation({ home, cwd, directory: "my-azad" }).directory).toBe(
    join(cwd, "my-azad")
  )
  expect(instanceLocation({ home, cwd, directory: "~/my-azad" })).toEqual({
    directory: join(home, "my-azad"),
    flags: ["--directory", join(home, "my-azad")],
  })
})

test("an instance name is a folder name, and --instance and --directory are not combined", () => {
  const { home, cwd } = machine()
  for (const name of ["..", "a/b", "a\\b", ".hidden", "", "x".repeat(64)])
    expect(() => instanceLocation({ home, cwd, instance: name })).toThrow(
      "letters, digits, hyphens and underscores"
    )
  expect(() =>
    instanceLocation({ home, cwd, instance: "a", directory: "b" })
  ).toThrow("Use --instance or --directory, not both.")
})

test("a typed path loses the quotes Windows' Copy as path adds and expands ~", () => {
  const home = "/home/person"
  expect(localPath('"C:\\Users\\me\\key.pem"', home)).toBe(
    "C:\\Users\\me\\key.pem"
  )
  expect(localPath("  '/tmp/key one.pem' ", home)).toBe("/tmp/key one.pem")
  expect(localPath("~/Downloads/key.pem", home)).toBe(
    join(home, "Downloads/key.pem")
  )
  expect(localPath("~", home)).toBe(home)
  expect(localPath("~other/key.pem", home)).toBe("~other/key.pem")
})
