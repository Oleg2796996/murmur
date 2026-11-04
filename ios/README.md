# MurMur iOS — сборка на Mac

Клиент в `ios/MurmurApp/`. Крипто-ядро — Rust (`crates/murmur-uniffi`), то же,
что исполняется в PWA как WASM. Формат конвертов и подписей бит-в-бит совпадает
с PWA, поэтому клиенты взаимозаменяемы на одном релее.

## 1. Получить код

```bash
cd ~/murmur        # или куда ты клонируешь
git pull origin pushfix-v160y22
```

## 2. Собрать XCFramework с Rust-ядром

Нужен Xcode + Rust.

```bash
rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
./ios/build-xcframework.sh
```

Скрипт соберёт три слайса (устройство + симулятор arm64/x86_64), склеит
симуляторные в fat-библиотеку, перегенерирует Swift-биндинги и создаст
`ios/MurmurKit/MurmurUniffi.xcframework`.

## 3. Сгенерировать Xcode-проект

```bash
brew install xcodegen      # если ещё нет
cd ios && xcodegen generate
open MurmurApp.xcodeproj
```

## 4. Подпись

В Xcode: таргет **MurmurApp** → Signing & Capabilities → выбрать свою команду
(аккаунт Казахстан, тот же, что CatTrack). Bundle id: `org.murmurchat.app`
(можно поменять в `ios/project.yml`).

## 5. Запустить

- **Симулятор**: чаты и отправка работают, push и звонки — нет (APNs в
  симуляторе не доставляется, PushKit отсутствует).
- **Устройство**: полный набор после шага с APNs (пока не реализован).

Онбординг: «Создать» — новый npub; «Импортировать ключ» — вставить
`murmur.sk` из PWA; «Файл .murmur» — бэкап + пароль.

## Что уже работает

| Функция | Статус |
|---|---|
| Создание / восстановление идентичности | ✅ Rust + Keychain |
| Импорт `murmur.sk` из PWA (тот же npub) | ✅ проверено тестом |
| Импорт `.murmur` (PBKDF2+AES-GCM) | ✅ Rust, тесты |
| Отправка сообщения (ECIES + подпись) | ✅ совместимо с PWA |
| История из `/api/history` | ✅ |
| WebSocket приём + reconnect | ✅ |
| APNs-пуши | ❌ следующий шаг |
| Звонки (PushKit/CallKit/WebRTC) | ❌ следующий шаг |

## Проверка совместимости (без Mac, на HP)

```bash
cargo test -p murmur-uniffi        # 12 тестов, включая PWA-векторы
./ios/check-bindings.sh            # guard: биндинги реально генерируются
```

## Что сказать мне после теста

Что именно не работает и на каком шаге: сборка / запуск / онбординг / отправка /
приём. Скриншот ошибки Xcode сильно ускоряет.
