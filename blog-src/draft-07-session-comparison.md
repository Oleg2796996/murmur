# Draft 07 — Session vs MurMur: messengers without a phone number

## META
- title_en: Session vs MurMur: messengers without a phone number
- title_ru: Session vs MurMur: мессенджеры без номера телефона
- description_en: An honest comparison of Session and MurMur — two messengers that never ask for a phone number. Where Session is stronger today, and what MurMur does differently.
- description_ru: Честное сравнение Session и MurMur — мессенджеров, которым не нужен номер телефона. Где Session сильнее сегодня и чем отличается MurMur.
- slug_en: session-vs-murmur-no-phone-number
- slug_ru: session-protiv-murmur-bez-nomera-telefona

## EN

<h2>Two messengers that skip the phone number</h2>

<p>Most messengers start by asking for your phone number. WhatsApp and Signal both do. WhatsApp encrypts message content by default, but it belongs to Meta, and Meta keeps the account metadata — who you talk to and when, plus device details. Signal also requires a phone number, even though it collects very little metadata and its protocol is treated as the reference standard in the field. If your goal is a messenger that never sees a phone number at all, the list of serious options gets short fast. Session is the most established one. MurMur is a much younger open-source project that takes a different route. This article compares the two honestly — including the places where Session is simply the better recommendation today.</p>

<h2>The short version</h2>

<table>
<tr><th></th><th>Session</th><th>MurMur</th></tr>
<tr><td>Registration</td><td>None. A random session ID is generated on your device.</td><td>None. Your identity is a cryptographic key (npub) generated on your device.</td></tr>
<tr><td>E2EE by default</td><td>Yes</td><td>Yes — for messages and calls</td></tr>
<tr><td>Calls</td><td>Voice calls between users</td><td>E2EE calls, running in the browser</td></tr>
<tr><td>Metadata story</td><td>Messages travel through an onion network of independently operated nodes; nothing is tied to a phone number.</td><td>A single Rust relay in Europe that cannot read plaintext and keeps encrypted messages only for a limited time.</td></tr>
<tr><td>Install</td><td>Native apps from app stores, APK, desktop apps</td><td>PWA installed from the browser, no app store needed</td></tr>
<tr><td>Who runs it</td><td>The Session Foundation plus a community-operated node network</td><td>One open-source relay in Europe, run by the project itself</td></tr>
</table>

<h2>Where Session is the better choice today</h2>

<p>This should be stated plainly. Session has existed for years, its code has been independently audited, it has a large user community, and its apps went through long real-world testing. If you want a no-phone-number messenger that many people already use, with mature native apps, Session is the safer recommendation right now. That is not a caveat — it is the honest answer for most people reading this. A young project with no security audit cannot compete with that track record, and pretending otherwise would be misleading.</p>

<h2>Where MurMur differs</h2>

<ul>
<li><strong>Installation from the browser.</strong> MurMur is a PWA. On both iPhone and Android you install it directly from the browser, without the App Store or Google Play. That matters if app stores are an obstacle for you, or you simply don't want another native app.</li>
<li><strong>Calls in the browser.</strong> Voice calls are end-to-end encrypted and run inside the same browser-installed app. Nothing extra to install.</li>
<li><strong>A simpler model.</strong> One cryptographic key is your account. One Rust relay in Europe moves encrypted data. The relay cannot read plaintext and stores encrypted messages for a limited time — enough to receive messages while you were offline, not a long-term archive.</li>
<li><strong>Push notifications</strong> work, so it behaves like a normal messenger in daily use.</li>
<li><strong>Readable code.</strong> The project is open source and small. An ordinary developer can actually read all of it, which is unrealistic for a large codebase.</li>
</ul>

<h2>Honest limitations of MurMur</h2>

<ul>
<li><strong>No security audit.</strong> The code is open, but no independent review has happened yet. If an audited product is your requirement, Session wins today.</li>
<li><strong>Small audience.</strong> The project is young; your contacts are probably not there yet. That is a practical problem, not a cosmetic one.</li>
<li><strong>A PWA depends on the browser.</strong> It lives inside your browser, with the limits that come with that: no native-app polish, and behavior tied to browser updates.</li>
<li><strong>Key loss means account loss.</strong> There is no SMS recovery and no reset link. Lose the key, lose the account. That is the price of having no phone number in the system at all.</li>
</ul>

<h2>FAQ</h2>

<h3>Does Session require a phone number or email?</h3>
<p>No. Session generates a random session ID on your device during setup, and nothing connects that ID to a phone number or an email address.</p>

<h3>Is MurMur as secure as Session?</h3>
<p>There is no honest way to claim that. Both encrypt messages end-to-end and both are open source, but Session has been through independent audits and MurMur has not. Until an audit happens, treat MurMur as promising but unverified.</p>

<h3>Can I install MurMur without the App Store or Google Play?</h3>
<p>Yes. MurMur is a PWA: open the site in the browser on iPhone or Android and install it from there. No app store account is involved.</p>

<h3>What happens if I lose my MurMur key?</h3>
<p>The account is lost. The cryptographic key is the identity, and there is no SMS recovery to fall back on. Backing the key up is on you.</p>

<h3>Can the relay or the network read my messages?</h3>
<p>Session routes messages through an onion network of community-run nodes, with content encrypted end to end. MurMur's relay cannot read plaintext either — it stores messages only in encrypted form, and only for a limited time.</p>

<h2>Trying MurMur</h2>

<p>If the browser-based approach sounds interesting, MurMur installs in a couple of minutes from <a href="https://murmurchat.org">murmurchat.org</a> and works on both iPhone and Android. The source code is on GitHub. Just keep your key safe — there is no reset.</p>

## RU

<h2>Два мессенджера, которым не нужен ваш номер</h2>

<p>Практически любой мессенджер начинается с просьбы указать номер телефона. WhatsApp и Signal работают именно так. WhatsApp шифрует содержимое переписки по умолчанию, но принадлежит Meta, а Meta видит метаданные: с кем и когда вы общаетесь, с какого устройства. Signal тоже требует номер — хотя собирает минимум метаданных, а его протокол считается эталоном в отрасли. Если цель — мессенджер, которому номер не нужен вообще, список вариантов быстро сокращается до пары имён. Session — самый известный из них. MurMur — куда более молодой проект с открытым кодом, который пошёл другим путём. Ниже — честное сравнение, включая те места, где Session сегодня действительно лучше.</p>

<h2>Коротко</h2>

<table>
<tr><th></th><th>Session</th><th>MurMur</th></tr>
<tr><td>Регистрация</td><td>Нет. При первом запуске на устройстве создаётся случайный session ID.</td><td>Нет. Аккаунт — это криптографический ключ (npub), созданный на вашем устройстве.</td></tr>
<tr><td>E2EE по умолчанию</td><td>Да</td><td>Да — для сообщений и звонков</td></tr>
<tr><td>Звонки</td><td>Голосовые звонки между пользователями</td><td>Звонки со сквозным шифрованием, работают в браузере</td></tr>
<tr><td>Метаданные</td><td>Сообщения идут через onion-сеть из независимо управляемых узлов; ни к чему не привязан номер телефона.</td><td>Один Rust-релей в Европе, который не может прочитать содержимое и хранит зашифрованные сообщения ограниченное время.</td></tr>
<tr><td>Установка</td><td>Приложения из магазинов, APK, десктоп-версии</td><td>PWA, ставится из браузера, магазины не нужны</td></tr>
<tr><td>Кто управляет</td><td>Фонд Session и сеть узлов, поддерживаемых сообществом</td><td>Один открытый релей в Европе, который держит сам проект</td></tr>
</table>

<h2>Где Session сегодня лучше</h2>

<p>Скажем прямо. Session существует несколько лет, её код проходил независимый аудит, вокруг проекта сложилось большое сообщество, а приложения давно обкатаны в реальных условиях. Если нужен мессенджер без номера, которым уже пользуются многие, — сегодня это самая надёжная рекомендация. Молодой проект без аудита с такой историей соперничать не может, и притворяться обратным было бы нечестно.</p>

<h2>Чем MurMur отличается</h2>

<ul>
<li><strong>Установка из браузера.</strong> MurMur — это PWA. На iPhone и Android он ставится прямо из браузера, без App Store и Google Play. Это важно, если магазины приложений для вас препятствие или просто не хочется ещё одного «нативного» приложения.</li>
<li><strong>Звонки в браузере.</strong> Голосовые звонки зашифрованы сквозным шифрованием и работают в том же приложении, установленном из браузера. Ничего доустанавливать не нужно.</li>
<li><strong>Простая модель.</strong> Аккаунт — это один криптографический ключ. Один Rust-релей в Европе передаёт зашифрованные данные. Он не видит содержимое и хранит зашифрованные сообщения ограниченное время: хватит, чтобы получить сообщения, пока вы были офлайн, но это не архив на годы.</li>
<li><strong>Push-уведомления</strong> работают — в повседневном использовании это обычный мессенджер.</li>
<li><strong>Код можно прочитать.</strong> Проект открыт и невелик: обычный разработчик реально может прочитать его целиком. С большим кодом так не получится.</li>
</ul>

<h2>Честные ограничения MurMur</h2>

<ul>
<li><strong>Аудита не было.</strong> Код открыт, но независимой проверки ещё не проводилось. Если для вас обязателен проверенный продукт — сегодня это Session.</li>
<li><strong>Маленькая аудитория.</strong> Проект молодой, и ваших знакомых там, скорее всего, ещё нет. Это практическая проблема, а не косметическая.</li>
<li><strong>PWA зависит от браузера.</strong> Приложение живёт внутри браузера со всеми вытекающими: нет «нативной» отделки, а поведение зависит от обновлений браузера.</li>
<li><strong>Потеряли ключ — потеряли аккаунт.</strong> Восстановления по SMS нет, ссылок для сброса тоже. Ключ стоит сохранить самим — это цена полного отсутствия номера в системе.</li>
</ul>

<h2>Вопросы и ответы</h2>

<h3>Нужен ли Session номер телефона или почта?</h3>
<p>Нет. Session создаёт случайный session ID прямо на устройстве, и ни номер телефона, ни почта к этому идентификатору не привязываются.</p>

<h3>MurMur такой же безопасный, как Session?</h3>
<p>Честно утверждать это нельзя. Оба шифруют переписку сквозным шифрованием, у обоих открытый код, но Session прошла независимые аудиты, а MurMur — нет. Пока аудита не было, MurMur стоит воспринимать как перспективный, но непроверенный проект.</p>

<h3>Можно ли установить MurMur без App Store и Google Play?</h3>
<p>Да. MurMur — это PWA: откройте сайт в браузере на iPhone или Android и установите приложение оттуда. Учётная запись магазина приложений не нужна.</p>

<h3>Что будет, если потерять ключ MurMur?</h3>
<p>Аккаунт будет потерян. Криптографический ключ — это и есть личность, а восстановления по SMS в системе нет. Резервная копия ключа — ваша забота.</p>

<h3>Может ли релей или сеть прочитать мои сообщения?</h3>
<p>Session передаёт сообщения через onion-сеть узлов сообщества, содержимое зашифровано сквозным шифрованием. Релей MurMur тоже не может прочитать открытый текст: он хранит сообщения только в зашифрованном виде и лишь ограниченное время.</p>

<h2>Попробовать MurMur</h2>

<p>Если браузерный подход выглядит интересно, MurMur ставится с сайта <a href="https://murmurchat.org">murmurchat.org</a> за пару минут и работает на iPhone и Android. Исходный код открыт на GitHub. И сразу сохраните ключ: восстановить его не получится.</p>
