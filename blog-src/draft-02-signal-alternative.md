# Draft 02 — Аналог Signal без номера телефона

---

## META (EN)

- **Title (60):** Signal Alternative Without a Phone Number: Honest Look
- **Description (148):** Signal, WhatsApp, Session and MurMur compared: registration, E2EE, metadata, calls, install. Where a phone number is required and where it isn't.
- **Slug:** signal-alternative-without-phone-number

## META (RU)

- **Title (54):** Аналог Signal без номера телефона: честное сравнение
- **Description (128):** Signal, WhatsApp, Session и MurMur: регистрация, шифрование, метаданные, звонки. Где нужен номер телефона, а где нет.
- **Slug:** signal-alternative-without-phone-number

---

## EN

<h1>Signal Alternative Without a Phone Number: Honest Look</h1>

<p>Signal is a good messenger. Its encryption protocol has been studied for years, the code is open, and the nonprofit behind it has a long track record. But registration requires a phone number — and that's exactly what some people can't or won't provide. If you searched for "Signal alternative without phone number", here is a plain comparison of four options: Signal, WhatsApp, Session and MurMur. Weak points included.</p>

<h2>Why the phone number matters (and when it doesn't)</h2>

<p>A phone number in Signal is not a privacy disaster on its own: the server stores very little and hides sender metadata. But your number is your identifier. Anyone who knows it can find your profile, and to create an account you need a working SIM — which in some countries means registration tied to your real identity. For most people this is a non-issue. For others it's the dealbreaker that starts the search. Both reactions are reasonable.</p>

<h2>Signal vs WhatsApp vs Session vs MurMur</h2>

<table>
  <tr><th></th><th>Signal</th><th>WhatsApp</th><th>Session</th><th>MurMur</th></tr>
  <tr><td>Sign-up requires</td><td>Phone number</td><td>Phone number</td><td>Nothing — a generated Session ID</td><td>Nothing — npub key pair, no phone or email</td></tr>
  <tr><td>E2EE by default</td><td>Yes</td><td>Yes</td><td>Yes</td><td>Yes</td></tr>
  <tr><td>Calls</td><td>Voice and video</td><td>Voice and video</td><td>Voice (1:1)</td><td>Yes</td></tr>
  <tr><td>Metadata — who sees connections</td><td>Server stores very little, but the account is tied to your number</td><td>Meta collects usage metadata at scale</td><td>Traffic goes over an onion network</td><td>Rust relay in Europe routes traffic but can't read message content</td></tr>
  <tr><td>Installation</td><td>App stores or APK</td><td>App stores</td><td>App stores or APK</td><td>PWA in a browser — no store at all</td></tr>
  <tr><td>Message storage</td><td>Delivered, not kept on the server long-term</td><td>On device; cloud backups optional, encrypted only if you enable it</td><td>Cached on distributed network nodes</td><td>End-to-end encrypted; the relay can't see what it forwards</td></tr>
</table>

<h2>What the table can't show: maturity</h2>

<p>"E2EE by default" and "no phone number" are not the whole story. A messenger is also its implementation quality, how long it has survived real attacks, and who checked the code.</p>

<ul>
  <li><strong>Signal</strong> has been audited repeatedly and runs on its own well-studied protocol. It's the safest default for most people.</li>
  <li><strong>WhatsApp</strong> uses Signal's protocol, but the client is controlled by Meta, and metadata feeds a company whose business is advertising. Encryption protects message content, not who talks to whom.</li>
  <li><strong>Session</strong> has no phone number at all and routes traffic through an onion network. Open source, maintained by a foundation.</li>
  <li><strong>MurMur</strong> is a young project. The code is open (github.com/Oleg2796996/murmur) and the relay is a small Rust service in Europe that never sees plaintext — but there has been no independent security audit yet, the review community is small, and a PWA depends on the browser platform you run it in. We'd rather say this plainly than pretend it isn't so.</li>
</ul>

<h2>Who MurMur is a good fit for</h2>

<ul>
  <li>You want an account with <em>neither</em> a phone <em>nor</em> an email — npub keys instead.</li>
  <li>You can't or won't install store apps. MurMur is a PWA: open the site, add it to your home screen, push notifications work.</li>
  <li>You need calls, not just text.</li>
  <li>You prefer to read the code yourself rather than trust marketing: it's on GitHub.</li>
</ul>

<h2>When Signal is still the right choice</h2>

<ul>
  <li>You want a protocol and clients that have survived years of audits and real-world attacks.</li>
  <li>A phone number isn't a problem for you.</li>
  <li>Your contacts are already there — messenger value is mostly network effect.</li>
  <li>For sensitive work, maturity beats novelty.</li>
</ul>

<h2>FAQ</h2>

<h3>Is a messenger without a phone number less secure?</h3>
<p>No. Security depends on the protocol and its implementation, not on the identifier. If anything, an account that isn't tied to your SIM is a privacy plus. The real caveat is maturity: newer projects have fewer independent eyes on the code, and MurMur hasn't had an external audit yet.</p>

<h3>What is an npub key?</h3>
<p>In MurMur your account is a key pair (npub), not a phone number. No phone, no email — registration is generating keys.</p>

<h3>Does Session require a phone number?</h3>
<p>No. Session generates a random Session ID that acts as your address.</p>

<h3>Can I use MurMur without installing an app?</h3>
<p>Yes. It's a PWA: it runs in the browser and can be added to the home screen. Push notifications are supported. It does depend on your browser and OS, which is a trade-off of the PWA approach.</p>

<h3>Why does WhatsApp have E2EE but still collect data?</h3>
<p>End-to-end encryption protects message content. Metadata — who contacts whom, when, how often — is separate, and that's what feeds Meta's systems.</p>

<h2>Try MurMur</h2>

<p>MurMur runs at <a href="https://murmurchat.org">murmurchat.org</a> — open it in a browser: no phone, no email, no store. Source code: <a href="https://github.com/Oleg2796996/murmur">github.com/Oleg2796996/murmur</a>. And one last honest note: if you want the most battle-tested option today, Signal remains a strong default. Choose by your threat model, not by slogans.</p>

---

## RU

<h1>Аналог Signal без номера телефона: честное сравнение</h1>

<p>Signal заслуженно считают эталоном приватного мессенджера: протокол изучен вдоль и поперёк, код открыт, за проектом стоит некоммерческая организация. Но есть жёсткое требование, с которым мирятся не все: для регистрации нужен номер телефона. Если вы искали «аналог Signal без номера телефона» — вот четыре варианта (Signal, WhatsApp, Session, MurMur) и честный разбор, где у каждого болит.</p>

<h2>Чем плох номер телефона — и чем хорош</h2>

<p>Сам по себе номер в Signal не катастрофа: сервер хранит минимум данных и прячет метаданные отправителя. Но номер — это ваш идентификатор. Кто знает ваш телефон, тот нашёл вас в Signal. А чтобы завести аккаунт, нужна рабочая SIM — в ряде стран она оформляется на паспорт. Одних это не смущает, других останавливает. И те и другие правы по-своему.</p>

<h2>Таблица: Signal, WhatsApp, Session, MurMur</h2>

<table>
  <tr><th></th><th>Signal</th><th>WhatsApp</th><th>Session</th><th>MurMur</th></tr>
  <tr><td>Что нужно для регистрации</td><td>Номер телефона</td><td>Номер телефона</td><td>Ничего — генерируется Session ID</td><td>Ничего — npub-ключи, без телефона и почты</td></tr>
  <tr><td>E2EE по умолчанию</td><td>Да</td><td>Да</td><td>Да</td><td>Да</td></tr>
  <tr><td>Звонки</td><td>Аудио и видео</td><td>Аудио и видео</td><td>Аудио (1:1)</td><td>Есть</td></tr>
  <tr><td>Метаданные — кто видит связи</td><td>Сервер хранит минимум, но аккаунт привязан к номеру</td><td>Meta собирает метаданные использования в промышленных масштабах</td><td>Трафик идёт через луковую сеть</td><td>Rust-релей в Европе передаёт трафик, но не видит содержимое сообщений</td></tr>
  <tr><td>Установка</td><td>Магазины приложений или APK</td><td>Магазины приложений</td><td>Магазины или APK</td><td>PWA в браузере — магазин не нужен</td></tr>
  <tr><td>Хранение сообщений</td><td>Доставляются, на сервере долго не хранятся</td><td>На устройстве; облачные бэкапы — по желанию, шифруются только если включить вручную</td><td>Кэшируются на распределённых узлах сети</td><td>Сквозное шифрование; релей не видит того, что пересылает</td></tr>
</table>

<h2>Чего таблица не покажет: зрелость проекта</h2>

<p>«Шифрование по умолчанию» и «без номера» — ещё не всё. Мессенджер — это ещё и качество реализации, годы под реальными атаками и то, кто проверял код.</p>

<ul>
  <li><strong>Signal</strong> многократно проходил независимые аудиты и работает на собственном изученном протоколе. Для большинства это самый безопасный вариант по умолчанию.</li>
  <li><strong>WhatsApp</strong> использует протокол Signal, но клиентом управляет Meta, а метаданные обслуживают рекламный бизнес. Шифрование защищает содержимое переписки, но не факт общения.</li>
  <li><strong>Session</strong> вообще не требует номера и гоняет трафик через луковую сеть. Открытый код, есть поддерживающий фонд.</li>
  <li><strong>MurMur</strong> — молодой проект. Код открыт (github.com/Oleg2796996/murmur), релей — небольшой Rust-сервис в Европе, который не видит plaintext. Но независимого аудита безопасности ещё не было, комьюнити маленькое, а PWA зависит от браузерной платформы. Мы говорим это прямо, а не замалчиваем.</li>
</ul>

<h2>Кому подходит MurMur</h2>

<ul>
  <li>Вам нужен аккаунт без телефона <em>и</em> без почты — npub-ключи вместо того и другого.</li>
  <li>Вы не хотите или не можете ставить приложения из магазинов. MurMur — PWA: открыли сайт, добавили на домашний экран, пуши работают.</li>
  <li>Нужны звонки, а не только переписка.</li>
  <li>Вы хотите прочитать код сами, а не верить обещаниям: он на GitHub.</li>
</ul>

<h2>Кому лучше остаться на Signal</h2>

<ul>
  <li>Нужны протокол и клиенты, прошедшие годы аудитов и реальных атак.</li>
  <li>Номер телефона для вас — не проблема.</li>
  <li>Контакты уже там: ценность мессенджера во многом в сети знакомых.</li>
  <li>Для чувствительной работы зрелость важнее новизны.</li>
</ul>

<h2>FAQ</h2>

<h3>Мессенджер без номера телефона — значит менее безопасный?</h3>
<p>Нет. Безопасность определяют протокол и его реализация, а не способ идентификации. Аккаунт, не привязанный к SIM, скорее плюс для приватности. Настоящая оговорка — зрелость: у молодых проектов меньше независимых проверок кода, и аудита MurMur ещё не было.</p>

<h3>Что такое npub-ключ?</h3>
<p>В MurMur ваш аккаунт — это пара ключей (npub), а не номер. Без телефона и почты: регистрация — это просто генерация ключей.</p>

<h3>Session работает без номера телефона?</h3>
<p>Да. Session генерирует случайный Session ID, который служит вашим адресом.</p>

<h3>MurMur можно использовать без установки приложения?</h3>
<p>Да, это PWA: работает в браузере, добавляется на домашний экран, есть push-уведомления. Но подход зависит от браузера и ОС — это часть компромисса.</p>

<h3>Почему в WhatsApp есть E2EE, но данные всё равно собирают?</h3>
<p>Сквозное шифрование защищает содержимое сообщений. Метаданные — кто, кому и когда пишет — защищает не оно, и именно они питают системы Meta.</p>

<h2>Попробовать MurMur</h2>

<p>MurMur работает на <a href="https://murmurchat.org">murmurchat.org</a> — откройте в браузере: без телефона, без почты, без магазина приложений. Исходный код: <a href="https://github.com/Oleg2796996/murmur">github.com/Oleg2796996/murmur</a>. И финальная честность: если нужен максимально проверенный вариант прямо сейчас — Signal остаётся разумным дефолтом. Выбирайте по своей модели угроз, а не по лозунгам.</p>
