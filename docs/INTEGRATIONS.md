# Integrations

Every integration is a port with at least two implementations: the real one, and an
in-memory one that honours the same contract. The in-memory versions are not stubs — they
implement idempotency and deduplication too, because a behaviour that is only correct
against a mock was never tested.

## Google Calendar

### Why a service account

Domain-wide delegation, not per-user OAuth. A dispatch calendar belongs to the business,
not to whoever happened to click "allow" — and there are no refresh tokens to babysit or
re-consent screens when someone leaves.

### Setup

1. Google Cloud Console → new project → enable the Google Calendar API.
2. Create a service account, then create a JSON key for it.
3. Google Workspace Admin → Security → API controls → **Domain-wide delegation**. Add the
   service account's client ID with scope `https://www.googleapis.com/auth/calendar`.
4. Environment:

```bash
GOOGLE_CLIENT_EMAIL=dispatch-agent@your-project.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\n"
GOOGLE_IMPERSONATE_SUBJECT=dispatch@your-company.com
DISPATCH_CALENDAR_ID=dispatch@your-company.com
```

Paste the private key with literal `\n` escapes. Vercel's environment UI flattens real
newlines, so the adapter unescapes them at construction — which is also why a key pasted
with real newlines into a `.env` file works fine locally and fails on deploy.

### Idempotency

Google lets the client choose the event id, so the adapter derives one deterministically
from the booking's idempotency key (`${sessionId}:${slotId}`). A retried create returns
409, which the adapter treats as success and reads the existing event back.

This is the layer that catches the case the tool-level check cannot see: a network retry
where the first request actually succeeded and we never got the response.

### When it fails

`CalendarError` carries a `retryable` flag — true for 403 (rate limit), 429 and 5xx.

More importantly, `book_appointment` catches the failure and **keeps the booking anyway**.
Dispatch is paged at high priority with the customer, window, address and error, and the
caller keeps their slot. Losing a job to protect a database row would be the wrong trade
for the business.

## Telegram

### Setup

1. Message `@BotFather`, `/newbot`, keep the token.
2. Add the bot to each group you want alerts in.
3. Get each chat id from `https://api.telegram.org/bot<TOKEN>/getUpdates` after posting a
   message in the group. Group ids are negative.

```bash
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
TELEGRAM_DISPATCH_CHAT_ID=-1001234567890
TELEGRAM_ONCALL_CHAT_ID=-1009876543210      # optional, falls back to dispatch
TELEGRAM_SALES_CHAT_ID=                     # optional
TELEGRAM_MANAGEMENT_CHAT_ID=                # optional
```

### Routing

Four channels — `dispatch`, `on_call`, `sales`, `management` — each mapping to a chat.
Unmapped channels fall back to `dispatch`, so a partially configured deployment still
delivers rather than dropping alerts on the floor.

`priority: "low"` sends with `disable_notification`, so routine traffic does not buzz
everyone's phone at 2am. Emergencies always notify.

## Slack

Incoming webhooks, one per routing channel.

```bash
SLACK_DISPATCH_WEBHOOK_URL=https://hooks.slack.com/services/T00/B00/xxx
SLACK_ONCALL_WEBHOOK_URL=                   # optional, falls back to dispatch
```

Rendered as Block Kit: a header, the body, and a two-column field block. The plain-text
`text` field is filled in too, because that is what appears in the notification and on
mobile lock screens.

## Fan-out and failure

Configure both Telegram and Slack and `FanOutMessaging` sends to both. It succeeds if
**any** transport delivers, and records the others' failures.

Above that, `safeNotify` in `tools.ts` swallows the error entirely and writes
`FAILED <priority>: <title>` onto the call record. A messenger outage must never abort a
booking that is already on the calendar, and the caller must never hear about it.

The one exception is the auto-escalation alert in `forceEscalate`, which is awaited rather
than fired and forgotten. On a serverless runtime a dangling promise is an alert that
silently never arrives — and that is the alert that matters most, because by then the
agent has already failed and a human needs to pick up.

## CRM

`CustomerRepository` is the seam. It is seeded in-memory here; in a real deployment it is
a ServiceTitan, Housecall Pro or Jobber adapter behind the same four methods:

```ts
findByPhone(phone: string): Customer | null
findById(id: string): Customer | null
upsert(input): Customer
warrantyCover(customer, symptomId, now): { covered: boolean; until?: string }
```

Phone numbers are normalised to digits with the US country code stripped, so
`(415) 555-0142`, `+1 415 555 0142` and `415.555.0142` are the same customer.

`warrantyCover` is the one with teeth: it is why a caller reporting the same fault we
repaired last month is told there is no charge, rather than being quoted for it again.
Getting that wrong does not throw an error — it just quietly overcharges a loyal customer,
which is why there is a dedicated eval scenario for it.

## Adding an integration

1. Define the port in `src/lib/integrations/<name>/port.ts`.
2. Write the in-memory implementation first, and a contract test both implementations
   must pass.
3. Write the real adapter. Decide explicitly which errors are retryable.
4. Add a `fromEnv()` factory returning `null` when credentials are absent.
5. Wire it into `wireFromEnv()` in `session.ts`, and add it to the health endpoint so the
   console badge tells the truth about it.

Step 5 is the one people skip. A deployment that silently falls back to a mock and does
not say so is how a shop discovers on Monday that Friday's bookings went nowhere.
