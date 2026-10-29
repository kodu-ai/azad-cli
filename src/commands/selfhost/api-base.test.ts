import { expect, test } from "bun:test"
import { apiBase, checkApiBases } from "./api-base"

test("provider APIs default to the public endpoints", () => {
  expect(apiBase("cloudflare", {})).toBe("https://api.cloudflare.com/client/v4")
  expect(apiBase("clerk", {})).toBe("https://api.clerk.com")
  expect(apiBase("github", {})).toBe("https://api.github.com")
})

test("each provider honors its own tooling's base URL variable", () => {
  expect(
    apiBase("cloudflare", {
      CLOUDFLARE_API_BASE_URL: "https://cf-gateway.example.com/client/v4/",
    })
  ).toBe("https://cf-gateway.example.com/client/v4")
  expect(apiBase("clerk", { CLERK_API_URL: "http://127.0.0.1:8787" })).toBe(
    "http://127.0.0.1:8787"
  )
  expect(
    apiBase("github", { GITHUB_API_URL: "https://gh-gateway.example.com/api" })
  ).toBe("https://gh-gateway.example.com/api")
})

test("an unsafe override stops setup without printing its value", () => {
  for (const value of [
    "http://gateway.example.com",
    "http://localhost:8787",
    "https://user:fixture-secret@gateway.example.com",
    "https://gateway.example.com/?key=fixture-secret",
    "not a url fixture-secret",
  ]) {
    expect(() => checkApiBases({ GITHUB_API_URL: value })).toThrow(
      "GITHUB_API_URL must be an https URL"
    )
    expect(() => apiBase("github", { GITHUB_API_URL: value })).not.toThrow(
      "fixture-secret"
    )
  }
})
