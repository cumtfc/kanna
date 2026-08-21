import { describe, expect, test } from "bun:test"
import {
  DEFAULT_KIMI_MODEL,
  DEFAULT_KIMI_MODEL_OPTIONS,
} from "./types"
import {
  normalizeKimiPreference,
  normalizeProviderDefaults,
} from "./provider-preferences"

describe("provider preference normalization", () => {
  test("Kimi defaults when preference is absent", () => {
    expect(normalizeProviderDefaults({ kimi: undefined }).kimi).toEqual({
      model: DEFAULT_KIMI_MODEL,
      modelOptions: { reasoningEffort: "max" },
      planMode: false,
      autoPlan: false,
    })
  })

  test("Kimi normalizes arbitrary effort strings", () => {
    const preference = normalizeKimiPreference({
      model: "kimi-code/k3",
      modelOptions: { reasoningEffort: "custom-high" },
    })
    expect(preference.modelOptions.reasoningEffort).toBe("custom-high")
  })

  test("Kimi falls back to default effort for empty or missing effort", () => {
    expect(normalizeKimiPreference({ model: "kimi-code/k3" }).modelOptions.reasoningEffort)
      .toBe(DEFAULT_KIMI_MODEL_OPTIONS.reasoningEffort)
    expect(normalizeKimiPreference({ model: "kimi-code/k3", modelOptions: { reasoningEffort: "" } }).modelOptions.reasoningEffort)
      .toBe(DEFAULT_KIMI_MODEL_OPTIONS.reasoningEffort)
  })

  test("Kimi trims model id and falls back to default when empty", () => {
    expect(normalizeKimiPreference({ model: "  kimi-code/k3  " }).model).toBe("kimi-code/k3")
    expect(normalizeKimiPreference({ model: "" }).model).toBe(DEFAULT_KIMI_MODEL)
  })

  test("Kimi autoPlan is always false", () => {
    expect(normalizeKimiPreference({ autoPlan: true }).autoPlan).toBe(false)
  })

  test("Kimi planMode is preserved as a boolean", () => {
    expect(normalizeKimiPreference({ planMode: true }).planMode).toBe(true)
    expect(normalizeKimiPreference({}).planMode).toBe(false)
  })
})
