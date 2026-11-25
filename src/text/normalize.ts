/**
 * normalize.ts — text helpers shared by every layer.
 *
 * Every regex in the engine runs over the same normalized form (lower case, no
 * diacritics, collapsed spaces, contractions expanded) so that a rule written
 * once matches "Won't load", "wont load" and "will not load" alike.
 */

import type { Ticket } from "../domain.js";

/** lower case, no diacritics, collapsed whitespace. */
export function norm(s: unknown): string {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** norm() plus expanded negative contractions, for the classification regexes. */
export function normForRules(s: unknown): string {
  return norm(s)
    .replace(/[‘’]/g, "'")
    .replace(/\bwon'?t\b/g, "will not")
    .replace(/\bcan'?t\b/g, "can not")
    .replace(/\bcannot\b/g, "can not")
    .replace(/n't\b/g, " not")
    .replace(/\s+/g, " ");
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * true when `needleNorm` appears in `haystackNorm` as a whole word/phrase.
 * A plain substring check links "Elm" inside "Elmhurst" — the bug class that
 * attached the wrong city hall to a ticket in the original system.
 */
export function containsWholeWord(haystackNorm: string, needleNorm: string): boolean {
  if (!needleNorm) return false;
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(needleNorm)}([^a-z0-9]|$)`).test(haystackNorm);
}

export function stripHtml(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"');
}

const QUOTE_HEADER = [
  /^-{2,}\s*original message\s*-{2,}$/i,
  /^on .{3,120} wrote:$/i,
  /^_{5,}$/,
];
const SIGN_OFF = /^(best regards|kind regards|regards|thanks|thank you|sincerely|cheers),?$/i;
const DISCLAIMER = /^(this (e-?mail|message)\b.*\bconfidential|confidentiality notice|privacy notice:)/i;

/**
 * Cleans one message for classification: HTML, quoted replies, sign-off and
 * legal disclaimer go away. A quoted reply would otherwise feed the previous
 * conversation (including our own templated answer) back into the rules.
 */
export function cleanMessage(raw: string, maxLen = 800): string {
  const lines = stripHtml(String(raw ?? "")).split(/\r?\n/);
  const kept: string[] = [];
  for (const line of lines) {
    const l = line.trim();
    if (!l) continue;
    if (QUOTE_HEADER.some((re) => re.test(l))) break;
    if (/^from:\s/i.test(l) && kept.length > 0) break;
    if (SIGN_OFF.test(l) || DISCLAIMER.test(l)) break;
    if (l.startsWith(">")) continue;
    kept.push(l);
  }
  const text = kept.join(" ").replace(/\s+/g, " ").trim();
  return text.length > maxLen ? text.slice(0, maxLen) : text;
}

/** The router's own first reply. Never fed back to the classifier. */
export function isAutomatedFirstReply(description: string): boolean {
  return /we confirm that your ticket (has been received|was received)/.test(norm(description));
}

export interface TicketText {
  subject: string;
  /** cleaned public messages, joined, capped at 2000 chars */
  body: string;
  /** subject + body through normForRules */
  textNorm: string;
}

/**
 * Text used by the rules: subject + every public message (cleaned), minus the
 * automated first reply. Our template mentions a category; reading it back
 * would let a wrong classification confirm itself on the next pass.
 */
export function ticketText(ticket: Pick<Ticket, "subject" | "actions">): TicketText {
  const subject = ticket.subject || "";
  const parts = (ticket.actions || [])
    .filter((a) => a.type === "public" && a.description?.trim() && !isAutomatedFirstReply(a.description))
    .map((a) => cleanMessage(a.description))
    .filter(Boolean);
  let body = parts.join("\n---\n");
  if (body.length > 2000) body = body.slice(0, 2000);
  return { subject, body, textNorm: normForRules(`${subject} ${body}`) };
}

/** Opening message (lowest action id with text), cleaned, for the AI prompt. */
export function openingMessage(ticket: Pick<Ticket, "actions">, maxLen = 1200): string {
  const withText = (ticket.actions || []).filter((a) => a.description?.trim());
  if (!withText.length) return "";
  const first = withText.reduce((min, a) => (a.id < min.id ? a : min), withText[0]);
  return cleanMessage(first.description, maxLen);
}
