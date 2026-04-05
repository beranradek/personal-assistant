/**
 * Gmail Unreads — Categorized Unread Email Overview
 * ===================================================
 *
 * Fetches unread INBOX emails across all configured Gmail accounts,
 * categorizes them by priority, and returns an aggregated report.
 *
 * Categories (by priority):
 *   1. action_required — real person, user in TO, contains question/request
 *   2. invoices — invoices, receipts (by sender and subject patterns)
 *   3. fyi — user in CC, internal mail without question, Jira/ticket notifications
 *   4. newsletters — newsletter@, digest@, Substack, etc.
 *   5. automated — GitHub, Google Calendar, CI/CD, system notifications
 *
 * Categories 1–3 are returned with full detail; 4–5 as counts only.
 *
 * Does NOT mark any messages as read.
 *
 * Gmail API reference:
 *   https://developers.google.com/gmail/api/reference/rest
 */

import { createLogger } from "../../../core/logger.js";
import type { AuthManager } from "../../auth/manager.js";
import type { OutboundRateLimiter } from "./rate-limits.js";

const log = createLogger("integ-api:gmail:unreads");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1";

/** Max unread messages to fetch per account. */
const DEFAULT_MAX_RESULTS = 50;

/** Max concurrent message metadata fetches. */
const MAX_CONCURRENCY = 8;

/** Headers to request from the Gmail metadata endpoint. */
const METADATA_HEADERS = [
  "From",
  "To",
  "Cc",
  "Subject",
  "Date",
  "List-Unsubscribe",
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EmailCategory =
  | "action_required"
  | "invoices"
  | "fyi"
  | "newsletters"
  | "automated";

/** Email metadata used for categorization and display. */
export interface UnreadEmail {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  to: string;
  cc: string;
  date: string;
  snippet: string;
  account: string;
  category: EmailCategory;
  /** Gmail internalDate (epoch ms string) for reliable sorting. */
  internalDate: string;
}

/** Categorized unreads response for a single account. */
export interface AccountUnreads {
  email: string;
  profileId: string;
  totalUnread: number;
  emails: UnreadEmail[];
}

/** Aggregated unreads response across all accounts. */
export interface GmailUnreadsResult {
  categories: {
    action_required: UnreadEmail[];
    invoices: UnreadEmail[];
    fyi: UnreadEmail[];
    newsletters: { count: number };
    automated: { count: number };
  };
  summary: {
    totalAccounts: number;
    totalUnread: number;
    actionRequired: number;
    invoices: number;
    fyi: number;
    newsletters: number;
    automated: number;
  };
  accounts: string[];
  errors?: string[];
}

// ---------------------------------------------------------------------------
// Gmail API types (minimal)
// ---------------------------------------------------------------------------

interface GmailMessageRef {
  id: string;
  threadId: string;
}

interface GmailListResponse {
  messages?: GmailMessageRef[];
  resultSizeEstimate?: number;
}

interface GmailHeader {
  name: string;
  value: string;
}

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: {
    headers?: GmailHeader[];
  };
}

interface GmailProfileResponse {
  emailAddress?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getHeader(headers: GmailHeader[], name: string): string {
  const lower = name.toLowerCase();
  return headers.find((h) => h.name.toLowerCase() === lower)?.value ?? "";
}

/** Extract bare email address from "Name <email>" format. */
export function extractEmailAddress(addr: string): string {
  const match = addr.match(/<([^>]+)>/);
  return (match ? match[1]! : addr).trim().toLowerCase();
}

/** Run async tasks with a concurrency limit. */
async function withConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  const results: T[] = [];
  const executing = new Set<Promise<void>>();

  for (const task of tasks) {
    const p = task().then((result) => {
      results.push(result);
    });
    const wrapped = p.then(() => {
      executing.delete(wrapped);
    });
    executing.add(wrapped);

    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }

  await Promise.all(executing);
  return results;
}

// ---------------------------------------------------------------------------
// Sender pattern matching
// ---------------------------------------------------------------------------

/**
 * Automated system sender domains.
 *
 * NOTE: all entries must be lowercase. Matching also covers subdomains
 * (e.g. "mail.github.com" matches "github.com").
 */
const AUTOMATED_DOMAINS = new Set([
  "github.com",
  "gitlab.com",
  "bitbucket.org",
  "circleci.com",
  "travis-ci.com",
  "travis-ci.org",
  "app.circleci.com",
  "codecov.io",
  "dependabot.com",
  "snyk.io",
  "sentry.io",
  "pagerduty.com",
  "opsgenie.com",
  "datadog.com",
  "newrelic.com",
  "atlassian.net",
  "vercel.com",
  "netlify.com",
  "heroku.com",
  "aws.amazon.com",
  "amazonses.com",
  "calendar.google.com",
  "accounts.google.com",
  "notifications.google.com",
  "cloudflare.com",
  "docker.com",
  "npmjs.com",
  "linear.app",
  "notion.so",
  "figma.com",
  "slack.com",
  "zoom.us",
]);

/** Automated sender local parts (before @). */
const AUTOMATED_LOCAL_PARTS = new Set([
  "noreply",
  "no-reply",
  "donotreply",
  "do-not-reply",
  "notifications",
  "notification",
  "notify",
  "alert",
  "alerts",
  "mailer-daemon",
  "postmaster",
  "system",
  "automated",
  "auto",
  "bot",
  "ci",
  "builds",
  "deploy",
  "monitoring",
  "calendar-notification",
]);

/** Newsletter sender patterns. */
const NEWSLETTER_LOCAL_PARTS = new Set([
  "newsletter",
  "newsletters",
  "digest",
  "weekly",
  "daily",
  "updates",
  "news",
  "marketing",
  "promo",
  "promotions",
  "campaign",
  "announce",
  "announcements",
]);

const NEWSLETTER_DOMAINS = new Set([
  "substack.com",
  "mailchimp.com",
  "sendgrid.net",
  "mailgun.org",
  "constantcontact.com",
  "campaignmonitor.com",
  "hubspotemail.net",
  "convertkit.com",
  "beehiiv.com",
  "buttondown.email",
  "revue.email",
  "ghost.io",
  "medium.com",
]);

/** Invoice/billing sender domains (always classified as invoice, even with noreply@). */
const INVOICE_DOMAINS = new Set([
  "paypal.com",
  "stripe.com",
  "square.com",
  "wise.com",
  "revolut.com",
  "gopay.cz",
  "csob.cz",
  "kb.cz",
  "fio.cz",
  "moneta.cz",
  "airbank.cz",
  "fakturoid.cz",
  "idoklad.cz",
  "pohoda.cz",
  "quickbooks.intuit.com",
  "xero.com",
  "freshbooks.com",
]);

/** Invoice/billing sender local parts (before @). */
const INVOICE_LOCAL_PARTS = new Set([
  "billing",
  "invoice",
  "invoices",
  "faktura",
  "faktury",
  "receipts",
  "receipt",
  "uctenka",
  "platba",
  "payment",
  "payments",
  "finance",
  "accounting",
]);

const INVOICE_SUBJECT_PATTERNS = [
  /\bfaktur[aáyeě]/i,
  /\binvoice\b/i,
  /\breceipt\b/i,
  /\búčtenk/i,
  /\bplatb[aáyeě]/i,
  /\bpayment\b/i,
  /\bvyúčtování/i,
  /\bobjednávk/i,
  /\border\s+confirm/i,
  /\bbilling\b/i,
  /\bpředpis\b/i,
];

// ---------------------------------------------------------------------------
// Categorization helpers
// ---------------------------------------------------------------------------

function matchDomainOrSubdomain(fromDomain: string, domains: Set<string>): boolean {
  if (domains.has(fromDomain)) return true;
  for (const d of domains) {
    if (fromDomain.endsWith(`.${d}`)) return true;
  }
  return false;
}

function isAutomated(fromLocal: string, fromDomain: string): boolean {
  if (matchDomainOrSubdomain(fromDomain, AUTOMATED_DOMAINS)) return true;
  if (AUTOMATED_LOCAL_PARTS.has(fromLocal)) return true;
  return false;
}

function isNewsletter(
  fromLocal: string,
  fromDomain: string,
  hasListUnsubscribe: boolean,
): boolean {
  if (matchDomainOrSubdomain(fromDomain, NEWSLETTER_DOMAINS)) return true;
  if (NEWSLETTER_LOCAL_PARTS.has(fromLocal)) return true;
  // List-Unsubscribe header is a strong newsletter/mailing-list signal
  if (hasListUnsubscribe && !INVOICE_LOCAL_PARTS.has(fromLocal)) return true;
  return false;
}

function isInvoiceDomain(fromDomain: string): boolean {
  return matchDomainOrSubdomain(fromDomain, INVOICE_DOMAINS);
}

function isInvoiceByContent(fromLocal: string, subject: string): boolean {
  if (INVOICE_LOCAL_PARTS.has(fromLocal)) return true;
  return INVOICE_SUBJECT_PATTERNS.some((p) => p.test(subject));
}

function containsQuestion(subject: string, snippet: string): boolean {
  const text = `${subject} ${snippet}`;
  if (text.includes("?")) return true;
  // Common request patterns (EN + CS)
  const requestPatterns = [
    /\bplease\b/i,
    /\bcould you\b/i,
    /\bcan you\b/i,
    /\bwould you\b/i,
    /\bneed\s+(?:you|your)\b/i,
    /\brequest\b/i,
    /\baction\s+required\b/i,
    /\burgent\b/i,
    /\basap\b/i,
    /\bprosím\b/i,
    /\bmůžeš\b/i,
    /\bmohl[a]?\s+bys/i,
    /\bpotřebuj/i,
  ];
  return requestPatterns.some((p) => p.test(text));
}

// ---------------------------------------------------------------------------
// Categorization
// ---------------------------------------------------------------------------

/**
 * Categorize a single email by its metadata.
 *
 * Priority order:
 *   1. Invoice domains (Stripe, PayPal, …) — always invoice, even if noreply@
 *   2. Invoice by local part or subject pattern (billing@, "Faktura …")
 *   3. Automated senders (GitHub, noreply@, CI/CD domains)
 *   4. Newsletters (Substack, digest@, List-Unsubscribe header)
 *   5. FYI (user in CC only)
 *   6. Action required (user in TO)
 *   7. FYI (fallback — can't determine TO/CC position)
 *
 * Invoice checks (1–2) run before automated/newsletter to prevent invoice
 * emails from being swallowed by List-Unsubscribe or noreply@ heuristics.
 * Automated local parts (noreply@) on non-invoice domains still win over
 * subject-based invoice detection (step 2 only checks local part + subject,
 * and noreply@ is not in INVOICE_LOCAL_PARTS).
 */
export function categorizeEmail(
  from: string,
  to: string,
  cc: string,
  subject: string,
  snippet: string,
  userEmails: string[],
  hasListUnsubscribe = false,
): EmailCategory {
  const fromEmail = extractEmailAddress(from);
  const fromParts = fromEmail.split("@");
  const fromLocal = fromParts[0] ?? "";
  const fromDomain = fromParts[1] ?? "";

  const normalizedUserEmails = userEmails.map((e) => e.toLowerCase());

  const toLower = to.toLowerCase();
  const ccLower = cc.toLowerCase();

  const isInTo = normalizedUserEmails.some((ue) => toLower.includes(ue));
  const isInCc = normalizedUserEmails.some((ue) => ccLower.includes(ue));

  // 1. Invoice domains win over everything — noreply@stripe.com IS an invoice
  if (isInvoiceDomain(fromDomain)) return "invoices";

  // 2. Invoice by local part or subject pattern — checked early so that
  //    "Faktura" emails from real people aren't swallowed by List-Unsubscribe
  if (isInvoiceByContent(fromLocal, subject)) return "invoices";

  // 3. Automated — system notifications (filter noise)
  if (isAutomated(fromLocal, fromDomain)) return "automated";

  // 4. Newsletters
  if (isNewsletter(fromLocal, fromDomain, hasListUnsubscribe)) return "newsletters";

  // 5. FYI — user in CC only (not TO)
  if (isInCc && !isInTo) return "fyi";

  // 6. Action required — real person, user in TO
  if (isInTo) return "action_required";

  // 7. Fallback: can't determine TO/CC position (e.g., BCC or mailing list)
  return "fyi";
}

// ---------------------------------------------------------------------------
// Gmail API fetch helpers
// ---------------------------------------------------------------------------

async function gmailGet<T>(url: string, token: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "(unreadable)");
    throw new Error(`Gmail API HTTP ${response.status}: ${errText}`);
  }

  return (await response.json()) as T;
}

/**
 * Get the authenticated user's email address via Gmail profile.
 */
async function fetchProfileEmail(token: string): Promise<string> {
  const profile = await gmailGet<GmailProfileResponse>(
    `${GMAIL_API_BASE}/users/me/profile`,
    token,
  );
  return profile.emailAddress ?? "";
}

/**
 * List unread INBOX message IDs.
 */
async function listUnreadMessages(
  token: string,
  maxResults: number,
): Promise<GmailMessageRef[]> {
  const params = new URLSearchParams({
    q: "is:unread in:inbox",
    maxResults: String(maxResults),
  });
  const data = await gmailGet<GmailListResponse>(
    `${GMAIL_API_BASE}/users/me/messages?${params.toString()}`,
    token,
  );
  return data.messages ?? [];
}

/**
 * Fetch message metadata (headers only, lightweight).
 *
 * Gmail API requires repeated metadataHeaders params:
 *   ?format=metadata&metadataHeaders=From&metadataHeaders=To&…
 */
async function fetchMessageMetadata(
  token: string,
  messageId: string,
): Promise<GmailMessage> {
  const params = new URLSearchParams({ format: "metadata" });
  for (const header of METADATA_HEADERS) {
    params.append("metadataHeaders", header);
  }
  return gmailGet<GmailMessage>(
    `${GMAIL_API_BASE}/users/me/messages/${encodeURIComponent(messageId)}?${params.toString()}`,
    token,
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch and categorize unread emails for a single Gmail account.
 *
 * NOTE: Does NOT use the shared outbound rate limiter for per-message fetches.
 * Gmail's per-user quota (250 quota units/sec) is per-account, not per-server.
 * The MAX_CONCURRENCY limit (8 concurrent requests) provides sufficient throttling.
 * The rateLimiter is checked once at the start as a coarse gate.
 */
export async function fetchAccountUnreads(
  token: string,
  profileId: string,
  userEmails: string[],
  rateLimiter: OutboundRateLimiter,
  maxResults = DEFAULT_MAX_RESULTS,
): Promise<AccountUnreads> {
  // Gate check: one rate limit hit for the logical "unreads" operation
  rateLimiter.checkAndRecord();

  // Get the account email (for display and as fallback userEmail)
  const accountEmail = await fetchProfileEmail(token);

  // Ensure the account's own email is included for TO/CC detection
  const allUserEmails = [...new Set([
    ...userEmails.map((e) => e.toLowerCase()),
    accountEmail.toLowerCase(),
  ].filter(Boolean))];

  // List unread messages
  const messageRefs = await listUnreadMessages(token, maxResults);

  if (messageRefs.length === 0) {
    return {
      email: accountEmail,
      profileId,
      totalUnread: 0,
      emails: [],
    };
  }

  // Fetch metadata concurrently (throttled by MAX_CONCURRENCY, not rate limiter)
  const emails = await withConcurrency(
    messageRefs.map((ref) => async () => {
      const msg = await fetchMessageMetadata(token, ref.id);
      const headers = msg.payload?.headers ?? [];

      const subject = getHeader(headers, "Subject");
      const from = getHeader(headers, "From");
      const to = getHeader(headers, "To");
      const cc = getHeader(headers, "Cc");
      const date = getHeader(headers, "Date");
      const listUnsub = getHeader(headers, "List-Unsubscribe");

      const category = categorizeEmail(
        from, to, cc, subject, msg.snippet ?? "",
        allUserEmails,
        listUnsub.length > 0,
      );

      return {
        id: msg.id,
        threadId: msg.threadId,
        subject,
        from,
        to,
        cc,
        date,
        snippet: msg.snippet ?? "",
        account: accountEmail,
        category,
        internalDate: msg.internalDate ?? "0",
      } satisfies UnreadEmail;
    }),
    MAX_CONCURRENCY,
  );

  return {
    email: accountEmail,
    profileId,
    totalUnread: emails.length,
    emails,
  };
}

/**
 * Fetch unreads across all Gmail accounts and aggregate into categorized report.
 *
 * @param authManager - Auth manager for token retrieval
 * @param userEmails  - User's email addresses from config
 * @param rateLimiter - Outbound rate limiter
 * @param maxPerAccount - Max messages per account
 */
export async function getGmailUnreads(
  authManager: AuthManager,
  userEmails: string[],
  rateLimiter: OutboundRateLimiter,
  maxPerAccount = DEFAULT_MAX_RESULTS,
): Promise<GmailUnreadsResult> {
  const profileIds = authManager.listProfiles("gmail");

  if (profileIds.length === 0) {
    return {
      categories: {
        action_required: [],
        invoices: [],
        fyi: [],
        newsletters: { count: 0 },
        automated: { count: 0 },
      },
      summary: {
        totalAccounts: 0,
        totalUnread: 0,
        actionRequired: 0,
        invoices: 0,
        fyi: 0,
        newsletters: 0,
        automated: 0,
      },
      accounts: [],
      errors: ["No Gmail accounts configured. Run 'pa integapi auth google' to set up."],
    };
  }

  // Fetch unreads from each account
  const results = await Promise.allSettled(
    profileIds.map(async (profileId) => {
      const { token } = await authManager.getAccessTokenForProfile(profileId);
      return fetchAccountUnreads(token, profileId, userEmails, rateLimiter, maxPerAccount);
    }),
  );

  const accountResults: AccountUnreads[] = [];
  const errors: string[] = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i]!;
    if (result.status === "fulfilled") {
      accountResults.push(result.value);
    } else {
      const pid = profileIds[i] ?? "unknown";
      const errMsg = result.reason instanceof Error ? result.reason.message : String(result.reason);
      log.warn({ profileId: pid, err: result.reason }, "Failed to fetch unreads for Gmail account");
      errors.push(`${pid}: ${errMsg}`);
    }
  }

  // Aggregate all emails across accounts
  const allEmails = accountResults.flatMap((a) => a.emails);

  // Sort: action_required first, then invoices, then fyi
  // Within same category, sort by internalDate descending (newest first)
  const sortOrder: Record<EmailCategory, number> = {
    action_required: 0,
    invoices: 1,
    fyi: 2,
    newsletters: 3,
    automated: 4,
  };
  allEmails.sort((a, b) => {
    const catDiff = sortOrder[a.category] - sortOrder[b.category];
    if (catDiff !== 0) return catDiff;
    // Numeric comparison on epoch ms for reliable chronological sort
    const aDate = parseInt(a.internalDate, 10) || 0;
    const bDate = parseInt(b.internalDate, 10) || 0;
    return bDate - aDate;
  });

  // Split into detailed (1-3) and count-only (4-5) categories
  const actionRequired = allEmails.filter((e) => e.category === "action_required");
  const invoices = allEmails.filter((e) => e.category === "invoices");
  const fyi = allEmails.filter((e) => e.category === "fyi");
  const newsletterCount = allEmails.filter((e) => e.category === "newsletters").length;
  const automatedCount = allEmails.filter((e) => e.category === "automated").length;

  return {
    categories: {
      action_required: actionRequired,
      invoices,
      fyi,
      newsletters: { count: newsletterCount },
      automated: { count: automatedCount },
    },
    summary: {
      totalAccounts: accountResults.length,
      totalUnread: allEmails.length,
      actionRequired: actionRequired.length,
      invoices: invoices.length,
      fyi: fyi.length,
      newsletters: newsletterCount,
      automated: automatedCount,
    },
    accounts: accountResults.map((a) => a.email),
    ...(errors.length > 0 ? { errors } : {}),
  };
}
