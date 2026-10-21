# Draft 04 — E2EE explained simply

## META

- title_en: End-to-End Encryption, Explained Honestly
- title_ru: Сквозное шифрование: честно и без пафоса
- description_en: What end-to-end encryption protects — and what it doesn't: metadata, backups, lost keys, compromised devices. Plus an honest note on MurMur's audit status.
- description_ru: Что защищает сквозное шифрование, а что нет: метаданные, бэкапы, потерянный ключ, заражённый телефон. И честное слово про аудит MurMur.
- slug_en: e2ee-explained-what-it-protects
- slug_ru: skvoznoe-shifrovanie-prosto

## EN

<h2>What end-to-end encryption actually means</h2>

<p>End-to-end encryption (E2EE) is a term that gets used a lot and explained rarely. The idea is simple: a message is encrypted on your device and can only be decrypted on the device of the person you're talking to. Everyone in between — the server relaying the message, the network it travels through, the operator running that server — sees only scrambled data with no way to unscramble it.</p>

<p>MurMur is built this way from the ground up. There is no registration with a phone number or email: your identity is a cryptographic key, displayed as an npub. Your messages and your calls are encrypted between the two devices. The relay — a small server written in Rust, located in Europe — passes encrypted data along and can store it only in encrypted form for a limited time. It never holds the plaintext.</p>

<h2>What E2EE protects</h2>

<ul>
  <li><strong>Message content from the server.</strong> The relay physically cannot read what you write, even though it stores and forwards your messages.</li>
  <li><strong>Content from network interceptors.</strong> Someone on the same Wi-Fi, your provider, or any intermediate node sees ciphertext, not conversation.</li>
  <li><strong>Call audio and video.</strong> E2EE applies to calls, not only text.</li>
  <li><strong>Stored messages after a leak.</strong> If the relay's disk is copied, what leaks is encrypted data with an unknown key and a short retention window.</li>
</ul>

<h2>What E2EE does not protect</h2>

<p>This is the part that matters most, and it's usually glossed over.</p>

<ul>
  <li><strong>Metadata.</strong> Encryption hides <em>what</em> you said, not <em>that</em> you said it. The relay still sees which keys connect, when, how often, and roughly how much data moves. It cannot read plaintext, but traffic patterns are real information.</li>
  <li><strong>Your counterpart.</strong> The person you're talking to can screenshot, forward, or copy the conversation. E2EE protects you from third parties, never from the recipient.</li>
  <li><strong>A compromised device.</strong> If malware is on your phone or someone is watching your screen, encryption doesn't help — the attacker reads the message before it's encrypted or after it's decrypted. E2EE secures the channel, not your hardware.</li>
  <li><strong>Lost keys.</strong> There is no SMS recovery, no "forgot password" link. In MurMur, your key <em>is</em> your account. Lose it without a backup, and the account is gone along with access to past conversations.</li>
  <li><strong>Bugs.</strong> Encryption is code, and code has defects. A protocol can be sound and an implementation still flawed.</li>
</ul>

<table>
  <thead>
    <tr><th>Threat</th><th>Does E2EE help?</th></tr>
  </thead>
  <tbody>
    <tr><td>The relay operator reading your messages</td><td>Yes — that's the core point</td></tr>
    <tr><td>Interception on Wi-Fi or by the provider</td><td>Yes</td></tr>
    <tr><td>A leak of stored messages from the server</td><td>Mostly — only ciphertext leaks, kept for a limited time</td></tr>
    <tr><td>Learning who talks to whom and when</td><td>No</td></tr>
    <tr><td>Malware or someone with physical access to your phone</td><td>No</td></tr>
    <tr><td>You losing your key</td><td>No — and there is no SMS-based recovery</td></tr>
  </tbody>
</table>

<h2>An honest note about MurMur</h2>

<p>MurMur is a young, open-source project with a small audience. It has not gone through an independent security audit yet. The code is public, so anyone can review it — and we'd genuinely welcome such review — but "anyone can check" is not the same as "someone has checked and signed off". If your threat model requires audited software today, that's a legitimate reason to wait. We'd rather state this plainly than imply otherwise.</p>

<p>Two practical limitations are also worth knowing up front. As a PWA, MurMur depends on the browser it runs in: browser updates and quirks affect it like any web app. And because identity is a key rather than a phone number, backing that key up is your responsibility — it's both the strength of the model and its main sharp edge.</p>

<h2>FAQ</h2>

<dl>
  <dt><strong>Does E2EE mean the MurMur relay can't see anything at all?</strong></dt>
  <dd>It can't read message or call content. It does see connection-level facts: which key pairs are exchanging traffic and when, and it holds encrypted messages temporarily for delivery. That's metadata, and E2EE doesn't hide it.</dd>

  <dt><strong>What happens if I lose my key?</strong></dt>
  <dd>You lose the account. There's no SMS or email recovery because there's no phone number or email attached. A key backup is the only safety net.</dd>

  <dt><strong>Why does an encrypted messenger need a server at all?</strong></dt>
  <dd>To deliver messages when the recipient is offline, to route calls, and to deliver push notifications. The relay's job is transport and temporary encrypted storage — not reading. That's why "end-to-end" and "has a server" are not contradictory.</dd>

  <dt><strong>Is E2EE the same as the padlock in my browser?</strong></dt>
  <dd>No. Regular HTTPS (the padlock) encrypts traffic between you and the server, so the server can read everything. E2EE keeps the content encrypted all the way through, so only the two endpoints can read it.</dd>

  <dt><strong>Has MurMur been security audited?</strong></dt>
  <dd>Not yet by an external party. The source code is public on GitHub, and independent review is welcome. We consider this an open item, not a closed one.</dd>
</dl>

<p>E2EE is a strong and necessary layer, but it's one layer, not a guarantee of total safety. Knowing exactly where it ends is what makes it useful. If that trade-off set — no registration, no phone number, a relay that can't read plaintext, in exchange for key responsibility and a young, unaudited codebase — sounds reasonable to you, <a href="https://murmurchat.org">try MurMur at murmurchat.org</a>. It installs as a PWA on iPhone and Android without an app store, and the source is on GitHub.</p>

## RU

<h2>Что такое сквозное шифрование на самом деле</h2>

<p>Про сквозное шифрование (E2EE) слышали многие, а представляют его немногие. Смысл простой: сообщение шифруется на вашем устройстве и расшифровывается только на устройстве собеседника. Все, кто находится посередине — сервер, передающий сообщение, сеть, по которой оно идёт, компания, владеющая инфраструктурой, — видят только зашифрованный набор байтов и не могут его прочитать.</p>

<p>MurMur устроен так с самого начала. Здесь нет регистрации по номеру телефона или почте: ваша личность — это криптографический ключ, который выглядит как npub. Сообщения и звонки шифруются между двумя устройствами. Релей — небольшой сервер на Rust в Европе — передаёт зашифрованные данные и хранит их только в зашифрованном виде ограниченное время. Открытый текст на сервере не появляется никогда.</p>

<h2>Что защищает E2EE</h2>

<ul>
  <li><strong>Содержание переписки от сервера.</strong> Релей физически не может прочитать ваши сообщения, хотя именно он их хранит и пересылает.</li>
  <li><strong>Содержание от перехвата в сети.</strong> Сосед по Wi-Fi, провайдер, любой промежуточный узел видят шифротекст, а не диалог.</li>
  <li><strong>Звонки.</strong> Шифруется и аудио/видео разговоров, не только текст.</li>
  <li><strong>Сообщения при утечке с сервера.</strong> Если диск релея скопирован, утекут зашифрованные данные без ключа, да ещё и хранившиеся ограниченное время.</li>
</ul>

<h2>Что E2EE не защищает</h2>

<p>Это самая важная часть, о которой обычно говорят меньше всего.</p>

<ul>
  <li><strong>Метаданные.</strong> Шифрование прячет <em>что</em> вы сказали, но не <em>факт</em> разговора. Релей видит, какие ключи соединяются, когда, как часто и в каком примерно объёме идёт трафик. Открытый текст он не читает, но картина общения по служебным данным восстанавливается.</li>
  <li><strong>Собеседника.</strong> Человек, с которым вы говорите, может сделать скриншот, переслать или скопировать переписку. E2EE защищает от третьих лиц, но не от получателя.</li>
  <li><strong>Заражённое устройство.</strong> Если на телефоне вредоносная программа или экран кто-то подсматривает, шифрование бессильно: атакующий читает текст до шифрования или после расшифровки. E2EE защищает канал, а не ваше железо.</li>
  <li><strong>Потерянный ключ.</strong> Восстановления по SMS нет, кнопки «забыли пароль» нет. В MurMur ключ — это и есть аккаунт. Потеряли его без резервной копии — потеряли аккаунт и доступ к истории.</li>
  <li><strong>Ошибки в коде.</strong> Шифрование — это программа, а в программах бывают дефекты. Протокол может быть корректным, а реализация — нет.</li>
</ul>

<table>
  <thead>
    <tr><th>Угроза</th><th>Помогает ли E2EE?</th></tr>
  </thead>
  <tbody>
    <tr><td>Оператор релея читает переписку</td><td>Да — это и есть его основная задача</td></tr>
    <tr><td>Перехват в Wi-Fi или на стороне провайдера</td><td>Да</td></tr>
    <tr><td>Утечка хранимых сообщений с сервера</td><td>В основном да — утекает только шифротекст, и недолго хранившийся</td></tr>
    <tr><td>Узнать, кто с кем и когда общается</td><td>Нет</td></tr>
    <tr><td>Вредонос на телефоне или физический доступ к нему</td><td>Нет</td></tr>
    <tr><td>Вы потеряли ключ</td><td>Нет — восстановления по SMS не существует</td></tr>
  </tbody>
</table>

<h2>Честно про MurMur</h2>

<p>MurMur — молодой open-source проект с небольшой аудиторией. Независимого аудита безопасности он пока не проходил. Код открыт, проверить его может любой — и мы были бы рады такой проверке, — но «код доступен для проверки» и «проверка проведена» — разные вещи. Если ваша модель угроз требует именно аудированного ПО, подождать — разумное решение. Лучше сказать это прямо, чем делать вид, что проблемы нет.</p>

<p>Два практических ограничения стоит знать заранее. MurMur — это PWA, он зависит от браузера: обновления и особенности браузеров влияют на него так же, как на любой веб-приложение. А поскольку личность здесь — это ключ, а не номер телефона, резервная копия ключа — ваша ответственность. Это одновременно сила такой модели и её самое уязвимое место.</p>

<h2>Вопросы и ответы</h2>

<dl>
  <dt><strong>Значит ли E2EE, что релей MurMur вообще ничего не видит?</strong></dt>
  <dd>Содержание сообщений и звонков — нет, не видит. Но служебные данные ему доступны: какие пары ключей обмениваются трафиком и когда; зашифрованные сообщения он временно хранит для доставки. Это метаданные, и E2EE их не прячет.</dd>

  <dt><strong>Что будет, если я потеряю ключ?</strong></dt>
  <dd>Вы потеряете аккаунт. Восстановления через SMS или почту нет, потому что к аккаунту не привязаны ни номер, ни адрес. Единственная страховка — заранее сделанная резервная копия ключа.</dd>

  <dt><strong>Зачем шифрованному мессенджеру вообще сервер?</strong></dt>
  <dd>Чтобы доставлять сообщения, когда получатель не в сети, маршрутизировать звонки и доставлять push-уведомления. Задача релея — транспорт и временное зашифрованное хранение, а не чтение. Поэтому «сквозное шифрование» и «наличие сервера» друг другу не противоречат.</dd>

  <dt><strong>E2EE — это то же самое, что замочек в браузере?</strong></dt>
  <dd>Нет. Обычный HTTPS шифрует канал между вами и сервером — сервер читает всё. E2EE сохраняет содержимое зашифрованным на всём пути, и прочитать его могут только два устройства на концах.</dd>

  <dt><strong>MurMur проходил аудит безопасности?</strong></dt>
  <dd>Внешнего аудита пока не было. Исходный код открыт на GitHub, независимая проверка приветствуется. Мы считаем это открытым пунктом, а не закрытым.</dd>
</dl>

<p>Сквозное шифрование — важный и нужный слой защиты, но это один слой, а не гарантия полной безопасности. Польза от него появляется тогда, когда вы точно понимаете, где он заканчивается. Если такой набор компромиссов — без регистрации и номера телефона, с релеем, который не может прочитать переписку, но с ответственностью за свой ключ и молодым, ещё не аудированным кодом — вам подходит, <a href="https://murmurchat.org">попробуйте MurMur на murmurchat.org</a>. Он устанавливается как PWA на iPhone и Android без App Store и Google Play, а исходники лежат на GitHub.</p>
