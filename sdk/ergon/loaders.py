"""Document loaders — turn files and URLs into plain text for a KnowledgeBase.

Stdlib-only for the common formats (text, markdown, csv/tsv); optional deps are
lazy-imported so importing this module never requires them:

    load_text(path)       .txt and friends
    load_markdown(path)    .md / .markdown (kept as-is; it's already text)
    load_csv(path)         .csv / .tsv  → one readable line per row
    load_pdf(path)         .pdf          (lazy: pypdf)
    load_url(url)          a web page    (lazy: urllib; HTML tags stripped)
    load_file(path)        dispatch by extension
    iter_files(directory)  walk a folder for supported files

These pair with KnowledgeBase.add_file / add_url / add_path, which attach a
`source` to the chunk metadata so retrieved passages can be cited.
"""
from __future__ import annotations

import csv
import html
import os
import re
from typing import Callable, Iterator, List, Optional

TEXT_EXTS = {".txt", ".text", ".log", ".rst"}
MD_EXTS = {".md", ".markdown", ".mdown"}
CSV_EXTS = {".csv", ".tsv"}
PDF_EXTS = {".pdf"}
SUPPORTED_EXTS = TEXT_EXTS | MD_EXTS | CSV_EXTS | PDF_EXTS


def load_text(path: str) -> str:
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        return f.read()


def load_markdown(path: str) -> str:
    # Markdown is already readable text; keep it verbatim so headings/structure
    # survive into the chunks. (Strip front-matter if present.)
    text = load_text(path)
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            text = text[end + 4:]
    return text.lstrip("\n")


def load_csv(path: str) -> str:
    """Render a CSV/TSV as one line per row: 'col: val; col: val'.

    Keeps the header meaning attached to each value so retrieval has context,
    rather than embedding anonymous comma-separated cells.
    """
    delimiter = "\t" if path.lower().endswith(".tsv") else ","
    lines: List[str] = []
    with open(path, "r", encoding="utf-8", errors="replace", newline="") as f:
        reader = csv.reader(f, delimiter=delimiter)
        rows = list(reader)
    if not rows:
        return ""
    header = rows[0]
    looks_like_header = all(not _is_number(c) for c in header) and len(header) > 1
    if looks_like_header:
        for row in rows[1:]:
            pairs = [f"{header[i]}: {val}" for i, val in enumerate(row) if i < len(header)]
            if pairs:
                lines.append("; ".join(pairs))
    else:
        for row in rows:
            lines.append("; ".join(row))
    return "\n".join(lines)


def _is_number(s: str) -> bool:
    try:
        float(s)
        return True
    except (TypeError, ValueError):
        return False


def load_pdf(path: str) -> str:
    """Extract text from a PDF. Lazy-imports pypdf (pip install pypdf)."""
    try:
        from pypdf import PdfReader
    except ImportError as e:  # pragma: no cover - optional dep
        raise ImportError("load_pdf needs pypdf: pip install pypdf") from e
    reader = PdfReader(path)
    parts = [(page.extract_text() or "") for page in reader.pages]
    return "\n\n".join(p for p in parts if p.strip())


_TAG_RE = re.compile(r"<[^>]+>")
_SCRIPT_STYLE_RE = re.compile(r"<(script|style)[^>]*>.*?</\1>", re.DOTALL | re.IGNORECASE)
_WS_RE = re.compile(r"[ \t]+")
_BLANKLINES_RE = re.compile(r"\n{3,}")


def strip_html(markup: str) -> str:
    """Crude but dependency-free HTML → text: drop script/style, tags, entities."""
    text = _SCRIPT_STYLE_RE.sub(" ", markup)
    # turn block-ish tags into newlines so structure doesn't collapse to one line
    text = re.sub(r"(?i)<\s*(br|/p|/div|/li|/h[1-6]|/tr)\s*/?>", "\n", text)
    text = _TAG_RE.sub("", text)
    text = html.unescape(text)
    text = _WS_RE.sub(" ", text)
    text = _BLANKLINES_RE.sub("\n\n", text)
    return text.strip()


def load_url(url: str, *, http_get: Optional[Callable[[str], str]] = None,
             timeout: float = 30.0) -> str:
    """Fetch a URL and return readable text (HTML stripped).

    `http_get(url) -> markup` is injectable for offline testing; the default
    uses urllib. JSON and plain-text responses are returned as-is.
    """
    if http_get is not None:
        markup = http_get(url)
    else:  # pragma: no cover - network path
        import urllib.request
        req = urllib.request.Request(url, headers={"User-Agent": "ergon-loader/1.0"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            ctype = resp.headers.get("Content-Type", "")
            body = resp.read().decode("utf-8", errors="replace")
        if "html" not in ctype.lower() and "<" not in body[:100]:
            return body.strip()
        markup = body
    return strip_html(markup)


def load_file(path: str) -> str:
    """Load a file to text, dispatching on its extension."""
    ext = os.path.splitext(path)[1].lower()
    if ext in PDF_EXTS:
        return load_pdf(path)
    if ext in CSV_EXTS:
        return load_csv(path)
    if ext in MD_EXTS:
        return load_markdown(path)
    # default: treat as text (covers TEXT_EXTS and unknown-but-textual files)
    return load_text(path)


def iter_files(directory: str, *, recursive: bool = True,
               exts: Optional[set] = None) -> Iterator[str]:
    """Yield supported files under a directory."""
    allowed = exts or SUPPORTED_EXTS
    if recursive:
        for root, _dirs, names in os.walk(directory):
            for name in sorted(names):
                if os.path.splitext(name)[1].lower() in allowed:
                    yield os.path.join(root, name)
    else:
        for name in sorted(os.listdir(directory)):
            full = os.path.join(directory, name)
            if os.path.isfile(full) and os.path.splitext(name)[1].lower() in allowed:
                yield full
