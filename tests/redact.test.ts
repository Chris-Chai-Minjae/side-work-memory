import { expect, test } from "bun:test"
import { type CaptureField, sensitiveFieldRule, shouldBlockField } from "../src/redact/fields"
import { redact } from "../src/redact/index"
import sharedFieldLabels from "./fixtures/field-labels.json"
import enCorpus from "./fixtures/redaction-corpus.en.json"
import koCorpus from "./fixtures/redaction-corpus.ko.json"

const MASK = "[redacted:capture]"
const corpora = [koCorpus, enCorpus]

for (const sample of sharedFieldLabels.cases) {
  test(`Given shared label fixture ${sample.name}, when classified, then Swift parity holds`, () => {
    expect(shouldBlockField(sample.field as CaptureField)).toBe(sample.blocked)
  })
}

test("Given the golden corpora, when loaded, then case counts meet the acceptance gate", () => {
  expect(
    corpora.reduce((count, corpus) => count + corpus.positive.length, 0),
  ).toBeGreaterThanOrEqual(60)
  expect(
    corpora.reduce((count, corpus) => count + corpus.negative.length, 0),
  ).toBeGreaterThanOrEqual(40)
})

for (const corpus of corpora) {
  for (const sample of corpus.positive) {
    test(`Given ${corpus.language} ${sample.name}, when redacted, then the synthetic secret is masked`, () => {
      const result = redact(sample.input)
      expect(result.text).toBe(sample.input.replace(sample.secret, MASK))
      expect(result.masks.map(({ rule, count }) => `${rule}:${count}`)).toEqual([
        `${sample.rule}:1`,
      ])
    })
  }

  for (const sample of corpus.negative) {
    test(`Given ${corpus.language} ${sample.name}, when redacted, then ordinary text remains`, () => {
      expect(redact(sample.input)).toEqual({ text: sample.input, masks: [] })
    })
  }
}

test("Given repeated distinct synthetic patterns, when redacted, then masks count by rule", () => {
  expect(redact("otp 123456 then otp 654321 and AKIAABCDEFGHIJKLMNOP")).toEqual({
    text: `otp ${MASK} then otp ${MASK} and ${MASK}`,
    masks: [
      { rule: "aws-access-key", count: 1 },
      { rule: "otp-numeric", count: 2 },
    ],
  })
})

test("Given an overlapping labeled API key, when redacted, then its span is counted once", () => {
  const stripeShapedKey = ["sk", "test", "A".repeat(24)].join("_")
  expect(redact("api_key=".concat(stripeShapedKey))).toEqual({
    text: MASK,
    masks: [{ rule: "labeled-secret", count: 1 }],
  })
})

test("Given overlapping password and Bearer matches, when redacted, then their union is masked once", () => {
  const token = "A".repeat(24)
  expect(redact(`password: Bearer ${token}`)).toEqual({
    text: MASK,
    masks: [{ rule: "labeled-secret", count: 1 }],
  })
})

test("Given an OTP beyond 40 characters, when redacted, then no partial number is masked", () => {
  const input = `otp${" ".repeat(36)}123456`
  expect(redact(input)).toEqual({ text: input, masks: [] })
})

test("Given an OTP ending at 40 characters, when redacted, then its full number is masked", () => {
  expect(redact(`otp${" ".repeat(34)}123456`)).toEqual({
    text: `otp${" ".repeat(34)}${MASK}`,
    masks: [{ rule: "otp-numeric", count: 1 }],
  })
})

for (const token of [
  "current-password",
  "new-password",
  "one-time-code",
  "cc-number",
  "cc-csc",
  "cc-exp",
  "cc-exp-month",
  "cc-exp-year",
  "cc-name",
]) {
  test(`Given autocomplete ${token}, when classified, then the field is blocked`, () => {
    expect(shouldBlockField({ autocomplete: token })).toBe(true)
  })
}

for (const [name, field, expected] of [
  ["AX secure subrole", { subrole: "AXSecureTextField" }, "secure-text-field"],
  ["autocomplete current password", { autocomplete: "current-password" }, "autocomplete"],
  ["autocomplete sectioned card", { autocomplete: "section-checkout cc-number" }, "autocomplete"],
  ["autocomplete one time code", { autocomplete: "one-time-code" }, "autocomplete"],
  ["password input type", { inputType: "password" }, "input-type"],
  ["telephone input type", { inputType: "tel" }, "input-type"],
  ["English AX title", { axTitle: "Card Number" }, "field-label"],
  ["English AX description", { axDescription: "Enter CVV" }, "field-label"],
  ["Korean AX placeholder", { axPlaceholderValue: "주민등록번호" }, "field-label"],
  ["Korean ARIA name", { ariaName: "인증 번호" }, "field-label"],
  ["generic label alias", { label: "Password" }, "field-label"],
  ["generic description alias", { description: "비밀 번호" }, "field-label"],
  ["generic placeholder alias", { placeholder: "Card Number" }, "field-label"],
  ["ordinary PIN substring", { ariaName: "pinning notes" }, null],
  ["ordinary label", { axTitle: "project notes" }, null],
  ["ordinary autocomplete", { autocomplete: "email" }, null],
  ["ordinary input type", { inputType: "text" }, null],
] as const) {
  test(`Given ${name}, when classified, then field suppression is ${expected ?? "absent"}`, () => {
    expect(sensitiveFieldRule(field)).toBe(expected)
    expect(shouldBlockField(field)).toBe(expected !== null)
  })
}
