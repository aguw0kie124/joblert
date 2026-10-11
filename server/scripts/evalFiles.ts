// Files shared by eval:sample and eval:inbox. Everything under server/eval/ is real mail and gitignored.
import path from "node:path";
import type { FilterResult } from "../src/gmail/filters.ts";
import type { ParsedEmail } from "../src/gmail/parser.ts";

export const EVAL_DIR = path.resolve(import.meta.dirname, "../eval");
export const SAMPLE_FILE = path.join(EVAL_DIR, "sample.json");
export const LABELS_FILE = path.join(EVAL_DIR, "labels.csv");
export const RESULTS_FILE = path.join(EVAL_DIR, "results.json");

export type Rule = FilterResult["verdict"];

export type SampleEmail = Omit<ParsedEmail, "receivedAt"> & { receivedAt: string; rule: Rule };

export interface Sample {
  inbox: string;
  days: number;
  /** How many emails of the period got each rule verdict; `emails` holds a random part of each. */
  seen: Record<Rule, number>;
  emails: SampleEmail[];
}

const cell = (value: string) => (/[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);

export const toCsv = (rows: readonly (readonly string[])[]) => rows.map((row) => row.map(cell).join(",")).join("\n") + "\n";

/** Reads CSV as spreadsheets write it: quoted cells, doubled quotes, line breaks inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;
  const input = text.replace(/^﻿/, "");

  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') {
        value += '"';
        i++;
      } else if (char === '"') quoted = false;
      else value += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(value);
      value = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[i + 1] === "\n") i++;
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
    } else value += char;
  }
  if (value || row.length) rows.push([...row, value]);
  return rows.filter((r) => r.some((c) => c.trim()));
}
