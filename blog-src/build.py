#!/usr/bin/env python3
"""Build MurMur blog HTML pages from draft-NN markdown files."""
import re, html, os, datetime

DRAFTS = os.path.expanduser("~/.openclaw/workspace/murmur-blog")
OUT = os.path.expanduser("~/.openclaw/workspace/murmur-blog/site")

# Templates per article: (draft_file, en_slug, ru_slug)
ARTICLES = [
    ("draft-01-no-phone-number.md",
     ("messenger-without-phone-number", "Messenger Without a Phone Number: How MurMur Works",
      "MurMur is an E2EE messenger that needs no phone number or email. Your identity is a cryptographic key. Open source, runs in the browser."),
     ("messendzher-bez-nomera-telefona", "Мессенджер без номера телефона — MurMur",
      "MurMur — мессенджер с E2EE, которому не нужен номер телефона или почта. Личность на криптоключах, открытый код, работает в браузере.")),
    ("draft-02-signal-alternative.md",
     ("signal-alternative-without-phone-number", "Signal Alternative Without a Phone Number: Honest Look",
      "Signal, WhatsApp, Session and MurMur compared: registration, E2EE, metadata, calls, install. Where a phone number is required and where it isn't."),
     ("analog-signal-bez-nomera-telefona", "Аналог Signal без номера телефона: честное сравнение",
      "Signal, WhatsApp, Session и MurMur: регистрация, шифрование, метаданные, звонки. Где нужен номер телефона, а где нет.")),
    ("draft-03-pwa-messenger.md",
     ("encrypted-messenger-in-browser-pwa", "How to Use an Encrypted Messenger in Your Browser (PWA)",
      "MurMur is an E2EE messenger that runs as a PWA. No app store needed — install it from the browser, add contacts by npub, chat and call."),
     ("zashchishchyonnyy-messendzher-v-brauzere-pwa", "Защищённый мессенджер в браузере: как пользоваться PWA",
      "MurMur — E2EE мессенджер в формате PWA. Без магазинов приложений: устанавливается из браузера, контакты по npub, звонки и пуши.")),
    ("draft-04-e2ee-explained.md",
     ("e2ee-explained-what-it-protects", "End-to-End Encryption, Explained Honestly",
      "What end-to-end encryption protects — and what it doesn't: metadata, backups, lost keys, compromised devices. Plus an honest note on MurMur's audit status."),
     ("skvoznoe-shifrovanie-prosto", "Сквозное шифрование: честно и без пафоса",
      "Что защищает сквозное шифрование, а что нет: метаданные, бэкапы, потерянный ключ, заражённый телефон. И честное слово про аудит MurMur.")),
    ("draft-05-pwa-vs-native.md",
     ("pwa-messenger-vs-native-app", "MurMur is a PWA messenger: what that means in practice",
      "What a PWA messenger can and cannot do compared to a native app — push, calls, offline, and why skipping the app stores is a feature, not a bug."),
     ("pwa-messendzher-ili-nativnoe-prilozhenie", "MurMur — PWA-мессенджер: что это значит на практике",
      "Чем PWA-мессенджер отличается от обычного приложения: пуш-уведомления, звонки, офлайн — и почему отсутствие в сторах это плюс, а не минус.")),
    ("draft-06-why-no-accounts.md",
     ("why-no-accounts", "A messenger with no accounts, no phone numbers, no emails",
      "Why MurMur replaces phone-number identity with a cryptographic key, what that solves, what it costs, and how a relay that can't read your messages works."),
     ("pochemu-bez-akkauntov", "Мессенджер без аккаунтов: почему так и что это значит",
      "Почему MurMur заменяет номер телефона криптографическим ключом, что это даёт и чего лишает. Как работает релей, который не может прочитать переписку.")),
]

PAGE_TMPL = """<!DOCTYPE html>
<html lang="{lang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>{title}</title>
<meta name="description" content="{descr}">
<link rel="canonical" href="https://murmurchat.org/blog/{slug}/">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{descr}">
<meta property="og:type" content="article">
<meta property="og:url" content="https://murmurchat.org/blog/{slug}/">
<link rel="icon" type="image/png" sizes="32x32" href="/fav32-2026b.png">
<style>
  :root {{ --bg:#0f1620; --card:rgba(255,255,255,.045); --accent:#229ED9; --accent2:#5eead4; --text:#e8eef5; --muted:#9fb0c3; }}
  * {{ margin:0; padding:0; box-sizing:border-box; }}
  body {{ min-height:100vh; background:var(--bg); color:var(--text);
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    padding:28px 20px 60px;
    background-image: radial-gradient(ellipse 60% 35% at 20% 0%, rgba(34,158,217,.13), transparent),
      radial-gradient(ellipse 50% 45% at 85% 100%, rgba(94,234,212,.08), transparent); }}
  .wrap {{ max-width:720px; margin:0 auto; }}
  .back {{ display:inline-block; color:var(--accent); text-decoration:none; font-size:14px; margin-bottom:18px; }}
  h1 {{ font-size:30px; font-weight:800; letter-spacing:-.5px; line-height:1.2; margin-bottom:8px;
    background:linear-gradient(90deg,var(--accent),var(--accent2));
    -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent; }}
  h2 {{ font-size:20px; font-weight:700; margin:28px 0 10px; color:var(--text); }}
  h3 {{ font-size:16px; font-weight:700; margin:18px 0 6px; color:var(--text); }}
  p {{ font-size:15px; line-height:1.7; color:var(--muted); margin-bottom:12px; }}
  ul, ol {{ margin:0 0 14px 22px; }}
  li {{ font-size:15px; line-height:1.7; color:var(--muted); margin-bottom:6px; }}
  a {{ color:var(--accent); }}
  strong {{ color:var(--text); }}
  table {{ border-collapse:collapse; width:100%; margin:14px 0 18px; font-size:13.5px; }}
  th, td {{ border:1px solid rgba(255,255,255,.12); padding:8px 10px; text-align:left; vertical-align:top; color:var(--muted); line-height:1.5; }}
  th {{ background:rgba(34,158,217,.12); color:var(--text); font-weight:700; }}
  td:first-child {{ color:var(--text); font-weight:600; white-space:nowrap; }}
  .cta {{ background:var(--card); border:1px solid rgba(255,255,255,.08); border-radius:16px; padding:18px 20px; margin:26px 0; text-align:center; }}
  .cta a {{ display:inline-block; background:linear-gradient(90deg,var(--accent),#1d8ac4); color:#fff; text-decoration:none; font-weight:700; font-size:15px; padding:12px 26px; border-radius:12px; }}
  .meta-line {{ color:var(--muted); font-size:13px; margin-bottom:22px; }}
  .faq {{ background:var(--card); border:1px solid rgba(255,255,255,.08); border-radius:18px; padding:20px 18px; margin-top:26px; }}
  .faq h2 {{ margin-top:0; }}
  .footer {{ text-align:center; margin-top:40px; color:var(--muted); font-size:13px; }}
  .footer a {{ color:var(--accent); text-decoration:none; }}
</style>
</head>
<body>
<div class="wrap">
<a class="back" href="/blog/">← Blog</a>
<h1>{title_h1}</h1>
<div class="meta-line">{date} · MurMur team</div>
{content}
<div class="cta"><a href="https://murmurchat.org">Try MurMur — no phone, no email →</a></div>
<div class="footer"><a href="https://murmurchat.org">murmurchat.org</a> · <a href="https://github.com/Oleg2796996/murmur">GitHub</a> · <a href="/privacy">Privacy</a></div>
</div>
</body>
</html>
"""

INDEX_TMPL = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>MurMur Blog — Private Messaging, Explained</title>
<meta name="description" content="Articles about private messengers: no phone numbers, E2EE, PWA install, honest comparisons with Signal and Session.">
<link rel="canonical" href="https://murmurchat.org/blog/">
<meta property="og:title" content="MurMur Blog">
<meta property="og:description" content="Articles about private messengers: no phone numbers, E2EE, PWA.">
<link rel="icon" type="image/png" sizes="32x32" href="/fav32-2026b.png">
<style>
  :root {{ --bg:#0f1620; --card:rgba(255,255,255,.045); --accent:#229ED9; --accent2:#5eead4; --text:#e8eef5; --muted:#9fb0c3; }}
  * {{ margin:0; padding:0; box-sizing:border-box; }}
  body {{ min-height:100vh; background:var(--bg); color:var(--text);
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; padding:28px 20px 60px;
    background-image: radial-gradient(ellipse 60% 35% at 20% 0%, rgba(34,158,217,.13), transparent); }}
  .wrap {{ max-width:720px; margin:0 auto; }}
  h1 {{ font-size:30px; font-weight:800; margin-bottom:6px;
    background:linear-gradient(90deg,var(--accent),var(--accent2));
    -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent; }}
  .sub {{ color:var(--muted); font-size:14px; margin-bottom:26px; }}
  .post {{ background:var(--card); border:1px solid rgba(255,255,255,.08); border-radius:18px; padding:20px 22px; margin-bottom:14px; display:block; text-decoration:none; }}
  .post:hover {{ border-color:rgba(34,158,217,.4); }}
  .post h2 {{ font-size:18px; font-weight:700; color:var(--text); margin-bottom:6px; }}
  .post p {{ color:var(--muted); font-size:14px; line-height:1.6; margin:0; }}
  .footer {{ text-align:center; margin-top:40px; color:var(--muted); font-size:13px; }}
  .footer a {{ color:var(--accent); text-decoration:none; }}
</style>
</head>
<body>
<div class="wrap">
<h1>MurMur Blog</h1>
<div class="sub">Private messaging, explained honestly.</div>
{items}
<div class="footer"><a href="https://murmurchat.org">murmurchat.org</a> · <a href="https://github.com/Oleg2796996/murmur">GitHub</a></div>
</div>
</body>
</html>
"""

TODAY = datetime.date.today().isoformat()

def extract_sections(md_text):
    """Return (en_html, ru_html) from draft markdown: strip meta, keep html blocks."""
    parts = re.split(r"^## (EN|RU)\s*$", md_text, flags=re.M)
    # parts: [pre, 'EN', en_body, 'RU', ru_body]
    result = {}
    if len(parts) >= 3:
        result["EN"] = parts[2]
    if len(parts) >= 5:
        result["RU"] = parts[4]
    return result

def clean_body(body):
    # Strip duplicate markdown h1 (template already renders <h1> from title)
    body = re.sub(r"^\s*<h1>.*?</h1>\s*$", "", body, count=1, flags=re.M | re.S) if body.count("<h1>") == 1 else re.sub(r"^#\s+.*$", "", body, flags=re.M)
    return body.strip()

def wrap_faq_and_cta(body):
    # Add CTA box before FAQ if present: simple — leave body as-is; CTA added by template.
    return body

def build():
    os.makedirs(OUT, exist_ok=True)
    index_items = []
    for draft, en_meta, ru_meta in ARTICLES:
        with open(os.path.join(DRAFTS, draft)) as f:
            md = f.read()
        secs = extract_sections(md)
        for lang, (slug, title, descr) in (("EN", en_meta), ("RU", ru_meta)):
            body = clean_body(secs.get(lang, ""))
            if not body:
                print(f"WARN: empty body for {draft} {lang}")
                continue
            page = PAGE_TMPL.format(lang=lang.lower(), title=html.escape(title),
                                    descr=html.escape(descr), slug=slug,
                                    title_h1=html.escape(title), date=TODAY,
                                    content=body)
            d = os.path.join(OUT, "blog", slug)
            os.makedirs(d, exist_ok=True)
            with open(os.path.join(d, "index.html"), "w") as f:
                f.write(page)
            print(f"OK {lang} /blog/{slug}/ ({len(body)} bytes body)")
        index_items.append(
            f'<a class="post" href="/blog/{en_meta[0]}/"><h2>{html.escape(en_meta[1])}</h2><p>{html.escape(en_meta[2])}</p></a>')
        index_items.append(
            f'<a class="post" href="/blog/{ru_meta[0]}/"><h2>{html.escape(ru_meta[1])}</h2><p>{html.escape(ru_meta[2])}</p></a>')
    idx = INDEX_TMPL.format(items="\n".join(index_items))
    os.makedirs(os.path.join(OUT, "blog"), exist_ok=True)
    with open(os.path.join(OUT, "blog", "index.html"), "w") as f:
        f.write(idx)
    print("OK /blog/ index")

if __name__ == "__main__":
    build()
