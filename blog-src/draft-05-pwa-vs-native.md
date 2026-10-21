# Draft 05 — PWA messenger vs native app

## META
title_en: MurMur is a PWA messenger: what that means in practice
title_ru: MurMur — PWA-мессенджер: что это значит на практике
description_en: What a PWA messenger can and cannot do compared to a native app — push, calls, offline, and why skipping the app stores is a feature, not a bug.
description_ru: Чем PWA-мессенджер отличается от обычного приложения: пуш-уведомления, звонки, офлайн — и почему отсутствие в сторах это плюс, а не минус.
slug_en: pwa-messenger-vs-native-app
slug_ru: pwa-messendzher-ili-nativnoe-prilozhenie

## EN

<h2>What a PWA actually is</h2>

<p>A PWA (Progressive Web App) is a website that behaves like an installed application. You open murmurchat.org in your browser, choose "Add to Home Screen" — and the messenger gets its own icon, opens full-screen without browser bars, and keeps working after you close the tab. Under the hood it is still web technology (HTML, JavaScript, a service worker), but from the user's point of view the difference from a native app is smaller than most people expect.</p>

<p>MurMur is built this way on purpose. You install it on an iPhone or an Android phone without App Store or Google Play, without an account tied to your phone number or email — your identity is a cryptographic key (an npub), generated on your device.</p>

<h2>What a PWA can do today</h2>

<p>The stereotype that "web apps are toy apps" is about ten years out of date. Modern browsers expose most of the APIs a messenger needs:</p>

<ul>
  <li><strong>Push notifications.</strong> On both Android and iOS, MurMur can wake you up when a message arrives, even with the app closed. On iOS this became possible in 2023, when Safari added Web Push support.</li>
  <li><strong>Camera and microphone.</strong> Voice and video calls work through the standard WebRTC interfaces. Encrypted calls in MurMur go through the same channels as in any native messenger.</li>
  <li><strong>Offline behavior.</strong> A service worker caches the app shell, so the messenger opens even with a poor connection. Messages you send while offline are queued and delivered later.</li>
  <li><strong>Background sync and clipboard, file sharing, contacts picker</strong> — support varies by platform, but the basics are there.</li>
</ul>

<h2>What a PWA cannot do — honestly</h2>

<p>There are real limitations, and we would rather list them than pretend they don't exist:</p>

<ul>
  <li><strong>Everything depends on the browser.</strong> A PWA runs inside the browser engine of your device. If the browser breaks, the app breaks with it. You cannot fix this on our side.</li>
  <li><strong>iOS is the weakest platform.</strong> Safari's Web Push needs the app added to the home screen; notifications are coarser than native ones; some web APIs are still missing or throttled. Apple has been improving this yearly, but Android remains the more complete PWA platform.</li>
  <li><strong>Some system integrations are limited.</strong> Deep OS-level hooks — custom widgets, tight Siri or Google Assistant integration, system-wide share targets in every context — are either absent or partial.</li>
  <li><strong>Storage can be stricter.</strong> Browsers can, in rare cases (long periods of non-use, low disk space), clear website data. For a messenger whose account <em>is</em> your cryptographic key, we recommend backing up your key regardless — losing it means losing the account, with no SMS-based recovery, by design.</li>
</ul>

<h2>Why no app store is a feature, not a bug</h2>

<p>The absence of MurMur from App Store and Google Play is often read as a sign of an unfinished product. It is closer to the opposite — a deliberate trade with concrete benefits:</p>

<ul>
  <li><strong>No gatekeeper in the middle.</strong> App stores can reject, delay, or remove apps according to their own policies. A PWA is published at a URL, and what ships is what we built. For a messenger whose main promise is that nobody can read your messages, not depending on a platform's approval is consistent with the idea.</li>
  <li><strong>Updates are instant.</strong> You reload the page and you are on the new version. No review queue, no waiting days for an update to propagate, no forced upgrade screens.</li>
  <li><strong>Smaller footprint.</strong> There is no hundreds-of-megabytes download; the app installs in seconds and takes a fraction of the space.</li>
  <li><strong>Same app on every device.</strong> One codebase runs on Android, iOS, and desktop browsers alike.</li>
</ul>

<p>The honest cost side: store listing also brings discoverability and a baseline of trust that "a website" does not automatically have. MurMur is a young project with a small audience and no independent security audit yet, so we do not claim that skipping the stores makes it more trustworthy — the code is open source, and that is where scrutiny should come from, not from a review queue.</p>

<h2>PWA vs native app: the short version</h2>

<table>
  <thead>
    <tr><th></th><th>PWA (MurMur)</th><th>Native app</th></tr>
  </thead>
  <tbody>
    <tr><td>Install</td><td>From the website, seconds</td><td>App store, account, download</td></tr>
    <tr><td>Updates</td><td>Instant, on reload</td><td>Store review + rollout</td></tr>
    <tr><td>Push notifications</td><td>Yes (iOS: since Safari 16.4)</td><td>Yes</td></tr>
    <tr><td>E2EE calls</td><td>Yes, via WebRTC</td><td>Yes</td></tr>
    <tr><td>OS integration</td><td>Partial, browser-dependent</td><td>Full</td></tr>
    <tr><td>Gatekeeper</td><td>None</td><td>Store policies apply</td></tr>
  </tbody>
</table>

<h2>FAQ</h2>

<h3>Do I need to install anything from an app store?</h3>
<p>No. Open murmurchat.org in your browser and add it to the home screen. That is the whole installation process.</p>

<h3>Do push notifications really work on iPhone?</h3>
<p>Yes, as long as the PWA is added to the home screen (this is a Safari requirement, not ours). Notification formatting and reliability are somewhat behind Android.</p>

<h3>Can I make voice and video calls?</h3>
<p>Yes. Calls are end-to-end encrypted and use the browser's camera and microphone, which you grant per site.</p>

<h3>What happens if I clear my browser data?</h3>
<p>You may lose the locally stored key, and with it access to your account — there is no SMS or email recovery. Back up your key. This is a property of the key-based identity model, not of PWAs specifically.</p>

<h3>Why should I trust a messenger that isn't in the stores?</h3>
<p>You shouldn't take our word for it in any case. The relay and client code is open source; the relay is built so it cannot read plaintext and stores encrypted messages only for a limited time. MurMur is young, unaudited, and small — use it accordingly, and read the code if you can.</p>

<p><strong>Try it:</strong> open <a href="https://murmurchat.org">murmurchat.org</a>, add it to your home screen, and see whether a PWA covers what you need.</p>

## RU

<h2>Что такое PWA на самом деле</h2>

<p>PWA (Progressive Web App) — это сайт, который ведёт себя как установленное приложение. Вы открываете murmurchat.org в браузере, выбираете «Добавить на экран "Домой"» — и мессенджер получает свою иконку, открывается на весь экран без адресной строки и продолжает работать после закрытия вкладки. Под капотом — всё те же веб-технологии: HTML, JavaScript, service worker. Но с точки зрения пользователя разница с обычным приложением меньше, чем принято думать.</p>

<p>MurMur сделан как PWA осознанно. Он устанавливается на iPhone или Android-телефон без App Store и Google Play, без регистрации по номеру телефона или почте: личность — это криптографический ключ (npub), который генерируется на вашем устройстве.</p>

<h2>Что PWA умеет сегодня</h2>

<p>Представление о том, что «веб-приложения — это игрушки», устарело лет на десять. Современные браузеры дают почти всё, что нужно мессенджеру:</p>

<ul>
  <li><strong>Пуш-уведомления.</strong> И на Android, и на iOS приложение может разбудить вас при новом сообщении, даже если оно закрыто. На iOS это заработало в 2023 году, когда Safari добавил поддержку Web Push.</li>
  <li><strong>Камера и микрофон.</strong> Звонки работают через стандартный WebRTC. Зашифрованные звонки в MurMur идут по тем же каналам, что и в любом нативном мессенджере.</li>
  <li><strong>Офлайн.</strong> Service worker кэширует интерфейс, поэтому мессенджер открывается даже при плохой связи. Отправленные без сети сообщения встают в очередь и уходят позже.</li>
  <li><strong>Обмен файлами, буфер обмена, выбор контактов</strong> — поддержка зависит от платформы, но базовое есть.</li>
</ul>

<h2>Чего PWA не умеет — честно</h2>

<p>Ограничения реальные, и лучше перечислить их прямо, чем делать вид, что их нет:</p>

<ul>
  <li><strong>Всё зависит от браузера.</strong> PWA работает внутри браузерного движка вашего устройства. Сломался браузер — сломалось приложение. Починить это с нашей стороны невозможно.</li>
  <li><strong>iOS — самая слабая платформа.</strong> Web Push в Safari требует добавить приложение на домашний экран; уведомления грубее нативных; часть веб-API отсутствует или урезана. Apple улучшает ситуацию каждый год, но Android остаётся более полной платформой для PWA.</li>
  <li><strong>Системная интеграция ограничена.</strong> Глубокие интеграции с ОС — виджеты, плотная работа с Siri или Google Assistant, системные меню «поделиться» во всех контекстах — либо недоступны, либо работают частично.</li>
  <li><strong>Хранилище строже.</strong> Браузер в редких случаях (долгое неиспользование, нехватка места) может очистить данные сайта. Для мессенджера, где аккаунт — это ваш ключ, мы в любом случае советуем сделать резервную копию ключа: потеря ключа означает потерю аккаунта, восстановление по SMS не предусмотрено. Это не особенность PWA, а свойство модели идентификации.</li>
</ul>

<h2>Почему отсутствие в сторах — это фича, а не баг</h2>

<p>То, что MurMur нет в App Store и Google Play, часто читают как признак сырого продукта. На деле это скорее осознанный размен, и у него есть конкретные плюсы:</p>

<ul>
  <li><strong>Нет посредника с правом вето.</strong> Стор может отклонить, замедлить или удалить приложение по своим правилам. PWA публикуется по адресу, и пользователю уходит ровно то, что мы собрали. Для мессенджера, чьё главное обещание — «никто не прочтёт ваши сообщения», независимость от одобрения платформы логична.</li>
  <li><strong>Обновления мгновенные.</strong> Перезагрузили страницу — вы на новой версии. Ни очереди на ревью, ни многодневного раскатывания, ни экранов «принудительно обновитесь».</li>
  <li><strong>Меньше веса.</strong> Нет загрузки на сотни мегабайт: установка занимает секунды, а места приложение занимает в разы меньше.</li>
  <li><strong>Одно приложение на все устройства.</strong> Android, iPhone, десктопный браузер — код один.</li>
</ul>

<p>Про честную обратную сторону: присутствие в сторе даёт заметность и базовое доверие, которых у «просто сайта» по умолчанию нет. MurMur — молодой проект с небольшой аудиторией, независимого аудита безопасности пока не было. Мы не утверждаем, что обход сторов делает нас надёжнее: код открыт, и проверять стоит его, а не очередь на модерацию.</p>

<h2>PWA или нативное приложение: коротко</h2>

<table>
  <thead>
    <tr><th></th><th>PWA (MurMur)</th><th>Нативное приложение</th></tr>
  </thead>
  <tbody>
    <tr><td>Установка</td><td>С сайта, секунды</td><td>Стор, аккаунт, загрузка</td></tr>
    <tr><td>Обновления</td><td>Мгновенно, при перезагрузке</td><td>Ревью стора + раскатка</td></tr>
    <tr><td>Пуш-уведомления</td><td>Да (iOS: с Safari 16.4)</td><td>Да</td></tr>
    <tr><td>E2EE-звонки</td><td>Да, через WebRTC</td><td>Да</td></tr>
    <tr><td>Интеграция с ОС</td><td>Частичная, зависит от браузера</td><td>Полная</td></tr>
    <tr><td>Посредник</td><td>Нет</td><td>Правила стора</td></tr>
  </tbody>
</table>

<h2>FAQ</h2>

<h3>Нужно ли что-то устанавливать из стора?</h3>
<p>Нет. Откройте murmurchat.org в браузере и добавьте на домашний экран — это вся установка.</p>

<h3>Пуш-уведомления правда работают на iPhone?</h3>
<p>Да, если PWA добавлена на домашний экран (это требование Safari, не наше). По оформлению и надёжности уведомления на iOS уступают Android.</p>

<h3>Можно ли звонить голосом и по видео?</h3>
<p>Да. Звонки зашифрованы сквозным шифрованием и используют камеру и микрофон браузера — доступ выдаётся отдельно для сайта.</p>

<h3>Что будет, если я очищу данные браузера?</h3>
<p>Вы можете потерять локально сохранённый ключ, а с ним и доступ к аккаунту — восстановления по SMS или почте нет. Сделайте резервную копию ключа.</p>

<h3>Почему мне доверять мессенджеру, которого нет в сторах?</h3>
<p>В любом случае не на слово. Код клиента и релея открыт; релей устроен так, что не может прочитать содержимое сообщений, и хранит их в зашифрованном виде ограниченное время. MurMur молод, не проходил аудит и пока небольшой — пользуйтесь с этим пониманием и, если можете, читайте код.</p>

<p><strong>Попробовать:</strong> откройте <a href="https://murmurchat.org">murmurchat.org</a>, добавьте на домашний экран — и решите, хватает ли вам возможностей PWA.</p>
