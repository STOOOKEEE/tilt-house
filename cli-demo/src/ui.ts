import { stripVTControlCharacters, styleText } from "node:util";
import { formatUsdc } from "../../web/src/format";

type Style = Parameters<typeof styleText>[0];

// styleText drops the colors when stdout is not a terminal or NO_COLOR is set: logs stay plain.
const paint = (style: Style) => (text: string) => styleText(style, text);

export const color = {
  title: paint(["bold", "cyan"]),
  ok: paint("green"),
  bad: paint(["bold", "red"]),
  warn: paint("yellow"),
  dim: paint("dim"),
  money: paint("magenta"),
  bold: paint("bold"),
};

export const OK = color.ok("✓");
export const BAD = color.bad("✗");

const EXPLORER = "https://testnet.nearblocks.io";
export const txLink = (hash: string): string => `${EXPLORER}/txns/${hash}`;
export const accountLink = (id: string): string => `${EXPLORER}/address/${id}`;

/** The chip token's symbol (`ft_metadata`), set once at start by `useToken`. */
let symbol = "tUSDC";

/** Amounts print with this token's symbol from now on. */
export function useToken(tokenSymbol: string): void {
  symbol = tokenSymbol;
}

export const money = (amount: string | bigint): string => `${formatUsdc(amount)} ${symbol}`;

/** `1 round`, `2 rounds`. */
export const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;

export function heading(text: string): void {
  console.log(`\n${color.title(`▸ ${text}`)}`);
}

export function line(text: string): void {
  console.log(`  ${text}`);
}

/** Left-aligned columns; colored cells are padded on their visible width. */
export function table(rows: readonly (readonly string[])[]): void {
  const width = (cell: string) => stripVTControlCharacters(cell).length;
  const widths = (rows[0] ?? []).map((_, i) => Math.max(...rows.map((r) => width(r[i] ?? ""))));
  for (const row of rows) {
    line(row.map((cell, i) => cell + " ".repeat((widths[i] ?? 0) - width(cell))).join("  ").trimEnd());
  }
}

export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
