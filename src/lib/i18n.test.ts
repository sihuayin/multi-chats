import { describe, expect, it } from "vitest";
import { detectLocale, translate } from "@/lib/i18n";

describe("i18n", () => {
  it("detects Chinese and English browser preferences", () => {
    expect(detectLocale("zh-CN,zh;q=0.9,en;q=0.8")).toBe("zh");
    expect(detectLocale("en-US,en;q=0.9")).toBe("en");
    expect(detectLocale(null)).toBe("en");
  });

  it("translates keys and interpolates values", () => {
    expect(translate("zh", "chat.conversations")).toBe("会话");
    expect(
      translate("en", "chat.approvalRequired", { tool: "post_webhook" })
    ).toBe("Approval required: post_webhook");
  });
});
