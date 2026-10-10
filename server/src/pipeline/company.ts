const LEGAL_SUFFIXES = new Set([
  "inc",
  "incorporated",
  "llc",
  "ltd",
  "limited",
  "corp",
  "corporation",
  "co",
  "company",
  "gmbh",
  "plc",
  "pbc",
]);

// Normalized name → canonical normalized name.
const ALIASES: Record<string, string> = {
  facebook: "meta",
  "meta platforms": "meta",
  alphabet: "google",
  twitter: "x",
  square: "block",
  aws: "amazon",
  "amazon web services": "amazon",
};

const TWO_PART_TLDS = new Set(["co.uk", "com.au", "co.in", "co.jp", "com.br", "co.nz", "com.sg"]);

export function normalizeCompany(name: string): string {
  const tokens = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\.com\b/g, "")
    .replace(/&/g, " and ")
    .replace(/['’.]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

  if (tokens.length > 1 && tokens[0] === "the") tokens.shift();
  while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens.at(-1)!)) tokens.pop();

  const joined = tokens.join(" ");
  return ALIASES[joined] ?? joined;
}

/** 1 for the same company, 0.8 when one name extends the other ("Palantir" / "Palantir Technologies"), else 0. */
export function companySimilarity(a: string, b: string): number {
  const na = normalizeCompany(a);
  const nb = normalizeCompany(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na];
  // Whole-token prefix, so "meta" does not match "metabase".
  return long.startsWith(`${short} `) ? 0.8 : 0;
}

export function emailDomain(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1).toLowerCase();
}

/** "careers.stripe.com" → "stripe", "jobs.acme.co.uk" → "acme". */
export function domainLabel(domain: string): string | null {
  const parts = domain.toLowerCase().split(".").filter(Boolean);
  if (parts.length < 2) return null;
  const registrableIndex = TWO_PART_TLDS.has(parts.slice(-2).join(".")) ? parts.length - 3 : parts.length - 2;
  return parts[registrableIndex] ?? null;
}

export function domainMatchesCompany(domain: string, company: string): boolean {
  const label = domainLabel(domain);
  return label !== null && label === normalizeCompany(company).replaceAll(" ", "");
}
