import { describe, expect, it } from "vitest";
import { parseTriageOutput } from "./triage.js";

describe("parseTriageOutput", () => {
  it("parses a clean JSON response", () => {
    const r = parseTriageOutput('{"reply":"Hi Sam, thanks!","tag":"hot","reason":"Wants a quote this week"}');
    expect(r).toEqual({ reply: "Hi Sam, thanks!", tag: "hot", reason: "Wants a quote this week" });
  });

  it("normalises tag casing and whitespace", () => {
    expect(parseTriageOutput('{"reply":"Hi","tag":" Warm ","reason":"x"}').tag).toBe("warm");
  });

  it("extracts JSON wrapped in prose / code fences", () => {
    const raw = 'Sure!\n```json\n{"reply":"Hello","tag":"cold","reason":"spam"}\n```';
    expect(parseTriageOutput(raw).tag).toBe("cold");
  });

  it("defaults a missing reason to empty string", () => {
    expect(parseTriageOutput('{"reply":"Hi","tag":"cold"}').reason).toBe("");
  });

  it("rejects an unknown tag", () => {
    expect(() => parseTriageOutput('{"reply":"Hi","tag":"lukewarm"}')).toThrow(/validation/);
  });

  it("rejects non-JSON output", () => {
    expect(() => parseTriageOutput("I cannot help with that")).toThrow(/did not return JSON/);
  });
});
