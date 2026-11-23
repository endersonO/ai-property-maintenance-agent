import { describe, expect, it } from "vitest";
import { siteUrl } from "./site-url";

describe("siteUrl", () => {
  it("uses SITE_URL first, then Vercel's production URL, then localhost", () => {
    expect(siteUrl({ SITE_URL: "https://demo.example.com", VERCEL_PROJECT_PRODUCTION_URL: "x.vercel.app" }).href).toBe(
      "https://demo.example.com/",
    );
    expect(siteUrl({ VERCEL_PROJECT_PRODUCTION_URL: "homefix.vercel.app" }).href).toBe("https://homefix.vercel.app/");
    expect(siteUrl({}).href).toBe("http://localhost:3000/");
  });
});
