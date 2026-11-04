# MurMur iOS — сборка без Rust на Mac

Rust-ядро собирается в облаке (GitHub Actions, macOS-раннер), ты качаешь готовый
`XCFramework`. **Rust на Mac не нужен.**

## 1. Забрать код (один раз)

```bash
git clone https://github.com/Oleg2796996/murmur.git ~/murmur
cd ~/murmur
git checkout pushfix-v160y22
```

## 2. Собрать XCFramework в облаке

Открой в браузере:

```
https://github.com/Oleg2796996/murmur/actions/workflows/ios-xcframework.yml
```

Нажми **Run workflow** → ветка `pushfix-v160y22` → **Run**.

Ждать ~10–15 минут (первый раз дольше). Зелёная галочка = сборка удалась.

## 3. Скачать готовое

Внизу страницы завершённого запуска, раздел **Artifacts**:

| Артефакт | Что это |
|---|---|
| `MurmurUniffi.xcframework` | Rust-ядро, готовое для iOS |
| `MurmurApp-xcodeproj` | сгенерированный Xcode-проект |

Скачай оба (zip), распакуй.

## 4. Разложить по местам

```bash
cd ~/murmur

# XCFramework -> в ios/MurmurKit/
rm -rf ios/MurmurKit/MurmurUniffi.xcframework
cp -R ~/Downloads/MurmurUniffi.xcframework ios/MurmurKit/

# проект -> в ios/
cp -R ~/Downloads/MurmurApp.xcodeproj ios/
```

## 5. Открыть и запустить

```bash
open ~/murmur/ios/MurmurApp.xcodeproj
```

В Xcode: таргет **MurmurApp** → Signing & Capabilities → выбрать свою команду
(аккаунт Казахстан). Bundle id `org.murmurchat.app`.

Выбрать симулятор → ⌘R.

---

## Альтернатива: собрать локально (если поставишь Rust)

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"
cd ~/murmur
./ios/build-xcframework.sh
cd ios && xcodegen generate && open MurmurApp.xcodeproj
```

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

Симулятор: чаты и отправка работают. Push и звонки — только на устройстве,
после реализации APNs.

## Если сборка в облаке упала

Пришли ссылку на упавший запуск или лог шага. Правлю на HP, пушу, перезапускаем.
