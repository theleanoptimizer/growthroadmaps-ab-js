import { describe, expect, it } from "vitest";
import {
  GA_USER_PROPERTY_VALUE_MAX,
  capGaDimensionValue,
  experimentLabels,
} from "../src/index";

describe("GA4 experiment label list", () => {
  const experiments = [
    { id: "a", sequence_number: 12 },
    { id: "b", sequence_number: 15 },
    { id: "c", sequence_number: 18 },
    { id: "d", sequence_number: 21 },
    { id: "unnamed", sequence_number: null },
  ];

  it("joins every assigned experiment in assignment order", () => {
    const assignments = new Map<string, { index: number }>([
      ["a", { index: 1 }],
      ["b", { index: 2 }],
      ["unnamed", { index: 1 }],
    ]);
    expect(experimentLabels(assignments, experiments)).toEqual(["EXP-12-1", "EXP-15-2"]);
  });

  it("drops the oldest labels once the list exceeds the GA4 user-property cap", () => {
    const labels = ["EXP-12-1", "EXP-15-2", "EXP-18-1", "EXP-21-2", "EXP-24-1"];
    const value = capGaDimensionValue(labels);
    expect(value.length).toBeLessThanOrEqual(GA_USER_PROPERTY_VALUE_MAX);
    expect(value.startsWith("EXP-12-1")).toBe(false);
    expect(value.endsWith("EXP-24-1")).toBe(true);
    expect(value.split(",").every((label) => labels.includes(label))).toBe(true);
  });

  it("keeps a short list unchanged", () => {
    expect(capGaDimensionValue(["EXP-12-1", "EXP-15-2"])).toBe("EXP-12-1,EXP-15-2");
  });
});
