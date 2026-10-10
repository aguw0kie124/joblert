import { expect, test } from "vitest";
import {
  companySimilarity,
  domainLabel,
  domainMatchesCompany,
  emailDomain,
  normalizeCompany,
} from "../src/pipeline/company.ts";

test.each([
  ["Stripe, Inc.", "stripe"],
  ["  ACME Corp  ", "acme"],
  ["The Trade Desk", "trade desk"],
  ["Amazon.com", "amazon"],
  ["Facebook", "meta"],
  ["Meta Platforms, Inc.", "meta"],
  ["Procter & Gamble Co.", "procter and gamble"],
  ["L'Oréal", "loreal"],
  ["Co", "co"],
])("normalizeCompany(%s) → %s", (input, expected) => {
  expect(normalizeCompany(input)).toBe(expected);
});

test("companySimilarity", () => {
  expect(companySimilarity("Stripe", "Stripe, Inc.")).toBe(1);
  expect(companySimilarity("Facebook", "Meta")).toBe(1);
  expect(companySimilarity("Palantir", "Palantir Technologies")).toBe(0.8);
  expect(companySimilarity("Meta", "Metabase")).toBe(0);
  expect(companySimilarity("Stripe", "Square")).toBe(0);
  expect(companySimilarity("", "Stripe")).toBe(0);
});

test("domain helpers", () => {
  expect(emailDomain("Jane.Doe@Careers.Stripe.com")).toBe("careers.stripe.com");
  expect(domainLabel("careers.stripe.com")).toBe("stripe");
  expect(domainLabel("jobs.acme.co.uk")).toBe("acme");
  expect(domainLabel("localhost")).toBeNull();
  expect(domainMatchesCompany("careers.stripe.com", "Stripe, Inc.")).toBe(true);
  expect(domainMatchesCompany("mail.tradedesk.com", "The Trade Desk")).toBe(true);
  expect(domainMatchesCompany("greenhouse.io", "Stripe")).toBe(false);
});
