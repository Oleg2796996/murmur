# Draft 03 — How to use an encrypted messenger in a browser (PWA)

## META

**EN**
- Title: How to Use an Encrypted Messenger in Your Browser (PWA)
- Description: MurMur is an E2EE messenger that runs as a PWA. No app store needed — install it from the browser, add contacts by npub, chat and call.
- Slug: encrypted-messenger-in-browser-pwa

**RU**
- Title: Защищённый мессенджер в браузере: как пользоваться PWA
- Description: MurMur — E2EE мессенджер в формате PWA. Без магазинов приложений: устанавливается из браузера, контакты по npub, звонки и пуши.
- Slug: zashchishchyonnyy-messenger-v-brauzere-pwa

---

## EN

# How to Use an Encrypted Messenger in Your Browser (PWA)

Most people assume a "real" messenger has to come from an app store. You open the App Store or Google Play, tap Install, wait, done. But there's another way that works just as well: a PWA — a Progressive Web App. It's a regular website that behaves like a native app once you install it.

MurMur, an end-to-end encrypted messenger, works exactly this way. You open https://murmurchat.org in your browser, add it to your home screen, and from that moment it looks and feels like a normal app — with its own icon, push notifications, and offline support.

Here's what a PWA actually is, why it's a perfectly normal way to run a messenger, and how to get started with MurMur in about two minutes.

## What is a PWA, and why a messenger without an app store is normal

A PWA is a web application that the browser can "install" locally. After installation you get three things that used to be exclusive to native apps:

- **A home screen icon.** The app launches in its own window, without browser bars, just like any installed app.
- **Push notifications.** New messages arrive on the lock screen, even when the app is closed.
- **Offline cache.** The app starts without a network connection and shows your locally stored conversations.

So why build a messenger this way instead of shipping it through app stores?

**No gatekeepers.** You don't need an account with Apple or Google to install MurMur. The app comes straight from its own website. That also means no app-store review delays when updates ship — the version you get is always current.

**Works the same on iPhone and Android.** PWA support is built into both platforms. One codebase, same experience.

**Less metadata.** You don't hand your phone number or email to anyone to create an account. MurMur identifies you by an npub — a public key — not by your SIM card.

A messenger being a website doesn't make it less secure. Encryption has nothing to do with where the app comes from. MurMur encrypts messages end-to-end regardless of how you installed it.

## Getting started with MurMur, step by step

The whole setup takes a couple of minutes. No phone number, no email, no registration form.

### Step 1: Open the site

In Safari (iPhone) or Chrome (Android), go to **https://murmurchat.org**.

On desktop it works too — Chrome, Edge, and Firefox all support the install flow or just run the app in a tab.

### Step 2: Install it to your home screen

- **iPhone (Safari):** tap the Share button, then "Add to Home Screen."
- **Android (Chrome):** open the browser menu (three dots) and choose "Install app" or "Add to Home Screen."

Now MurMur has its own icon and opens full-screen, like any other app.

### Step 3: Create your key

On first launch, MurMur generates your key pair. Your public key is your identity — it starts with `npub1...` and looks like a long random string. That's what you share with people. Your private key stays on your device.

There's no phone number involved. Nobody can find you by your contacts list; people can only reach you if you give them your npub.

### Step 4: Add contacts by npub

To start a chat, you need the other person's npub. Exchange keys with your contact — in person, through another channel, whatever works. Paste their npub into MurMur, and the conversation appears.

Everything you send is encrypted on your device and decrypted only on theirs.

### Step 5: Chat, call, get notifications

From here it works like any messenger: text messages, voice calls, push notifications for new messages. Calls and messages are end-to-end encrypted.

## What the server can see

MurMur uses a relay — a Rust-based server in Europe — to pass messages between users. What does it actually see?

**Not your messages.** The relay receives ciphertext. Without your private key, the encrypted traffic is unreadable — the relay never sees plaintext.

**Minimal metadata.** The relay necessarily knows things like "an encrypted message went from A to B at this time." That's the minimum any transport needs to function. It does not know who you are in real life, because accounts aren't tied to phone numbers or email.

The relay code is open source — you can review it at github.com/Oleg2796996/murmur. The whole project is open, and that's deliberate: trust should come from code you can inspect, not from promises.

## FAQ

**Is a browser messenger safe?**
Yes, if it encrypts end-to-end — and MurMur does. The browser is just the runtime; encryption happens on your device before anything leaves it. The bigger question with any messenger is who holds the keys, and with E2EE the answer is: only you and your contact.

**Does it work offline?**
The app itself does. Thanks to the offline cache it opens without a network and shows your locally stored chats. Obviously, sending and receiving new messages requires a connection — that's true for every messenger.

**Where are my messages stored?**
On your device, locally in the browser's storage. The relay also holds encrypted copies for a limited time — long enough to deliver them if you're offline — and then they're gone. The server never has readable text.

**What happens if I clear my browser data?**
You lose your locally stored conversations and your key. Clearing site data is the browser equivalent of uninstalling plus wiping the app — there's no copy on the server to restore from. So before clearing data or switching devices, make sure you have your key backed up where the app offers it.

**Do I need to install anything from an app store?**
No. MurMur installs directly from https://murmurchat.org as a PWA, on both iPhone and Android, without the App Store or Google Play.

## Try it

Open **https://murmurchat.org**, add it to your home screen, create your key, and share your npub with one person you want to talk to privately. That's the whole onboarding. The code is public at github.com/Oleg2796996/murmur — read it, question it, or just use it.

MurMur is a young project, evolving fast. If you want an encrypted messenger that doesn't ask for your phone number and doesn't live in an app store, this is a straightforward way to have one.

---

## RU

# Как пользоваться защищённым мессенджером в браузере (PWA)

Многие уверены: «настоящий» мессенджер обязан ставиться из магазина приложений. Открыл App Store или Google Play, нажал «Установить», подождал — готово. Но есть другой способ, который работает не хуже: PWA — прогрессивное веб-приложение. Это обычный сайт, который после установки ведёт себя как нативное приложение.

MurMur — мессенджер со сквозным шифрованием — работает именно так. Открываете https://murmurchat.org в браузере, добавляете на домашний экран — и дальше это выглядит и ощущается как обычное приложение: своя иконка, пуш-уведомления, работа офлайн.

Расскажем, что такое PWA, почему мессенджер без магазина приложений — это нормально, и как начать пользоваться MurMur за пару минут.

## Что такое PWA и почему мессенджер без магазина приложений — это нормально

PWA — это веб-приложение, которое браузер может «установить» локально. После установки вы получаете три вещи, которые раньше были доступны только нативным приложениям:

- **Иконку на домашнем экране.** Приложение запускается в отдельном окне, без адресной строки и вкладок — как любое установленное приложение.
- **Пуш-уведомления.** Новые сообщения приходят на экран блокировки, даже когда приложение закрыто.
- **Офлайн-кэш.** Приложение запускается без интернета и показывает локально сохранённые переписки.

Зачем делать мессенджер так, а не через магазины приложений?

**Никаких посредников.** Чтобы установить MurMur, не нужен аккаунт Apple или Google. Приложение скачивается прямо с собственного сайта. И обновления не ждут проверки в магазине — вы всегда получаете актуальную версию.

**Одинаково работает на iPhone и Android.** Поддержка PWA встроена в обе платформы. Один код — одинаковый опыт.

**Меньше метаданных.** Для создания аккаунта не нужны номер телефона или почта. MurMur идентифицирует вас по npub — публичному ключу, а не по SIM-карте.

То, что мессенджер — это сайт, не делает его менее защищённым. Шифрование не зависит от того, откуда установлено приложение. MurMur шифрует сообщения сквозным образом в любом случае.

## Как начать пользоваться MurMur: пошагово

Вся настройка занимает пару минут. Без номера телефона, без почты, без регистрационных форм.

### Шаг 1. Откройте сайт

В Safari (iPhone) или Chrome (Android) перейдите на **https://murmurchat.org**.

На компьютере тоже работает — Chrome, Edge и Firefox поддерживают установку или просто запускают приложение во вкладке.

### Шаг 2. Установите на домашний экран

- **iPhone (Safari):** нажмите кнопку «Поделиться», затем «На экран “Домой”».
- **Android (Chrome):** откройте меню браузера (три точки) и выберите «Установить приложение» или «Добавить на главный экран».

Теперь у MurMur своя иконка, и он открывается на весь экран, как любое другое приложение.

### Шаг 3. Создайте ключ

При первом запуске MurMur генерирует вашу пару ключей. Публичный ключ — ваша идентификация: он начинается с `npub1...` и выглядит как длинная случайная строка. Его вы и даёте людям. Приватный ключ остаётся на вашем устройстве.

Номер телефона не нужен. Вас не найдут по списку контактов — написать вам сможет только тот, кому вы дали свой npub.

### Шаг 4. Добавьте контакты по npub

Чтобы начать чат, нужен npub собеседника. Обменяйтесь ключами — лично, через другой канал, как удобно. Вставьте npub в MurMur — переписка появится.

Всё, что вы отправляете, шифруется на вашем устройстве и расшифровывается только на устройстве собеседника.

### Шаг 5. Пишите, звоните, получайте уведомления

Дальше всё как в обычном мессенджере: текстовые сообщения, голосовые звонки, пуш-уведомления о новых сообщениях. Звонки и сообщения защищены сквозным шифрованием.

## Что видит сервер

MurMur использует релей — сервер на Rust в Европе — для передачи сообщений между пользователями. Что он видит на самом деле?

**Не ваши сообщения.** Релей получает шифротекст. Без вашего приватного ключа зашифрованный трафик нечитаем — релей не видит plaintext.

**Минимум метаданных.** Релей неизбежно знает вещи вроде «в такое-то время от A к B прошло зашифрованное сообщение». Это минимум, который нужен любой транспортной системе, чтобы работать. Кем вы являетесь в реальной жизни, он не знает, потому что аккаунты не привязаны к номеру или почте.

Код релея открыт — его можно посмотреть на github.com/Oleg2796996/murmur. Весь проект открыт, и это принципиально: доверие должно основываться на коде, который можно проверить, а не на обещаниях.

## FAQ

**Безопасен ли мессенджер в браузере?**
Да, если он шифрует сквозным образом — MurMur именно так работает. Браузер — это просто среда запуска; шифрование происходит на вашем устройстве, до того как данные его покинут. Главный вопрос для любого мессенджера — у кого ключи. При E2EE ответ: только у вас и вашего собеседника.

**Работает ли офлайн?**
Само приложение — да. Благодаря офлайн-кэшу оно открывается без сети и показывает локально сохранённые чаты. Отправлять и получать новые сообщения, конечно, нужен интернет — как у любого мессенджера.

**Где хранятся сообщения?**
На вашем устройстве — локально в хранилище браузера. На релее зашифрованные копии лежат ограниченное время — достаточно, чтобы доставить их, если вы были офлайн, — потом удаляются. Сервер нигде не имеет читаемого текста.

**Что будет, если очистить данные браузера?**
Вы потеряете локально сохранённые переписки и свой ключ. Очистка данных сайта — это как удалить приложение и стереть его данные: восстановить переписку с сервера нельзя. Поэтому перед очисткой или сменой устройства сохраните ключ там, где это предлагает приложение.

**Нужно ли что-то устанавливать из магазинов приложений?**
Нет. MurMur устанавливается напрямую с https://murmurchat.org как PWA — и на iPhone, и на Android, без App Store и Google Play.

## Попробуйте

Откройте **https://murmurchat.org**, добавьте его на домашний экран, создайте ключ и поделитесь своим npub с одним человеком, с которым хотите общаться приватно. Это вся настройка. Код открыт на github.com/Oleg2796996/murmur — читайте, проверяйте или просто пользуйтесь.

MurMur — молодой проект, он быстро развивается. Если вам нужен шифрованный мессенджер, который не спрашивает номер телефона и не живёт в магазине приложений, — это простой способ его получить.
