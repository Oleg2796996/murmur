# Draft 06 — Why we built a messenger without accounts (devlog)

## META
title_en: A messenger with no accounts, no phone numbers, no emails
title_ru: Мессенджер без аккаунтов: почему так и что это значит
description_en: Why MurMur replaces phone-number identity with a cryptographic key, what that solves, what it costs, and how a relay that can't read your messages works. Honest devlog.
description_ru: Почему MurMur заменяет номер телефона криптографическим ключом, что это даёт и чего лишает. Как работает релей, который не может прочитать переписку. Честный девлог.
slug_en: why-no-accounts
slug_ru: pochemu-bez-akkauntov

## EN

<h2>We kept asking for a phone number. Then we stopped.</h2>

<p>Most messengers make you register with a phone number or an email. It feels like a formality, but it is actually the foundation of the whole system: your account is tied to something you don't fully control.</p>

<p>A phone number is not yours in any real sense. Your carrier can take it away if you stop paying. A number that was deactivated gets recycled and handed to a stranger after a waiting period — and on several services, that stranger can then attempt to recover accounts linked to the old number. And there is SIM swapping: an attacker convinces (or bribes) a carrier employee to move your number to their SIM card. Once they hold your number, they hold the recovery path to everything built on it.</p>

<p>There's also a quieter issue: metadata. Even in end-to-end encrypted systems, the phone number itself is a permanent identifier that links you to everyone you talk to, across every service where you used the same number. The content can be protected while the graph of who-knows-whom stays exposed.</p>

<p>We didn't want MurMur to inherit any of this. So we removed registration entirely.</p>

<h2>Your identity is a key, not a phone number</h2>

<p>When you first open MurMur — installable as a PWA on iPhone and Android, without the App Store or Google Play — there is no sign-up form. No phone, no email, no "please verify you're human." Instead, the app generates a cryptographic key pair. Your public part is your identity, an npub. People find you by that string, not by who your carrier thinks you are.</p>

<p>What does this change in practice?</p>

<ul>
  <li><strong>No SIM swap.</strong> Stealing a SIM card gives an attacker nothing, because the account isn't derived from the number.</li>
  <li><strong>No number recycling.</strong> Your identity can't be handed to the next subscriber.</li>
  <li><strong>No central account to recover</strong> — which is a feature and a cost at the same time (more on that below).</li>
  <li><strong>Less metadata by design.</strong> The service doesn't hold a phone book mapping real people to conversations.</li>
</ul>

<p>Messages and calls are end-to-end encrypted. There are push notifications, so the app behaves like a normal messenger, but the server side was built around the assumption that it cannot read anything you send.</p>

<h2>What the relay actually sees</h2>

<p>MurMur uses a relay server written in Rust. Conceptually, it works like a post office with sealed envelopes: it accepts an encrypted blob from you, delivers it to the recipient's queue, holds it for a limited time if they're offline, then it's gone.</p>

<p>The key property is structural, not a promise. The relay never receives plaintext and never holds your private key. The encryption happens in your browser before anything leaves the device, and decryption happens in the recipient's browser. The Rust code handles routing, storage of ciphertext, and expiry — operations that don't require understanding the content. We chose Rust partly because its memory-safety guarantees reduce the class of bugs that turn into security incidents.</p>

<p>What the relay can still see: that some encrypted traffic exists, roughly when, between which ephemeral identifiers, and its size. We won't pretend metadata disappears completely — no networked service achieves that — but the relay holds far less than a traditional server, and nothing readable.</p>

<h2>The honest cost: lose the key, lose the account</h2>

<p>This trade-off has a real price, and we'd rather state it plainly than bury it. There is no SMS recovery. There is no password reset. Your account is the key; if you lose the key, the account is gone. Nobody — including us — can restore it. That's the same property that protects you from SIM swap, viewed from the other side: if recovery were possible through a phone number, the number would become the weak point again.</p>

<p>So treat your key like a house key, not like a password you can reset. Back it up somewhere you control.</p>

<h2>What we are not</h2>

<p>MurMur is a young project with a small team and a small audience. There has been no independent security audit. We publish the source code on GitHub so anyone can inspect it, but public code without an audit is not proof of security — it's an invitation to check. Two practical limitations follow from the PWA approach: the app depends on the browser you run it in, and browser-based cryptography is only as sound as the browser itself. If you need a messenger with years of audits and a large security team behind it, use one of the established options. We think there's room for a different model, and we'd rather be honest about where we are on that path.</p>

<h2>FAQ</h2>

<dl>
  <dt><strong>What happens if I lose my key?</strong></dt>
  <dd>The account is lost. There is no recovery by SMS or email, because those identifiers don't exist in MurMur. Back up your key before you need it.</dd>

  <dt><strong>How do friends find me without a phone number?</strong></dt>
  <dd>By your npub — the public part of your key. You can share it through any channel you already trust, or show a QR code in person.</dd>

  <dt><strong>Can the server read my messages or hear my calls?</strong></dt>
  <dd>No. The relay only handles ciphertext. Encryption and decryption happen in the browsers of the participants.</dd>

  <dt><strong>Do I need to install anything from an app store?</strong></dt>
  <dd>No. MurMur is a PWA: open the site, install it from the browser on iPhone or Android. That also means it works where app stores are restricted or unavailable.</dd>

  <dt><strong>Is MurMur audited?</strong></dt>
  <dd>Not yet. It's an open-source project by a small team, young and unaudited. We say this up front because you should weigh it when deciding what to trust.</dd>
</dl>

<p><a href="https://murmurchat.org">Try MurMur at murmurchat.org</a> — no phone number required, and that's the point.</p>

## RU

<h2>Мы перестали спрашивать номер телефона</h2>

<p>Практически каждый мессенджер начинается с регистрации: телефон или почта. Кажется, что это мелочь, а на самом деле это фундамент всей системы — аккаунт привязан к тому, чем вы не вполне владеете.</p>

<p>Номер телефона вам не принадлежит. Оператор забирает его, если вы перестали платить. Отключённые номера через какое-то время отдают новым абонентам, и на некоторых сервисах новый владелец старого номера может попытаться восстановить чужие аккаунты. Отдельная история — SIM swap: мошенник убеждает или подкупает сотрудника оператора, и ваш номер переезжает на чужую SIM. Кто держит номер — тот держит путь восстановления ко всему, что на нём построено.</p>

<p>Есть и менее заметная проблема — метаданные. Даже в системах со сквозным шифрованием сам номер телефона остаётся постоянным идентификатором: он связывает вас с кругом общения и тянется за вами по всем сервисам, где вы его указывали. Содержание переписки можно защитить, а карта «кто с кем общается» остаётся открытой.</p>

<p>Мы не хотели, чтобы MurMur повторял эту схему, поэтому убрали регистрацию целиком.</p>

<h2>Идентичность — это ключ, а не номер</h2>

<p>MurMur ставится как PWA на iPhone и Android, минуя App Store и Google Play. При первом открытии никакой анкеты нет: ни телефона, ни почты. Приложение просто генерирует криптографическую пару ключей. Публичная часть — ваш npub, по нему вас и находят. Оператор связи в этой схеме не участвует.</p>

<p>Что это меняет на практике:</p>

<ul>
  <li><strong>SIM swap теряет смысл.</strong> Украденная SIM не даёт доступа к аккаунту, потому что аккаунт из номера не выводится.</li>
  <li><strong>Перевыпуск номеров не страшен.</strong> Вашу идентичность нельзя передать следующему абоненту.</li>
  <li><strong>Нет центрального аккаунта для восстановления</strong> — это одновременно и преимущество, и цена (об этом ниже).</li>
  <li><strong>Меньше метаданных.</strong> Сервер не хранит телефонную книгу «настоящие люди — переписки».</li>
</ul>

<p>Сообщения и звонки зашифрованы сквозным шифрованием, push-уведомления работают как в обычном мессенджере. Разница в том, что серверная часть изначально проектировалась под допущение «мы не можем прочитать ни байта из того, что пересылаем».</p>

<h2>Что видит релей</h2>

<p>Серверная часть MurMur — релей, написанный на Rust. Если объяснять на пальцах, это почта с запечатанными конвертами: он принимает от вас зашифрованный блок, кладёт его в очередь получателя, хранит ограниченное время, если тот офлайн, а потом удаляет.</p>

<p>Главное здесь — не обещание, а конструкция. Релей не получает открытый текст и не имеет вашего приватного ключа. Шифрование происходит в браузере отправителя до того, как данные уходят с устройства; расшифровка — в браузере получателя. Код на Rust занимается маршрутизацией, хранением шифротекста и сроками жизни сообщений — задачами, для которых понимание содержания не нужно. Rust мы выбрали в том числе из-за гарантий безопасности памяти: целый класс ошибок, которые обычно оборачиваются инцидентами, там просто не компилируется.</p>

<p>При этом релей всё же кое-что видит: сам факт зашифрованного трафика, его объём, примерное время и идентификаторы очередей. Мы не будем утверждать, что метаданные исчезают полностью — это не даёт ни один сетевой сервис. Но хранить нечего: на сервере нет ничего читаемого.</p>

<h2>Честная цена: потерял ключ — потерял аккаунт</h2>

<p>У этой модели есть цена, и мы скажем о ней прямо, а не спрячем в сноску. Никакого восстановления по SMS нет. Никакого сброса пароля нет. Аккаунт — это и есть ключ; потеряли ключ — аккаунта больше нет, и никто, включая нас, не поможет его вернуть. Это та же защита от SIM swap, только с обратной стороны: если бы восстановление шло через номер телефона, номер снова стал бы самым слабым местом.</p>

<p>Поэтому относитесь к ключу как к ключу от квартиры, а не как к паролю, который всегда можно сбросить. Сделайте резервную копию там, где контролируете доступ вы, а не кто-то ещё.</p>

<h2>Чего у нас нет</h2>

<p>MurMur — молодой проект маленькой команды с маленькой аудиторией. Независимого аудита безопасности не было. Исходный код открыт на GitHub, его можно читать и проверять, но открытый код без аудита — это не доказательство безопасности, а приглашение её проверить. Из подхода с PWA следуют и практические ограничения: приложение зависит от браузера, а браузерная криптография надёжна ровно настолько, насколько надёжен сам браузер. Если вам нужен мессенджер с многолетними аудитами и большой командой безопасности — честно, возьмите один из известных. Мы считаем, что место для другой модели есть, и предпочитаем говорить, где на этом пути находимся.</p>

<h2>Частые вопросы</h2>

<dl>
  <dt><strong>Что будет, если я потеряю ключ?</strong></dt>
  <dd>Аккаунт будет потерян. Восстановления по SMS или почте нет — этих данных в MurMur просто не существует. Позаботьтесь о резервной копии заранее.</dd>

  <dt><strong>Как меня найдут друзья без номера телефона?</strong></dt>
  <dd>По вашему npub — публичной части ключа. Передайте его через любой канал, которому уже доверяете, или покажите QR-код лично.</dd>

  <dt><strong>Сервер может прочитать сообщения или подслушать звонок?</strong></dt>
  <dd>Нет. Релей работает только с шифротекстом. Шифрование и расшифровка происходят в браузерах участников.</dd>

  <dt><strong>Нужно ли ставить что-то из магазина приложений?</strong></dt>
  <dd>Нет. MurMur — PWA: открываете сайт и устанавливаете прямо из браузера на iPhone или Android. Это работает и там, где магазины приложений недоступны.</dd>

  <dt><strong>Был ли аудит MurMur?</strong></dt>
  <dd>Пока нет. Это молодой open-source проект маленькой команды, и мы говорим об этом в открытую — вы должны знать это, решая, чему доверять.</dd>
</dl>

<p><a href="https://murmurchat.org">Попробовать MurMur на murmurchat.org</a> — номер телефона не понадобится. Собственно, ради этого всё и начиналось.</p>
