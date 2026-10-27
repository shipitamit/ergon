"""Browser control — let an agent navigate, read, and act on real web pages.

Wraps Playwright (Chromium) behind a small set of agent tools. Because a
browsing agent can submit forms, make purchases, and read credentials, this
module is built defensively:

  * READ tools (navigate, read_page, find, screenshot) are marked safe.
  * ACT tools (click, type_text, submit, press_key) are NOT safe — they go
    through the ApprovalPolicy, so an unattended run denies them unless you add
    a standing allow-rule. Acting on the open web unattended is dangerous.
  * Navigation is guarded: only http(s), and internal/loopback/link-local hosts
    are blocked (SSRF), matching the HTTP-tool guard.
  * Page content handed back to the model is a prompt-injection surface. A
    malicious page can contain text like "ignore your instructions…". Keep the
    agent on trusted sites, keep act-tools behind approval, and never run a
    browsing agent unattended against untrusted input.

Playwright is an optional dependency:

    pip install ergon[browser]     # installs playwright
    playwright install chromium         # one-time browser download

Usage:

    from ergon import Agent, BrowserSession, browser_tools

    with BrowserSession(headless=True) as browser:
        agent = Agent("web", tools=browser_tools(browser),
                      system="Use the browser tools to research the question.")
        print(agent.run("Find the price of the item on example.com/product/42").text)
"""
from __future__ import annotations

import re
from typing import Any, List, Optional
from urllib.parse import urlparse

from .tools import Tool, tool


# ── navigation guard (mirror the HTTP-tool SSRF guard) ──
_PRIVATE = re.compile(
    r"^(127\.|10\.|192\.168\.|169\.254\.)|^172\.(1[6-9]|2\d|3[01])\."
)


def _blocked_reason(url: str) -> Optional[str]:
    try:
        p = urlparse(url)
    except Exception:
        return "invalid URL"
    if p.scheme not in ("http", "https"):
        return f"blocked scheme '{p.scheme}' (only http/https allowed)"
    host = (p.hostname or "").lower()
    if (host in ("localhost", "0.0.0.0", "::1") or host.endswith(".local")
            or _PRIVATE.match(host) or host == "[::1]"):
        return f"blocked host '{host}' (internal/loopback addresses are not allowed)"
    return None


class BrowserSession:
    """Manages a Playwright Chromium browser + a single page.

    Lazy: Playwright is imported and the browser launched on first use, so
    importing this module never requires Playwright to be installed. Use as a
    context manager so the browser is always closed, even on error.
    """

    def __init__(self, *, headless: bool = True, allow_hosts: Optional[List[str]] = None,
                 nav_timeout_ms: int = 15000, max_read_chars: int = 12000):
        self.headless = headless
        self.allow_hosts = allow_hosts            # if set, ONLY these hosts are navigable
        self.nav_timeout_ms = nav_timeout_ms
        self.max_read_chars = max_read_chars
        self._pw = None
        self._browser = None
        self._page = None

    # ── lifecycle ──
    def _ensure(self):
        if self._page is not None:
            return self._page
        try:
            from playwright.sync_api import sync_playwright
        except ImportError as e:
            raise RuntimeError(
                "Browser tools need Playwright. Install with:\n"
                "  pip install ergon[browser]\n"
                "  playwright install chromium"
            ) from e
        self._pw = sync_playwright().start()
        self._browser = self._pw.chromium.launch(headless=self.headless)
        self._page = self._browser.new_page()
        self._page.set_default_timeout(self.nav_timeout_ms)
        return self._page

    def close(self):
        try:
            if self._browser:
                self._browser.close()
        finally:
            if self._pw:
                self._pw.stop()
            self._page = self._browser = self._pw = None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    # ── guard ──
    def _check_nav(self, url: str) -> Optional[str]:
        reason = _blocked_reason(url)
        if reason:
            return reason
        if self.allow_hosts is not None:
            host = (urlparse(url).hostname or "").lower()
            if host not in [h.lower() for h in self.allow_hosts]:
                return f"host '{host}' is not in the allow-list {self.allow_hosts}"
        return None

    # ── primitive operations (used by the tools) ──
    def navigate(self, url: str) -> str:
        blocked = self._check_nav(url)
        if blocked:
            return f"[navigation blocked] {blocked}"
        page = self._ensure()
        page.goto(url, wait_until="domcontentloaded")
        return f"Loaded {page.url} — title: {page.title()!r}"

    def read_page(self) -> str:
        page = self._ensure()
        text = page.inner_text("body")
        text = re.sub(r"\n{3,}", "\n\n", text).strip()
        if len(text) > self.max_read_chars:
            text = text[: self.max_read_chars] + "\n[…truncated…]"
        return f"URL: {page.url}\n\n{text}"

    def find(self, query: str) -> str:
        page = self._ensure()
        # return matching links / buttons / inputs with a stable selector hint
        out = []
        for sel in ("a", "button", "input", "[role=button]"):
            for el in page.query_selector_all(sel)[:40]:
                label = (el.inner_text() if sel != "input" else (el.get_attribute("placeholder") or el.get_attribute("name") or "")) or ""
                label = label.strip()[:60]
                if query.lower() in label.lower():
                    hint = el.get_attribute("id") or el.get_attribute("name") or label
                    out.append(f"- <{sel}> {label!r}  (selector hint: {hint!r})")
                if len(out) >= 20:
                    break
        return "\n".join(out) if out else f"No elements matching {query!r}."

    def click(self, selector: str) -> str:
        page = self._ensure()
        page.click(selector)
        return f"Clicked {selector!r}. Now at {page.url}"

    def type_text(self, selector: str, text: str) -> str:
        page = self._ensure()
        page.fill(selector, text)
        return f"Typed into {selector!r}."

    def press_key(self, key: str) -> str:
        page = self._ensure()
        page.keyboard.press(key)
        return f"Pressed {key!r}. Now at {page.url}"

    def submit(self, selector: str = "form") -> str:
        page = self._ensure()
        # prefer submitting the form; fall back to Enter
        el = page.query_selector(selector)
        if el:
            el.evaluate("f => (f.requestSubmit ? f.requestSubmit() : f.submit())")
        else:
            page.keyboard.press("Enter")
        page.wait_for_load_state("domcontentloaded")
        return f"Submitted {selector!r}. Now at {page.url}"


def browser_tools(session: BrowserSession) -> List[Tool]:
    """Build the agent tool list bound to a BrowserSession.

    READ tools are safe (heuristic-approvable). ACT tools are unsafe, so an
    unattended ApprovalPolicy denies them unless explicitly allowed — acting on
    the live web should be a conscious choice.
    """
    @tool("Navigate the browser to a URL and load the page.", safe=True, name="browser_navigate")
    def browser_navigate(url: str) -> str:
        return session.navigate(url)

    @tool("Read the visible text of the current page.", safe=True, name="browser_read")
    def browser_read() -> str:
        return session.read_page()

    @tool("Find clickable elements or inputs on the page matching a text query; returns selector hints.", safe=True, name="browser_find")
    def browser_find(query: str) -> str:
        return session.find(query)

    # ── act tools: NOT safe → go through approval ──
    @tool("Click an element by CSS selector. (acts on the page)", name="browser_click")
    def browser_click(selector: str) -> str:
        return session.click(selector)

    @tool("Type text into an input by CSS selector. (acts on the page)", name="browser_type")
    def browser_type(selector: str, text: str) -> str:
        return session.type_text(selector, text)

    @tool("Press a keyboard key, e.g. 'Enter'. (acts on the page)", name="browser_press")
    def browser_press(key: str) -> str:
        return session.press_key(key)

    @tool("Submit a form by CSS selector (default 'form'). (acts on the page)", name="browser_submit")
    def browser_submit(selector: str = "form") -> str:
        return session.submit(selector)

    return [browser_navigate, browser_read, browser_find,
            browser_click, browser_type, browser_press, browser_submit]
