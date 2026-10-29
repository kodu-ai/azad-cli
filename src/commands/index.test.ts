import { expect, test } from "bun:test"
import { selectCommand } from "."

test("a leading command name selects its group; no arguments or a leading option select self-hosting", () => {
  expect(selectCommand(["selfhost", "--doctor"])).toMatchObject({
    command: { name: "selfhost" },
    argv: ["--doctor"],
  })
  expect(selectCommand([])).toMatchObject({
    command: { name: "selfhost" },
    argv: [],
  })
  expect(selectCommand(["--instance", "staging"])).toMatchObject({
    command: { name: "selfhost" },
    argv: ["--instance", "staging"],
  })
  expect(selectCommand(["deploy"])).toBeUndefined()
})
