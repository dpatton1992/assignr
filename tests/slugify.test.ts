import { describe, expect, it } from "vitest";
import { slugify } from "../src/utils/slugify.js";

describe("slugify", () => {
  it("converts title to lowercase kebab-case", () => {
    expect(slugify("License Expiration Reminders")).toBe("license-expiration-reminders");
  });

  it("strips special characters", () => {
    expect(slugify("Add OAuth2 (PKCE) Support!")).toBe("add-oauth2-pkce-support");
  });

  it("collapses multiple spaces and dashes", () => {
    expect(slugify("Fix   the   bug")).toBe("fix-the-bug");
    expect(slugify("fix--the--bug")).toBe("fix-the-bug");
  });

  it("trims leading and trailing dashes", () => {
    expect(slugify("  hello world  ")).toBe("hello-world");
  });

  it("returns empty string for all-special input", () => {
    expect(slugify("!!!")).toBe("");
  });

  it("handles single word", () => {
    expect(slugify("Dashboard")).toBe("dashboard");
  });
});
