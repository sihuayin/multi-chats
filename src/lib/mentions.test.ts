import { describe, expect, it } from "vitest";
import {
  activeMention,
  filterMentionEmployees,
  mentionSlug
} from "@/lib/mentions";
import { createFixtureState } from "@/server/test-support/fixtures";

describe("Mention helpers", () => {
  it("preserves Unicode employee names in mention slugs", () => {
    expect(mentionSlug("马念媛")).toBe("马念媛");
    expect(mentionSlug("  Alice Chen  ")).toBe("alice-chen");
  });

  it("detects and filters a Chinese mention", () => {
    const employee = createFixtureState().employees[0];
    const chinese = { ...employee, name: "马念媛" };

    expect(activeMention("请 @马念", 5)).toEqual({
      start: 2,
      end: 5,
      query: "马念"
    });
    expect(activeMention("请 @`马念媛`", 8)).toEqual({
      start: 2,
      end: 8,
      query: "马念媛"
    });
    expect(filterMentionEmployees([chinese], "马念")).toEqual([chinese]);
    expect(filterMentionEmployees([chinese], "ma")).toEqual([]);
  });
});
