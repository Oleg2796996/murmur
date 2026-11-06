# MurMur promotion pack — 2026-10-26

## Статус каналов

| Канал | Статус | Действие |
|---|---|---|
| GitHub repo metadata | ✅ Сделано: description, homepage=murmurchat.org, topics (e2ee, privacy, pwa, rust, webrtc, self-hosted, nostr, npub, messenger, encryption) | — |
| GitHub visibility | ⚠️ БЛОКЕР: repo **private** — Show HN / awesome-lists / Reddit-ссылки на код невозможны | Решение Олега: сделать публичным |
| Show HN | 📝 Черновик готов | Публиковать после (а) публичного репо ИЛИ (б) постить только сайт |
| Reddit r/privacy, r/selfhosted, r/privacytoolsIO, r/fossdroid | 📝 Черновик готов | Сабмит от имени Олега (аккаунт нужен его) |
| alternativeto.net | 📝 Черновик готов | Сабмит вручную браузером |
| F-Droid | ⏳ Требует: репо публичное + сборка подписи; долгий трек | Задача на потом |
| awesome-telegram (ebertti 6.1k★, DenisIzmaylov 602★) | 📝 PR-черновик готов | PR возможен только из публичного репо |

## Черновик Show HN

**Title:** Show HN: MurMur — E2EE messenger PWA, no phone number, identity is a key

**Text:**
Hi HN! MurMur (https://murmurchat.org) is a privacy-first messenger that installs as a PWA — no app store, no registration.

- Identity is an npub cryptographic key pair; the private key never leaves your device. No phone, no email, no accounts database. Lose the key = lose the account (export a .murmur backup file).
- Messages and calls (WebRTC, camera+mic) are end-to-end encrypted.
- The relay is a small Rust server: it stores only encrypted messages and deletes them shortly after delivery, seeing minimal metadata.
- Contacts are added via plain https invite links containing your npub.
- Push notifications work on iOS and Android once installed.

Why PWA: it lets people try a messenger without trusting an app-store binary or handing over a phone number — install from the site in two taps (Safari → Share → Add to Home Screen; Chrome → Install).

Stack: vanilla JS frontend, Rust relay (crates: relay, identity, transport, cold storage). Code: https://github.com/Oleg2796996/murmur

Known trade-offs we'd love feedback on: key recovery UX (no SMS by design), relay trust model, iOS PWA quirks (WebRTC/PiP bugs we fought: bugzilla 229792/240604/241789).

## Черновик Reddit r/privacy (value-first)

**Title:** I built a messenger with no phone number and no accounts — your identity is a cryptographic key

Body: короткая история зачем (телефон = де-факто идентификатор слежки), что умеет, ссылка на murmurchat.org, честные trade-offs, приглашение к критике. Без маркетингового тона.

## alternativeto.net

Submit MurMur as alternative to: Telegram, Signal, Session, Threema. Tags: encrypted messaging, pwa, no phone number.

## awesome-telegram PR (ebertti/awesome-telegram)

Add under "Clients / Privacy": `MurMur — privacy-first E2EE messenger PWA, npub identity, Rust relay, no phone number — https://murmurchat.org (+ repo link)`.

## Очередность (моя рекомендация)
1. Олег решает: публичный репо? (yes/no/позже)
2. Если да → Show HN в вт-ср 08:00-10:00 MSK (пик HN-трафика), PR в awesome-telegram.
3. Reddit — после первых органических пользователей (чтобы был о чём рассказать: «за неделю N установок»).
4. alternativeto + F-Droid — фоновые задачи.

---
## АКТУАЛИЗАЦИЯ 26.10.2026 21:50 (вечер)

**Состояние:**
- Репо открыт: github.com/Oleg2796996/murmur, AGPL-3.0, README со скриншотами (app-onboarding.png, app-chat.png).
- **Release v0.1.0 создан** (21:48) — снимает блокер «0 релизов».
- **SECURITY FIX v160i2**: path traversal в релее (/pwa//etc/passwd) — найден lissy93, закрыт на обоих контурах (коммит c93676e, бинари md5 716e9754). Секреты через дыру НЕ читались (проверено).
- PR #877 (awesome-privacy) закрыт ревьюером по зрелости; после фикса и релиза оставлен комментарий с просьбой reconsider. Не давить, resubmit позже если откажет.
- PR #401 (awesome-telegram) — OPEN, ждёт ревью.
- Баг /app/ WASM закрыт (a5aea88, prod отдаёт фикс).
- Cron tg-watch восстановлен (lastRun ok).

**Аккаунты:** alternativeto.net — аккаунт ЕСТЬ; Reddit — аккаунт ЕСТЬ (использовать существующие).

**Следующие шаги:**
1. awesome-selfhosted PR (теперь есть релиз — формальный критерий закрыт).
2. Reddit r/privacy + r/selfhosted через существующий аккаунт (читать правила саба, value-first).
3. alternativeto.net — добавить листинг через существующий аккаунт.
4. HN Show HN — после созревания аккаунта.
5. Метрики: считать установки (identity creations) — договориться с Олегом о безликой аналитике.
6. TURN credential ротация — хвост.
