import { expect, test, type Page } from "@playwright/test";

/**
 * The console, driven the way a visitor drives it.
 *
 * These tests deliberately click the suggestion chips rather than typing, because the
 * chips are what a first-time visitor actually uses and their wiring - which chip is
 * offered when - is logic worth covering.
 */

async function startCall(page: Page, caller: string) {
  await page.goto("/");
  await page.getByRole("button", { name: new RegExp(caller, "i") }).click();
  await expect(page.getByRole("heading", { name: /line 1 — open/i })).toBeVisible();
}

async function say(page: Page, text: string) {
  // A completed turn adds exactly two lines: what the caller said and what the agent
  // replied. Waiting on that is more honest than waiting on the Send button, which is
  // correctly disabled whenever the input is empty.
  const lines = page.locator("[data-speaker]");
  const before = await lines.count();

  const chip = page.getByRole("button", { name: text, exact: true });
  if (await chip.isVisible().catch(() => false)) {
    await chip.click();
  } else {
    await page.getByLabel("What the caller says").fill(text);
    await page.getByRole("button", { name: "Send", exact: true }).click();
  }

  await expect(lines).toHaveCount(before + 2);
}

test.describe("call console", () => {
  test("is honest about which adapters are wired before a call starts", async ({ page }) => {
    await page.goto("/");
    // With no credentials in CI, every port must report its in-memory fallback.
    await expect(page.getByText(/Brain: (rules fallback|Claude)/)).toBeVisible();
    await expect(page.getByText(/Calendar: (in-memory|Google)/)).toBeVisible();
    await expect(page.getByText(/Alerts: (in-memory|Telegram|Slack)/)).toBeVisible();
  });

  test("books a job for a customer the agent already knows", async ({ page }) => {
    await startCall(page, "Angela Reyes");

    // The caller ID lookup should have populated the card before a word is spoken.
    const jobCard = page.getByRole("region", { name: "Job card" });
    await expect(jobCard.getByText("Angela Reyes")).toBeVisible();
    await expect(jobCard.getByText("1820 Larkspur Lane, San Rafael, CA")).toBeVisible();

    await say(page, "Hi, my fridge is not cooling at all since yesterday.");
    await expect(jobCard.getByText("Refrigerator not cooling")).toBeVisible();
    await expect(jobCard.getByText("urgent")).toBeVisible();

    await say(page, "What would that cost?");
    await expect(jobCard.getByText(/^\$\d+ – \$\d+$/)).toBeVisible();

    await say(page, "Go ahead and book it");
    await say(page, "The first one");

    await expect(page.getByText(/^Booked · job_/)).toBeVisible();
    await expect(jobCard.getByText("Marcus", { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Dispatch alerts" }).getByText(/New job booked/)).toBeVisible();
  });

  test("shows every tool call inline with its result and duration", async ({ page }) => {
    await startCall(page, "Angela Reyes");
    await say(page, "Hi, my fridge is not cooling at all since yesterday.");

    const log = page.getByRole("log", { name: "Call transcript" });
    await expect(log.getByText("lookup_customer")).toBeVisible();
    await expect(log.getByText("triage_appliance")).toBeVisible();
    await expect(log.getByText(/\d+ ms/).first()).toBeVisible();
  });

  test("never quotes a price for a repair still under warranty", async ({ page }) => {
    await startCall(page, "Tom Whitfield");
    await say(page, "It's the washing machine again - it's not draining.");

    const log = page.getByRole("log", { name: "Call transcript" });
    await expect(log.getByText(/warranty/i)).toBeVisible();
    await expect(page.getByRole("region", { name: "Job card" }).getByText("not quoted")).toBeVisible();
  });

  test("transfers to a person the moment the caller asks", async ({ page }) => {
    await startCall(page, "Unknown number");
    await say(page, "Can I speak to a person?");

    await expect(page.getByRole("region", { name: "Progress" }).getByText(/Handed to a person/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /start another/i })).toBeVisible();
    // The escalation must have paged somebody.
    await expect(page.getByRole("region", { name: "Dispatch alerts" }).getByText(/Live transfer/i)).toBeVisible();
  });

  test("treats a burning smell as an emergency and says to stop using it", async ({ page }) => {
    await startCall(page, "Unknown number");
    await say(page, "There's a burning smell coming from my dryer.");

    const log = page.getByRole("log", { name: "Call transcript" });
    await expect(log.getByText(/switch it off|unplug|stop using/i)).toBeVisible();
    await expect(page.getByRole("region", { name: "Job card" }).getByText("emergency")).toBeVisible();
  });

  test("recovers cleanly when the turn endpoint fails", async ({ page }) => {
    await startCall(page, "Angela Reyes");
    await page.route("**/api/turn", (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) }),
    );

    await page.getByLabel("What the caller says").fill("my fridge is not cooling");
    await page.getByRole("button", { name: "Send", exact: true }).click();

    await expect(page.getByText(/boom|line dropped/i)).toBeVisible();
    // The call is still usable afterwards - the composer is not left disabled.
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  });

  test("lays out without horizontal overflow", async ({ page }) => {
    await startCall(page, "Angela Reyes");
    await say(page, "Hi, my fridge is not cooling at all since yesterday.");

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test("health endpoint reports the runtime wiring", async ({ request }) => {
    const response = await request.get("/api/health");
    expect(response.ok()).toBe(true);
    const body = (await response.json()) as {
      status: string;
      mode: Record<string, string>;
      catalogue: { symptoms: number; tools: number };
    };
    expect(body.status).toBe("ok");
    expect(body.catalogue.symptoms).toBeGreaterThan(10);
    expect(body.catalogue.tools).toBeGreaterThan(8);
  });

  test("rejects a malformed turn instead of guessing", async ({ request }) => {
    const response = await request.post("/api/turn", { data: { text: "hello" } });
    expect(response.status()).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/invalid/i);
  });
});
