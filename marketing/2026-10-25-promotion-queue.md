# MurMur promotion queue — 2026-10-25

## Status
- Product/code unchanged.
- Public landing checked: `https://murmurchat.org/` → HTTP 200.
- Blog checked: `https://murmurchat.org/blog/` → HTTP 200.
- No external publication made in this block: authorized browser/CDP unavailable.

## Priority order
1. Indie Hackers: finish account warm-up; check whether original-post gate is lifted. If still blocked, add one thoughtful comment only, no link.
2. Hacker News: one relevant comment from `murmur-app` in a fresh privacy/messaging thread; no product link until karma/age improves.
3. Intent replies: Reddit/TG threads where someone explicitly asks for chat without a phone number, temporary contact, or sharing a number with a stranger. One useful answer, then optional link.
4. Skip broadcast posts for now: LinkedIn, X, Bluesky, generic privacy/crypto groups.

## IH original post (publish only after gate opens)
Title: I built a messenger that deletes your messages from the server after delivery

I wanted private chat that doesn't require handing over a phone number. Signal, WhatsApp, and Telegram all tie identity to a phone number, so I built MurMur: a browser-based messenger with no phone, email, or account. Your identity is a keypair generated on your device.

What didn't work:
- The first version kept ciphertext on the relay. People asked whether the relay could eventually read everything. They were right. Now ciphertext is deleted within a few minutes after delivery.
- I posted in Telegram groups about VPN configs and internet blocks. Wrong audience: they wanted configs, not a messenger.
- I tried Show HN too early with a fresh account and got flagged. The lesson was to warm up the account first.

What worked:
- An honest Reddit exchange about why impersonation requires the private key, not just the public key. Only a few upvotes, but it improved how I explain the model.
- AlternativeTo accepted the free listing into its queue.

Reality check: almost zero users so far. Solo dev, no funding, no growth hacks. I am building it slowly and recording what actually happens.

Try it: https://murmurchat.org/ — opens in the browser, no signup wall.

## Rule
Do not claim user numbers, security audit, or guarantees that are not verified. Do not mass-post or repeat the same text across communities.
