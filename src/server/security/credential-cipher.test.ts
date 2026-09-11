import { describe, expect, it } from "vitest";
import { AesCredentialCipher } from "@/server/security/credential-cipher";

describe("AesCredentialCipher", () => {
  it("round trips without exposing plaintext", () => {
    const cipher = new AesCredentialCipher("secret");
    const encrypted = cipher.encrypt("provider-key");

    expect(encrypted).not.toContain("provider-key");
    expect(cipher.decrypt(encrypted)).toBe("provider-key");
  });
});
