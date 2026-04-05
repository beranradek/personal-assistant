/**
 * Tests for Gmail unreads categorization and aggregation
 *
 * GWT verification:
 * 1. categorizeEmail correctly identifies automated senders
 * 2. categorizeEmail correctly identifies newsletters
 * 3. categorizeEmail correctly identifies invoices by sender and subject
 * 4. categorizeEmail marks CC-only recipients as fyi
 * 5. categorizeEmail marks TO recipients with questions as action_required
 * 6. categorizeEmail marks TO recipients without questions as action_required
 * 7. extractEmailAddress handles "Name <email>" and bare email formats
 * 8. getGmailUnreads returns empty result when no profiles configured
 * 9. getGmailUnreads aggregates across multiple accounts
 * 10. GET /gmail/unreads route returns categorized result
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as http from "node:http";
import { categorizeEmail, extractEmailAddress, getGmailUnreads } from "./unreads.js";
import type { AuthManager, TokenResult } from "../../auth/manager.js";
import type { OutboundRateLimiter } from "./rate-limits.js";
import { createIntegApiServer } from "../../server.js";
import { registerGmailRoutes } from "./routes.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_EMAILS = ["user@example.com", "user@company.cz"];

function makeAuthManager(overrides: Partial<AuthManager> = {}): AuthManager {
  return {
    registerProfile: vi.fn(),
    getAccessToken: vi.fn().mockResolvedValue({ token: "test-token", profileId: "p1" } as TokenResult),
    getAccessTokenForProfile: vi.fn().mockResolvedValue({ token: "test-token", profileId: "p1" } as TokenResult),
    refreshToken: vi.fn().mockResolvedValue("new-token"),
    markFailed: vi.fn(),
    markSuccess: vi.fn(),
    listProfiles: vi.fn().mockReturnValue(["p1"]),
    ...overrides,
  };
}

function makePassthroughRateLimiter(): OutboundRateLimiter {
  return { checkAndRecord: vi.fn() };
}

async function request(
  port: number,
  method: string,
  path: string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const options: http.RequestOptions = {
      hostname: "127.0.0.1",
      port,
      path,
      method,
    };
    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          parsed = null;
        }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

let portCounter = 19700;
function nextPort(): number {
  return portCounter++;
}

// ---------------------------------------------------------------------------
// extractEmailAddress
// ---------------------------------------------------------------------------

describe("extractEmailAddress", () => {
  it("extracts email from 'Name <email>' format", () => {
    expect(extractEmailAddress("John Doe <john@example.com>")).toBe("john@example.com");
  });

  it("handles bare email address", () => {
    expect(extractEmailAddress("john@example.com")).toBe("john@example.com");
  });

  it("normalizes to lowercase", () => {
    expect(extractEmailAddress("John@EXAMPLE.com")).toBe("john@example.com");
  });

  it("handles quoted display name", () => {
    expect(extractEmailAddress('"Doe, John" <john@example.com>')).toBe("john@example.com");
  });
});

// ---------------------------------------------------------------------------
// categorizeEmail
// ---------------------------------------------------------------------------

describe("categorizeEmail", () => {
  // 1. Automated senders
  it("GWT: categorizes GitHub notifications as automated", () => {
    expect(
      categorizeEmail(
        "notifications@github.com",
        "user@example.com",
        "",
        "Re: [org/repo] Fix bug (#123)",
        "Someone commented on the PR",
        USER_EMAILS,
      ),
    ).toBe("automated");
  });

  it("GWT: categorizes noreply@ as automated", () => {
    expect(
      categorizeEmail(
        "noreply@someservice.com",
        "user@example.com",
        "",
        "Your account update",
        "",
        USER_EMAILS,
      ),
    ).toBe("automated");
  });

  it("GWT: categorizes Google Calendar as automated", () => {
    expect(
      categorizeEmail(
        "calendar-notification@google.com",
        "user@example.com",
        "",
        "Reminder: Meeting at 3pm",
        "",
        USER_EMAILS,
      ),
    ).toBe("automated");
  });

  it("GWT: categorizes CI/CD notifications as automated", () => {
    expect(
      categorizeEmail(
        "builds@circleci.com",
        "user@example.com",
        "",
        "Build #456 passed",
        "",
        USER_EMAILS,
      ),
    ).toBe("automated");
  });

  it("GWT: categorizes Sentry alerts as automated", () => {
    expect(
      categorizeEmail(
        "alerts@sentry.io",
        "user@example.com",
        "",
        "New issue: TypeError in handler",
        "",
        USER_EMAILS,
      ),
    ).toBe("automated");
  });

  // 2. Newsletters
  it("GWT: categorizes newsletter@ sender as newsletter", () => {
    expect(
      categorizeEmail(
        "newsletter@techblog.com",
        "user@example.com",
        "",
        "Weekly roundup: Top articles",
        "",
        USER_EMAILS,
      ),
    ).toBe("newsletters");
  });

  it("GWT: categorizes Substack as newsletter", () => {
    expect(
      categorizeEmail(
        "author@substack.com",
        "user@example.com",
        "",
        "New post: Building better tools",
        "",
        USER_EMAILS,
      ),
    ).toBe("newsletters");
  });

  it("GWT: categorizes digest@ as newsletter", () => {
    expect(
      categorizeEmail(
        "digest@productboard.com",
        "user@example.com",
        "",
        "Your weekly digest",
        "",
        USER_EMAILS,
      ),
    ).toBe("newsletters");
  });

  // 3. Invoices
  it("GWT: categorizes billing@ sender as invoice", () => {
    expect(
      categorizeEmail(
        "billing@hosting.com",
        "user@example.com",
        "",
        "Your monthly invoice",
        "",
        USER_EMAILS,
      ),
    ).toBe("invoices");
  });

  it("GWT: categorizes by invoice subject pattern (Czech)", () => {
    expect(
      categorizeEmail(
        "jan@dodavatel.cz",
        "user@example.com",
        "",
        "Faktura za březen 2026",
        "",
        USER_EMAILS,
      ),
    ).toBe("invoices");
  });

  it("GWT: categorizes by invoice subject pattern (English)", () => {
    expect(
      categorizeEmail(
        "accounts@vendor.com",
        "user@example.com",
        "",
        "Invoice #12345 - March 2026",
        "",
        USER_EMAILS,
      ),
    ).toBe("invoices");
  });

  it("GWT: categorizes PayPal as invoice", () => {
    expect(
      categorizeEmail(
        "service@paypal.com",
        "user@example.com",
        "",
        "You've got a payment",
        "",
        USER_EMAILS,
      ),
    ).toBe("invoices");
  });

  it("GWT: categorizes receipt subject as invoice", () => {
    expect(
      categorizeEmail(
        "shop@eshop.cz",
        "user@example.com",
        "",
        "Účtenka za objednávku #789",
        "",
        USER_EMAILS,
      ),
    ).toBe("invoices");
  });

  // 4. FYI — CC only
  it("GWT: categorizes CC-only recipient as fyi", () => {
    expect(
      categorizeEmail(
        "colleague@company.cz",
        "boss@company.cz",
        "user@company.cz",
        "Project status update",
        "Here's the latest on Project X",
        USER_EMAILS,
      ),
    ).toBe("fyi");
  });

  // 5. Action required — TO with question
  it("GWT: categorizes TO recipient with question as action_required", () => {
    expect(
      categorizeEmail(
        "colleague@company.cz",
        "user@example.com",
        "",
        "Quick question about the deployment",
        "Can you check if the staging server is working?",
        USER_EMAILS,
      ),
    ).toBe("action_required");
  });

  it("GWT: categorizes TO recipient with request patterns as action_required", () => {
    expect(
      categorizeEmail(
        "manager@company.cz",
        "user@company.cz",
        "",
        "Action required: Review needed",
        "Please review the attached document before Friday",
        USER_EMAILS,
      ),
    ).toBe("action_required");
  });

  it("GWT: categorizes Czech request as action_required", () => {
    expect(
      categorizeEmail(
        "kolega@company.cz",
        "user@company.cz",
        "",
        "Prosím o schválení",
        "Mohl bys se podívat na ten PR?",
        USER_EMAILS,
      ),
    ).toBe("action_required");
  });

  // 6. TO without question — still action_required (real person)
  it("GWT: categorizes TO recipient without question as action_required", () => {
    expect(
      categorizeEmail(
        "friend@gmail.com",
        "user@example.com",
        "",
        "Hey, check this out",
        "Found this interesting article about TypeScript",
        USER_EMAILS,
      ),
    ).toBe("action_required");
  });

  // Edge cases
  it("falls back to fyi when user email not found in TO or CC", () => {
    expect(
      categorizeEmail(
        "someone@company.cz",
        "other@company.cz",
        "another@company.cz",
        "Team update",
        "No action needed",
        USER_EMAILS,
      ),
    ).toBe("fyi");
  });

  it("prioritizes invoice domain over automated local part", () => {
    // noreply@stripe.com — Stripe is an invoice domain, should be invoice not automated
    expect(
      categorizeEmail(
        "noreply@stripe.com",
        "user@example.com",
        "",
        "Invoice for subscription",
        "",
        USER_EMAILS,
      ),
    ).toBe("invoices");
  });

  it("classifies invoice subject from automated sender as invoice", () => {
    // noreply@github.com with invoice subject — invoice wins because financial
    // content should surface in the detailed report, not be hidden in counts
    expect(
      categorizeEmail(
        "noreply@github.com",
        "user@example.com",
        "",
        "Invoice for GitHub sponsorship",
        "",
        USER_EMAILS,
      ),
    ).toBe("invoices");
  });

  it("classifies non-invoice automated sender as automated", () => {
    // noreply@github.com with non-invoice subject — automated
    expect(
      categorizeEmail(
        "noreply@github.com",
        "user@example.com",
        "",
        "Your repository was starred",
        "",
        USER_EMAILS,
      ),
    ).toBe("automated");
  });

  it("uses List-Unsubscribe header for newsletter detection", () => {
    expect(
      categorizeEmail(
        "ceo@startup.com",
        "user@example.com",
        "",
        "Our latest product update",
        "Check out what we've been building",
        USER_EMAILS,
        true, // hasListUnsubscribe
      ),
    ).toBe("newsletters");
  });

  it("does not classify invoice senders as newsletters even with List-Unsubscribe", () => {
    expect(
      categorizeEmail(
        "billing@hosting.com",
        "user@example.com",
        "",
        "Your monthly invoice",
        "",
        USER_EMAILS,
        true, // hasListUnsubscribe
      ),
    ).toBe("invoices");
  });

  it("classifies invoice subject from real person as invoice even with List-Unsubscribe", () => {
    // jan@dodavatel.cz sends "Faktura za březen" with List-Unsubscribe — should be invoice
    expect(
      categorizeEmail(
        "jan@dodavatel.cz",
        "user@example.com",
        "",
        "Faktura za březen 2026",
        "",
        USER_EMAILS,
        true, // hasListUnsubscribe
      ),
    ).toBe("invoices");
  });
});

// ---------------------------------------------------------------------------
// getGmailUnreads
// ---------------------------------------------------------------------------

describe("getGmailUnreads", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("GWT: returns empty result when no profiles configured", async () => {
    const authManager = makeAuthManager({
      listProfiles: vi.fn().mockReturnValue([]),
    });
    const rateLimiter = makePassthroughRateLimiter();

    const result = await getGmailUnreads(authManager, USER_EMAILS, rateLimiter);

    expect(result.summary.totalAccounts).toBe(0);
    expect(result.summary.totalUnread).toBe(0);
    expect(result.errors).toBeDefined();
    expect(result.errors![0]).toContain("No Gmail accounts configured");
  });

  it("GWT: aggregates unreads from single account", async () => {
    const authManager = makeAuthManager();
    const rateLimiter = makePassthroughRateLimiter();

    let fetchCallCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string) => {
        fetchCallCount++;
        const urlStr = typeof url === "string" ? url : "";

        // Profile call
        if (urlStr.includes("/users/me/profile")) {
          return {
            ok: true,
            json: async () => ({ emailAddress: "user@example.com" }),
          };
        }

        // List messages call
        if (urlStr.includes("/users/me/messages?")) {
          return {
            ok: true,
            json: async () => ({
              messages: [
                { id: "msg1", threadId: "t1" },
                { id: "msg2", threadId: "t2" },
              ],
            }),
          };
        }

        // Get message metadata
        if (urlStr.includes("/users/me/messages/msg1")) {
          return {
            ok: true,
            json: async () => ({
              id: "msg1",
              threadId: "t1",
              snippet: "Can you review this?",
              payload: {
                headers: [
                  { name: "From", value: "colleague@work.com" },
                  { name: "To", value: "user@example.com" },
                  { name: "Cc", value: "" },
                  { name: "Subject", value: "PR review needed" },
                  { name: "Date", value: "Sat, 5 Apr 2026 10:00:00 +0200" },
                ],
              },
            }),
          };
        }

        if (urlStr.includes("/users/me/messages/msg2")) {
          return {
            ok: true,
            json: async () => ({
              id: "msg2",
              threadId: "t2",
              snippet: "Your build passed",
              payload: {
                headers: [
                  { name: "From", value: "notifications@github.com" },
                  { name: "To", value: "user@example.com" },
                  { name: "Cc", value: "" },
                  { name: "Subject", value: "[repo] CI passed" },
                  { name: "Date", value: "Sat, 5 Apr 2026 09:00:00 +0200" },
                ],
              },
            }),
          };
        }

        return { ok: false, text: async () => "Not Found" };
      }),
    );

    try {
      const result = await getGmailUnreads(authManager, USER_EMAILS, rateLimiter);

      expect(result.summary.totalAccounts).toBe(1);
      expect(result.summary.totalUnread).toBe(2);
      expect(result.summary.actionRequired).toBe(1);
      expect(result.summary.automated).toBe(1);
      expect(result.categories.action_required).toHaveLength(1);
      expect(result.categories.action_required[0]!.subject).toBe("PR review needed");
      expect(result.categories.automated.count).toBe(1);
      expect(result.accounts).toEqual(["user@example.com"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("GWT: handles account errors gracefully", async () => {
    const authManager = makeAuthManager({
      listProfiles: vi.fn().mockReturnValue(["p1", "p2"]),
      getAccessTokenForProfile: vi.fn()
        .mockResolvedValueOnce({ token: "good-token", profileId: "p1" })
        .mockRejectedValueOnce(new Error("Token refresh failed")),
    });
    const rateLimiter = makePassthroughRateLimiter();

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string) => {
        const urlStr = typeof url === "string" ? url : "";
        if (urlStr.includes("/users/me/profile")) {
          return { ok: true, json: async () => ({ emailAddress: "user@example.com" }) };
        }
        if (urlStr.includes("/users/me/messages?")) {
          return { ok: true, json: async () => ({ messages: [] }) };
        }
        return { ok: false, text: async () => "Not Found" };
      }),
    );

    try {
      const result = await getGmailUnreads(authManager, USER_EMAILS, rateLimiter);

      expect(result.summary.totalAccounts).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors![0]).toContain("p2");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ---------------------------------------------------------------------------
// GET /gmail/unreads route integration test
// ---------------------------------------------------------------------------

describe("GET /gmail/unreads route", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("GWT: returns categorized unreads via HTTP", async () => {
    const port = nextPort();
    const server = createIntegApiServer({ bind: "127.0.0.1", port });
    const authManager = makeAuthManager();
    const rateLimiter = makePassthroughRateLimiter();

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string) => {
        const urlStr = typeof url === "string" ? url : "";
        if (urlStr.includes("/users/me/profile")) {
          return { ok: true, json: async () => ({ emailAddress: "user@example.com" }) };
        }
        if (urlStr.includes("/users/me/messages?")) {
          return {
            ok: true,
            json: async () => ({
              messages: [{ id: "msg1", threadId: "t1" }],
            }),
          };
        }
        if (urlStr.includes("/users/me/messages/msg1")) {
          return {
            ok: true,
            json: async () => ({
              id: "msg1",
              threadId: "t1",
              snippet: "Please review",
              payload: {
                headers: [
                  { name: "From", value: "boss@company.com" },
                  { name: "To", value: "user@example.com" },
                  { name: "Cc", value: "" },
                  { name: "Subject", value: "Urgent: Review needed" },
                  { name: "Date", value: "Sat, 5 Apr 2026 10:00:00 +0200" },
                ],
              },
            }),
          };
        }
        return { ok: false, text: async () => "Not Found" };
      }),
    );

    registerGmailRoutes(server.router, authManager, rateLimiter, USER_EMAILS);
    await server.start();

    try {
      const res = await request(port, "GET", "/gmail/unreads");
      expect(res.status).toBe(200);

      const body = res.body as {
        categories: { action_required: Array<{ subject: string }> };
        summary: { totalUnread: number; actionRequired: number };
      };
      expect(body.summary.totalUnread).toBe(1);
      expect(body.summary.actionRequired).toBe(1);
      expect(body.categories.action_required[0]!.subject).toBe("Urgent: Review needed");
    } finally {
      await server.stop();
      vi.unstubAllGlobals();
    }
  });
});
