# Taking real calls

Three transports. The agent is identical in all three — only the audio path and where the
session lives change.

| | Turn latency | Barge-in | Needs a long-lived process | Cost |
|---|---|---|---|---|
| Twilio `<Gather>` | 1.5–2.5s | No | No | ~$0.013/min + ASR |
| VAPI / Retell | 0.6–1.2s | Yes | No | ~$0.05–0.09/min all-in |
| Twilio Media Streams | 0.4–0.9s | Yes | **Yes** | ~$0.013/min + your own ASR/TTS |

For a repair shop taking twenty calls a day, a hosted platform is the right answer. The
`<Gather>` path is implemented here because it is the one that runs anywhere, costs almost
nothing, and is worth having as a fallback when the platform is down.

---

## 1. Twilio `<Gather>` — implemented

Twilio does the speech recognition, posts the transcript to a webhook, and speaks whatever
TwiML comes back.

```
caller ──▶ Twilio ──POST /api/twilio/voice──▶ CallRunner ──▶ tools
                 ◀──── <Gather><Say>… ───────
```

### Setup

1. Deploy, and set `PUBLIC_BASE_URL` to the deployment's origin.
2. Buy a number in the Twilio console.
3. Voice → **A call comes in** → Webhook → `https://<your-host>/api/twilio/voice`, `HTTP POST`.
4. Set `TWILIO_AUTH_TOKEN` in the environment.
5. If you want warm transfer on escalation, set `TRANSFER_TO_NUMBER` to a number a human
   answers.

### Signature verification is not optional

Without `TWILIO_AUTH_TOKEN` set, the route accepts any POST. Anyone who finds the URL can
then drive the agent: book jobs onto the dispatch calendar, page the on-call team at
emergency priority, and read back your rate card. The check is HMAC-SHA1 over the full
URL concatenated with every POST parameter sorted by key, compared in constant time.

`PUBLIC_BASE_URL` matters here: Twilio signs the URL *it* called, so behind a proxy that
rewrites the host, `request.url` is the wrong string and every signature fails.

### The single-endpoint design

One URL handles the first hit and every subsequent turn, so the Twilio console needs one
field filled in. The route branches on whether a session already exists for the `CallSid`:

- **No session** — connect the call, run the caller-ID lookup, greet.
- **Session, empty `SpeechResult`** — `actionOnEmptyResult="true"` means silence lands
  here. Prompt once with "are you still there?", then let the caller go rather than
  looping forever on an empty line.
- **Session with speech** — a normal turn.

Escalation returns `<Dial>` if a transfer number is configured, otherwise `<Say>` plus
`<Hangup>` with a promise of a callback.

### Tuning

`speechTimeout="2"` is the silence that ends the caller's turn. Shorter feels snappier and
cuts people off mid-thought when they are reading an address off a bill; longer feels
sluggish. Two seconds is a reasonable compromise for a line that collects addresses.

`speechModel="phone_call"` with `enhanced="true"` is materially better on 8 kHz audio and
worth the extra cost — a misheard house number is a wasted truck roll.

### What you give up

No barge-in. Twilio finishes speaking before it starts listening, so a caller who
interrupts is not heard. That is the main thing that makes this feel like an IVR rather
than a person, and it is the reason to move to option 2 or 3 once call volume justifies it.

---

## 2. VAPI or Retell — export provided

The provider owns the audio pipeline and calls your webhook for each tool.

```ts
import { toVapiAssistant } from "@/lib/telephony/provider-config";

const assistant = toVapiAssistant({ webhookBaseUrl: "https://your-host" });
// POST to https://api.vapi.ai/assistant
```

The definition is **generated** from the same `TOOLS` array and the same prompt builder the
agent uses. A tool added to the agent therefore cannot silently go missing from the hosted
deployment, which is the failure this kind of integration usually has.

You would then implement two routes:

- `POST /api/provider/tool` — look up the tool in `TOOLS_BY_NAME`, validate with its zod
  schema, run the handler against a session loaded from `CallStore`, return the result.
- `POST /api/provider/events` — call lifecycle: persist the transcript, record the outcome.

They are not in this repo because they cannot be tested without an account, and an
untested integration in a portfolio repo is worse than an honest gap.

The interesting settings in the export:

- `stopSpeakingPlan.numWords: 2` — cut off after two words of interruption. This is the
  setting that makes the agent feel like a person.
- `startSpeakingPlan.waitSeconds: 0.4` with smart endpointing — long enough not to
  interrupt someone thinking, short enough not to feel dead.
- `chunkPlan.minCharacters: 30` — start speaking before the whole sentence is generated.
  Slightly choppier prosody, noticeably faster first audio.
- `endCallPhrases` — the agent's own sign-offs, so the call ends when it says goodbye.

---

## 3. Twilio Media Streams — documented, not deployed

A bidirectional WebSocket of base64 μ-law frames at 8 kHz, 20ms each.

```
<Response>
  <Connect><Stream url="wss://your-host/media" /></Connect>
</Response>
```

You then own: frame decoding, voice-activity detection, endpointing, streaming ASR,
streaming TTS, and the `clear` message that flushes Twilio's playback buffer when the
caller interrupts. That last one is the whole value — it is what real barge-in is.

It is not deployed here for one reason: it needs a process that stays alive for the
duration of the call, which rules out serverless functions. On Fly, Railway or a container
it is straightforward. The agent core needs no changes at all — the transport writes
caller text into `runner.turn()` and reads the reply back out, exactly as the webhook does.

Notes if you build it:

- Twilio sends `start`, `media`, `mark`, `stop`. Track `streamSid` from `start`; every
  frame you send back needs it.
- Use `mark` messages to know when your audio actually finished playing. Guessing from
  byte counts drifts.
- On barge-in, send `{"event":"clear","streamSid":…}` *before* the new audio, or the
  caller hears the tail of the interrupted sentence.
- μ-law is not linear PCM. Decode before sending to an ASR that expects PCM16.

---

## Choosing

Start with `<Gather>`. It is twenty minutes of setup and it works. Move to a hosted
platform when callers start complaining that it talks over them — that complaint is the
signal, not the call volume. Build Media Streams only if you need something the platforms
will not give you, such as a voice clone they do not host or an on-premise ASR.
