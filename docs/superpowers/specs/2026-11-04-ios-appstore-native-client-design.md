# MurMur iOS — нативный клиент для App Store (v1.0)

Дата: 2026-11-04. Статус: утверждена Олегом по секциям 1–2 в чате; секции 3–6
формализуют озвученные в чате решения (всё сразу, группы не делаем, UI-паритет,
TTL-принцип).

## Решения, зафиксированные Олегом

1. **Вариант Б** — полностью нативное iOS-приложение. Обёртки (Capacitor и т.п.)
   не рассматриваются. Нативный = настоящий Swift/SwiftUI UI + нативные
   интеграции; крипто-ядро остаётся Rust через UniFFI (вариант Б1, одобрен).
2. **Scope v1.0 «всё сразу»**: 1:1 чаты + APNs-пуши + звонки
   (PushKit/CallKit) + импорт идентичности. Группы НЕ в v1.0 (в PWA их
   пользовательски нет; модалка в коде не считается).
3. **UI-паритет**: iOS выглядит и ведёт себя как PWA (та же компоновка, стили,
   поведение), реализовано в SwiftUI.
4. **Принцип приватности сохраняется**: релей хранит шифрованное тело только
   до доставки (TTL-cleanup), APNs-пуши без контента.
5. Apple Developer Account: индивидуальный, страна Казахстан (тот же, что
   CatTrack). Приложение бесплатное (монетизация — позже по пользователям).
6. **Совместимость**: PWA-клиенты ↔ iOS-клиенты переписываются через тот же
   релей; крипта бит-в-бит совместима (один и тот же Rust-код `murmur-id`).

## Секция 1. Общая архитектура

```
┌─────────────────────────────────────┐
│           MurmurApp (Swift)         │
│  SwiftUI UI: список чатов, чат,     │
│  звонок (CallKit), настройки        │
├─────────────────────────────────────┤
│  Нативные интеграции (Swift):       │
│  • APNs (device token, пуш-хендлы)  │
│  • PushKit + CallKit (звонки)       │
│  • Keychain (секретный ключ)        │
│  • Local storage (SwiftData/SQLite) │
├─────────────────────────────────────┤
│  murmur-uniffi (Rust → Swift):      │
│  identity, npub, ECIES encrypt/     │
│  decrypt, подписи, postcard-конверты│
├─────────────────────────────────────┤
│  Сеть (Swift): WebSocket к релею    │
└─────────────────────────────────────┘
              ↕ WSS/HTTPS
        murmur-relay (существующий
        + APNs-модуль, секция 3)
```

- Новый каталог `ios/` в репо + новый крейт `crates/murmur-uniffi`.
- Секретный ключ — **Keychain** (`kSecAttrAccessibleAfterFirstUnlock` — доступен
  для фоновой обработки пушей).
- Локальное хранилище — SwiftData: чаты, сообщения, acks, outbox (модель по
  образцу `pwa/app-store.js`: kv, chats, outbox, acks). Нет проблемы IDB-эвикиций.
- WebSocket — `URLSessionWebSocketTask`, reconnect с бэкоффом
  (1s base / 60s max — параметры из PWA `app.js`).
- Rust-ядро — статический XCFramework (device aarch64-apple-ios + simulator),
  подключается в Xcode. Сборка на MacBook Олега.
- НЕ в v1.0: группы, экспорт `.murmur` из iOS (только импорт), Android, десктоп.

## Секция 2. Модуль murmur-uniffi (Rust → Swift)

Новый крейт `crates/murmur-uniffi` — тонкая обёртка над `murmur-id`
(UniFFI 0.28+, proc-macros), никакого секрета в Swift-байтах: `Identity` живёт
в Rust (Arc<Mutex>), Swift получает npub и результаты операций; zeroize-on-drop
уже есть в murmur-id.

Экспорт (маппинг на реальные функции `murmur-id` 0.1.0):

| UniFFI API | Реализация в murmur-id |
|---|---|
| `identity_new() -> NpubInfo` | `Identity::generate(OsRng)` → `public().npub()` |
| `identity_restore_hex(sk_hex) -> NpubInfo` | `Identity::from_bytes` (64-hex секретный ключ — формат `murmur.sk` PWA) |
| `npub_of(identity) -> String` | `IdentityPublic::npub()` |
| `sign_message(identity, msg) -> Vec<u8>` | `Identity::sign` (ed25519, 64 байта) |
| `verify_message(sender_npub, sig, msg) -> bool` | `IdentityPublic::from_npub` + `verify` |
| `ecies_encrypt(recipient_npub, plaintext) -> Sealed` | `Identity::ecies_encrypt(OsRng, recipient_public, pt)` |
| `ecies_decrypt(sealed) -> Vec<u8>` | `Identity::ecies_decrypt(ephemeral_pubkey, nonce, ct)` |
| `seal_pack(sealed) -> Vec<u8>` / `seal_unpack` | postcard-сериализация `SealedEnvelope` (wire-формат) |

- **Golden-тесты совместимости** (обязательные, в крее): байт-в-байт векторы —
  конверт, зашифрованный через `pwa/pkg/murmur_id_wasm` (тот же crate), обязан
  расшифровываться uniffi-обёрткой и наоборот; `identity_restore_hex(hex)` от
  hex-ключа PWA обязан давать тот же npub.
- Импорт `.murmur`: парсинг в Rust (формат `pwa/backup.js`: JSON
  `{magic:"MURMURBAK1", v:1, kdf:"PBKDF2-SHA256", iterations:250000, salt,
  iv, data}`; payload AES-256-GCM, внутри JSON с `ls["murmur.sk"]` — 64-hex
  секретный ключ, имя, контакты). UniFFI API: `backup_parse(raw, password) ->
  BackupIdentity { sk_hex, npub, name, contact_names }`. PBKDF2-SHA256 +
  AES-GCM-decrypt в Rust (крейты pbkdf2/aes-gcm уже в дереве зависимостей).
- Сборка: `cargo build -p murmur-uniffi --target aarch64-apple-ios` (+simulator
  slice) → XCFramework → Xcode. Генерация Swift-биндингов: `uniffi-bindgen
  generate` в `ios/MurmurKit/`.

## Секция 3. Релей: APNs + VoIP-пуши

Релей не переписывается. Новый модуль в `crates/murmur-relay`:

- **Регистрация подписок:** новое WS-сообщение `apns_register { token,
  token_kind: "alert"|"voip", npub, ts, sig }` (подпись ed25519 — как
  `murmur-auth-v1`). Релей хранит `(npub → device tokens)` в своей БД
  (messages.db рядом с существующими таблицами).
- **Токены:** два токена на устройство — обычный (alert) и VoIP (PushKit).
  Релей получает ключ Apple `AuthKey_*.p8` (team id, key id — в toml-конфиге).
- **Отправка:** при доставке конверта подписчику-н_active (WS оффлайн) релей
  шлёт APNs: `POST /3/device/<token>` (HTTP/2, JWT из .p8, crate `aapns` или
  собственный минимальный клиент на hyper — решается при реализации).
  Payload: `{ aps: { alert: "Новое сообщение", badge: n, sound: "default" } }`
  — БЕЗ контента сообщения (принцип 4). Для VoIP-токена: `{ aps:
  { "content-available": 1 }, murmur_call: {...} }`.
- **VoIP-звонки:** `incoming_call` (сигналинг уже в реле) дублируется
  VoIP-пушем с JSON звонка (from_npub, call_id, video/audio).
  PushKit → CallKit → системный UI звонка. Обязательное правило Apple:
  VoIP-пуш обязан поднимать CallKit (иначе репорт/бан) — применяется.
- **TTL/cleanup не меняется:** тела сообщений удаляются при доставке, как
  сейчас; APNs хранит только токены и бейдж-счётчик.
- **Бейджи:** релей ведёт per-npub счётчик недоставленных; сбрасывается
  WS-сообщением `apns_badge_clear` при открытии приложения.

## Секция 4. Звонки (iOS)

- **CallKit-провайдер**: `CXProvider` с конфигурацией (video/audio capable).
  Входящий: PushKit `PKPushRegistry` (VoIP token) → parse payload →
  `CXCallUpdate` → системный экран входящего.
- **Сигналинг**: те же WS-сообщения `incoming_call` / `call_signal` /
  `call_answer` / `call_end` (протокол PWA). Когда WS жив — сигналинг идёт по
  WS; PushKit — только «разбудить и показать входящий».
- **WebRTC**: iOS-клиент поднимает WebRTC-пир нативно. Стек: GoogleWebRTC
  (pod `GoogleWebRTC`) — совместим с браузерным пиром PWA (SDP/ICE стандартные;
  сверить codecs/DTLS при интеграции, тест-план в секции 6).
- **Камера/микрофон**: `AVCaptureSession` через WebRTC factory; Privacy
  Usage Descriptions в Info.plist (NSCameraUsageDescription,
  NSMicrophoneUsageDescription).
- **Фон**: `UIBackgroundModes: voip, remote-notification, audio`. Audio session
  (PlayAndRecord) управляется CallKit; видео — picture-in-picture нативно
  (AVSampleBufferDisplayLayer, без WebKit-багов PiP — ошибка класса 275210 не
  повторяется).

## Секция 5. Импорт идентичности и первый запуск

- Онбординг: три опции — создать новую идентичность / ввести 64-hex ключ
  (`murmur.sk` из PWA: копирование из бэкапа или deep-link) / импорт файла
  `.murmur` (пароль → `backup_parse`).
- После импорта: тот же npub, те же контакты (`contact_names`), имя. История
  чатов из бэкапа восстанавливается в SwiftData (plaintext уже в бэкапе).
- Ключ после парсинга → Keychain; из бэкапа — сразу.
- Контакты в iOS: добавление по npub (вставка/скан QR из PWA invite-link) —
  паритет с PWA (решение Олега: UI-поле new chat убрано 31.08, добавление
  через invite-link). Сверить финальный flow приглашения с текущим PWA
  (deep-link `#invite`) при реализации.

## Секция 6. Тестирование и release

- **Golden-тесты** uniffi (секция 2) — блокируют сборку при несовпадении.
- **E2E-матрица**: PWA(test)↔PWA(test), PWA↔iOS(simulator и device), звонок
  PWA↔iOS, пуш на device (симулятор APNs не доставляет — тестировать на
  реальном iPhone Олега), фон/убитое приложение.
- **TestFlight** → внутренний тест → ревью App Store (обоснование VoIP,
  privacy-декларации: данные не собираются — ключи и сообщения не покидают
  устройство/релей в plaintext).
- **Store assets**: скриншоты с паритетного UI, иконка (2026b-иконка PWA),
  описание (RU/EN, как в лендинге).
- Сборка релиза: Xcode Archive → App Store Connect (аккаунт Казахстан).
- Версионирование: v1.0, билды по Apple-схеме (CFBundleVersion инкремент).

## Риски / открытые вопросы

- GoogleWebRTC pod vs наш SDP/ICE: первичная проверка совместимости звонка
  PWA↔iOS делается ранним спайком (до основного UI) — риск №1.
- APNs ключ .p8: нужен доступ в App Store Connect (аккаунт Олега).
- PushKit в симуляторе не работает — нужен реальный iPhone для пуш-тестов.
- Релей: APNs-модуль трогает код доставки — выкатывать по каноническому
  release-flow: тест → подтверждение Олега → прод.

## Реализационный порядок (план, не часть спеки)

1. `crates/murmur-uniffi` + golden-тесты (cargo test зелёный).
2. Спайк WebRTC PWA↔нативный пир (обоснование протокола звонка).
3. Скелет `ios/`: XCFramework + онбординг + чаты 1:1 + WS.
4. PushKit/CallKit + APNs-модуль релея (тест-контур).
5. Импорт `.murmur` + паритет UI + TestFlight.
