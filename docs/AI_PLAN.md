# AI plan (outcomes and policy unresolved)
Built locally: `src/ai.ts` - advisory-only interfaces. Vision provider is DISABLED by default; output is validated; a suggestion never verifies, assigns or scores. Complaint drafting is a deterministic template; recipient comes only from a verified registry record; `sendable` is always false. No model chosen, no external call, no real image leaves the server.

## Vision (damage / severity hint) - options
- Ultralytics YOLO: AGPL-3.0 unless an Enterprise license is bought (https://www.ultralytics.com/license). Fine for a local demo only if AGPL terms are accepted; a hosted citizen app needs a decision.
- Apache-2.0 detectors (RT-DETR https://github.com/lyuwenyu/RT-DETR, YOLOX https://github.com/Megvii-BaseDetection/YOLOX): license-friendlier; code license and pretrained-weight license must be checked separately.
- Training data: RDD2022 road damage dataset is CC BY-SA 4.0 (https://datasetninja.com/road-damage-detector). Share-alike obligations on derived data/weights need a legal read; Indian roads are a subset, so accuracy on local roads is unknown until measured.
- Hosted vision/LLM API: needs account, cost and sending citizen photos to a third party. Not allowed without approval.
Recommendation: run a small open detector locally/self-hosted, fine-tune only after license check, treat output as a hint shown to the reviewing officer.

## Evaluation required before any accuracy claim
Held-out set of real local road photos (consented, no faces/plates), report precision/recall per class, false-positive rate on non-pothole images (shadows, patches, speed breakers), and severity agreement with an officer. No numbers exist yet.

## Complaint assistant / "send to higher authority"
Unresolved: whether this means first routing, or escalation of overdue/unverified issues, and who the audience is. No send path exists. Needs verified recipients, an agreed process, and user authorization. An LLM may only polish wording of the template; it must not choose authority or add facts.

## Free-API route (no paid billing)
Checked 2026-10-29 from provider docs:
- Google Gemini API: free tier exists ("free input & output tokens", limited models, https://ai.google.dev/gemini-api/pricing). On the unpaid quota Google may use submitted content, including images, to improve its products (https://ai.google.dev/gemini-api/terms, "Unpaid Services"). Paid services are not used for training (https://ai.google.dev/gemini-api/docs/zdr). So REAL citizen photos must not go to the free tier. Rate limits are per project and reset at midnight Pacific (https://ai.google.dev/gemini-api/docs/rate-limits). Regions: https://ai.google.dev/gemini-api/docs/available-regions (India not confirmed by me; check before signup). Exact current free model list and quotas not captured.
- OpenRouter ":free" models: no purchase needed, 50 free requests/day without credits (https://openrouter.ai/docs/faq). Free models may log prompts; terms not verified.
- Groq: free tier with rate limits (https://console.groq.com/docs/rate-limits); vision model availability and retention not verified.
Needs a decision: which provider/account and key (kept in a secrets store, never in the repo). Free tier does NOT remove the privacy issue: use synthetic or consented non-personal images only until terms are chosen. Hard no-billing path: do not enable billing on the provider account; verify at signup that the free plan cannot auto-upgrade; the app also stops itself via `guardExternal` (opt-in flag + local daily cap below the provider quota; fail closed on error/429).

### Provider comparison, checked 2026-10-29 (not yet an evaluation)
- Gemini: India is in the supported-regions list (https://ai.google.dev/gemini-api/docs/available-regions). Free tier lists "Free of charge" input/output for text-image models such as gemini-3.8-flash and gemini-3.6-flash (https://ai.google.dev/gemini-api/docs/pricing); per-model free RPD quotas are shown per project in AI Studio, not captured. Free = content may be used to improve Google products; paid = not (terms, zdr pages above). Billing opt-in is a separate step; spend limits only apply once billing is linked.
- Groq: Llama 4 Scout accepts images (https://console.groq.com/docs/model/meta-llama/llama-4-scout-17b-16e-instruct). Data: customer inference data not retained by default, ZDR optional, usage metadata kept (https://console.groq.com/docs/your-data). Free-plan quotas and India availability NOT verified.
- OpenRouter: per-provider logging/training policies, account setting controls routing to training providers (https://openrouter.ai/docs/guides/privacy/provider-logging); :free = 50 req/day without credits (https://openrouter.ai/docs/faq). Free models often run on providers with their own terms.
