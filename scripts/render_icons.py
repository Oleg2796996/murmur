#!/usr/bin/env python3
"""Render murmur app icon SVG -> PNG set (512/192/180/32) via Playwright chromium.
Usage: render_icons.py <input.svg> <outdir>
"""
import asyncio
import base64
import sys
from pathlib import Path

SIZES = {"icon-512.png": 512, "icon-192.png": 192, "apple-touch-icon.png": 180, "favicon-32.png": 32, "og-image.png": 1200}


async def render(svg_path: Path, outdir: Path) -> None:
    from playwright.async_api import async_playwright

    svg = svg_path.read_text(encoding="utf-8")
    b64 = base64.b64encode(svg.encode("utf-8")).decode("ascii")
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            executable_path="/home/oleg/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell"
        )
        for name, size in SIZES.items():
            page = await browser.new_page(viewport={"width": size, "height": size})
            html = (
                f"<html><body style='margin:0;padding:0;overflow:hidden'>"
                f"<img src='data:image/svg+xml;base64,{b64}' "
                f"style='display:block;width:{size}px;height:{size}px'></body></html>"
            )
            await page.set_content(html)
            await page.wait_for_timeout(300)
            await page.screenshot(path=str(outdir / name), clip={"x": 0, "y": 0, "width": size, "height": size})
            await page.close()
            print(f"rendered {name} ({size}px)")
        await browser.close()


if __name__ == "__main__":
    src = Path(sys.argv[1])
    out = Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    asyncio.run(render(src, out))