# Draft 08 — Recent improvements (devlog)

## META
- title_en: "What we fixed in MurMur lately: a plain devlog"
- title_ru: "Что мы исправили в MurMur: обычный девлог"
- description_en: "Reliable offline delivery, missed-call notifications, camera flip, no more duplicate photos after reconnect, and updates without reinstalling. Honest notes from a young project."
- description_ru: "Доставка офлайн-сообщений, пропущенные вызовы, переключение камеры, дедупликация после переподключения и обновления без переустановки. Честные заметки молодого проекта."
- slug_en: "recent-improvements-devlog"
- slug_ru: "nedavnie-uluchsheniya-devlog"

## EN

<p>MurMur is a young project, and it behaves like one: sometimes things break, we notice, and we fix them. This post is a plain devlog about a batch of recent fixes — what the problem was and what we changed. No version numbers, no roadmap promises, just what shipped.</p>

<h2>Messages sent offline now actually get delivered</h2>

<p>The most annoying bug we had: if you sent a message while offline or while the connection was flaky, that message could sit in the outbox and never leave. It looked sent on your side. The other person never saw it. For a messenger, that's about the worst failure mode there is, because both sides think the conversation is fine.</p>

<p>We rebuilt the outbox path. Now anything you send while offline is kept locally and automatically re-sent the moment you're back online. The delivery logic no longer assumes you had a stable connection when you hit "send" — because on phones, you often don't. This also covers the common case of writing messages in the metro or on a train and forgetting about them until later.</p>

<h2>Missed-call push notifications</h2>

<p>MurMur has end-to-end encrypted calls, but there was a gap: if you weren't in the app when someone called, the call simply evaporated. No trace, no notification. You'd find out about the attempt only if the person texted you afterwards.</p>

<p>Now a missed call triggers a push notification. You see who tried to reach you and can call back from the notification itself. This works through the same encrypted-notification pipeline as regular messages — the relay that delivers pushes doesn't get to read your conversations, and it doesn't learn anything new about calls either beyond what's needed to route the notification.</p>

<h2>Camera flip during calls</h2>

<p>Small thing, big quality-of-life difference: you can now switch between front and back camera mid-call without hanging up. Before, showing something with the rear camera meant ending the call and starting a new one. That's fixed.</p>

<h2>No more duplicate photos and texts after reconnecting</h2>

<p>Another bug from the unstable-connection family: after a reconnect, some photos and text messages could appear twice — or more. The sender's client wasn't always sure whether a previous attempt went through, so it retried, and the receiving side didn't recognize the retry as the same message.</p>

<p>We added deduplication on reconnect. The client now tracks what it has already received, and repeated deliveries of the same photo or text are collapsed into one. Your chat history stays the way it should: one message is one message, even if the network dropped three times in the middle.</p>

<h2>Updates without reinstalling</h2>

<p>MurMur is a PWA — it installs on iPhone and Android straight from the browser, without the App Store or Google Play. That has a nice side effect for updates: there's nothing to reinstall. When we ship a fix, the app picks it up from the web on its own, like a regular website. Next time you open MurMur, you're on the current version.</p>

<p>For a small team, this matters a lot. We can fix a bug and have it reach everyone within a day, instead of waiting days for store review on two platforms. It also means we can be honest about the trade-off: the app depends on your browser. If the browser is outdated or the vendor breaks something in PWA support, that affects us too. That's a limitation we accept and keep an eye on.</p>

<h2>What we're not going to pretend</h2>

<p>MurMur is open source, young, and has a small audience. There has been no independent security audit. Identity in MurMur is a cryptographic key (an npub) — there's no phone number or email to register with, which also means: lose the key, lose the account. There's no SMS recovery, by design, because there's nothing to send an SMS to. These are real limitations, not fine print.</p>

<p>Why do we write changelogs like this one? Partly because a small project earns trust by being specific about what changed — and about what can go wrong. If we ship a fix for a delivery bug, that means the delivery bug existed. We'd rather say so.</p>

<h2>FAQ</h2>

<h3>I sent a message while offline. What happens now?</h3>
<p>It stays in the outbox and is delivered automatically once you're back online. You don't need to resend it or keep the chat open.</p>

<h3>Do missed-call notifications show message content?</h3>
<p>They show who called you. Calls and messages are end-to-end encrypted, and the relay can't read your conversations.</p>

<h3>How do I update the app?</h3>
<p>You don't have to do anything. As a PWA installed from the browser, MurMur updates itself from the web — no App Store, no Google Play, no reinstalling.</p>

<h3>What if I lose my key?</h3>
<p>You lose access to the account. There is no SMS or email recovery, because registration doesn't involve a phone number or email. Back up your key carefully.</p>

<p>MurMur is free and open source — try it at <a href="https://murmurchat.org">murmurchat.org</a> or read the code on <a href="https://github.com/Oleg2796996/murmur">GitHub</a>.</p>

## RU

<p>MurMur — молодой проект, и он ведёт себя соответствующе: иногда что-то ломается, мы это замечаем и чиним. Этот текст — обычный девлог о серии недавних исправлений: в чём была проблема и что мы поменяли. Без номеров версий, без обещаний на год вперёд — только то, что уже работает.</p>

<h2>Сообщения, отправленные офлайн, теперь действительно доходят</h2>

<p>Самая неприятная ошибка, которая у нас была: если отправить сообщение без сети или при нестабильном соединении, оно могло застрять в исходящих и больше никогда не уйти. У вас оно выглядело отправленным. Собеседник его не видел. Для мессенджера это худший сценарий из возможных: обе стороны уверены, что переписка в порядке.</p>

<p>Мы переписали работу с исходящими. Теперь всё, что вы отправляете офлайн, хранится на устройстве и автоматически уходит, как только связь вернётся. Логика доставки больше не предполагает, что в момент нажатия «отправить» у вас было стабильное соединение — на телефоне это, честно говоря, редкость. Заодно закрылся бытовой сценарий: написать пару сообщений в метро и вспомнить о них через час.</p>

<h2>Push-уведомления о пропущенных вызовах</h2>

<p>В MurMur есть сквозное шифрование звонков, но была дыра: если вы не сидели в приложении в момент звонка, звонок просто исчезал. Без следа, без уведомления. О попытке вы узнавали, только если человек писал вам после этого текстом.</p>

<p>Теперь пропущенный вызов приходит пуш-уведомлением. Видно, кто звонил, и можно перезвонить прямо из уведомления. Работает это через тот же конвейер шифрованных уведомлений, что и обычные сообщения: релей, который доставляет пуши, не может прочитать вашу переписку, и о звонках он знает не больше, чем нужно для доставки самого уведомления.</p>

<h2>Переключение камеры во время звонка</h2>

<p>Мелочь, но заметная: во время звонка можно переключиться с фронтальной камеры на основную и обратно, не сбрасывая вызов. Раньше, чтобы что-то показать основной камерой, приходилось завершать звонок и набирать заново. Исправлено.</p>

<h2>Дубликаты фото и текстов после переподключения</h2>

<p>Ещё одна ошибка из семейства «нестабильная сеть»: после переподключения некоторые фото и текстовые сообщения могли появиться в чате дважды, а то и трижды. Отправляющий клиент не всегда был уверен, ушла ли предыдущая попытка, и повторял её, а принимающая сторона не распознавала повтор как то же самое сообщение.</p>

<p>Мы добавили дедупликацию при переподключении. Клиент теперь помнит, что уже получил, и повторные доставки одного и того же фото или текста схлопываются в одно сообщение. История переписки остаётся такой, какой должна быть: одно сообщение — одна запись, даже если сеть отвалилась три раза посреди разговора.</p>

<h2>Обновления без переустановки</h2>

<p>MurMur — это PWA: приложение ставится на iPhone и Android прямо из браузера, без App Store и Google Play. У этого есть приятный побочный эффект в отношении обновлений: переустанавливать нечего. Когда мы выпускаем исправление, приложение подхватывает его из сети само, как обычный сайт. Открываете MurMur в следующий раз — вы уже на актуальной версии.</p>

<p>Для маленькой команды это важно: мы можем починить баг, и через день он будет у всех, без многодневных модераций в двух сторах. Но за это приходится платить зависимостью от браузера: если браузер устарел или производитель что-то сломал в поддержке PWA, это бьёт и по нам. Мы об этом ограничении знаем и следим за ним.</p>

<h2>Чего мы не будем приукрашивать</h2>

<p>MurMur — проект с открытым исходным кодом, молодой, с небольшой аудиторией. Независимого аудита безопасности не было. Личность в MurMur — это криптографический ключ (npub), без телефона и почты при регистрации. Из этого следует жёсткое правило: потеряли ключ — потеряли аккаунт. Восстановления по SMS нет, и это осознанно: восстанавливать нечем, номера же нет. Это реальные ограничения, а не мелкий шрифт.</p>

<p>Зачем тогда вообще писать такие ченджлоги? Отчасти потому, что небольшой проект зарабатывает доверие конкретикой: что поменялось и что может пойти не так. Если мы отчитываемся о починке доставки — значит, доставка раньше была сломана. Мы предпочитаем говорить об этом прямо.</p>

<h2>FAQ</h2>

<h3>Я отправил сообщение без сети. Что теперь с ним будет?</h3>
<p>Оно останется в исходящих и уйдёт автоматически, когда связь появится. Пересылать его заново или держать чат открытым не нужно.</p>

<h3>Видно ли в уведомлении о пропущенном звонке содержание переписки?</h3>
<p>В уведомлении видно, кто звонил. Звонки и сообщения шифруются сквозным шифрованием, релей не может их прочитать.</p>

<h3>Как обновить приложение?</h3>
<p>Ничего делать не нужно. MurMur — PWA, установленный из браузера: обновления приходят из сети сами, без сторов и переустановок.</p>

<h3>Что делать, если я потерял ключ?</h3>
<p>Доступ к аккаунту будет потерян. Восстановления по SMS или почте нет, потому что при регистрации не используются ни номер, ни почта. Делайте резервную копию ключа аккуратно.</p>

<p>MurMur бесплатный и открытый — попробуйте на <a href="https://murmurchat.org">murmurchat.org</a> или посмотрите код на <a href="https://github.com/Oleg2796996/murmur">GitHub</a>.</p>
