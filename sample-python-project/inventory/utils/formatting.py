"""Small text formatting helpers."""

from typing import Any, Callable, Iterable, Sequence

SYMBOLS = {"EUR": "€", "USD": "$", "GBP": "£"}


def money(amount: float, currency: str = "EUR") -> str:
    symbol = SYMBOLS.get(currency, currency + " ")
    sign = "-" if amount < 0 else ""
    return f"{sign}{symbol}{abs(amount):,.2f}"


def pad(text: Any, width: int, align: str = "left") -> str:
    s = str(text)
    if len(s) >= width:
        return s[:width]
    return s.ljust(width) if align == "left" else s.rjust(width)


def table(headers: Sequence[str], rows: Iterable[Sequence[Any]]) -> str:
    """Render rows as a fixed-width text table."""
    rows = [list(map(str, r)) for r in rows]
    widths = [len(h) for h in headers]
    for row in rows:
        for i, cell in enumerate(row):
            widths[i] = max(widths[i], len(cell))
    line = "+" + "+".join("-" * (w + 2) for w in widths) + "+"
    render: Callable[[Sequence[str]], str] = lambda cells: "| " + " | ".join(pad(c, w) for c, w in zip(cells, widths)) + " |"
    out = [line, render(headers), line]
    out.extend(render(r) for r in rows)
    out.append(line)
    return "\n".join(out)


def chunked(items: Sequence[Any], size: int):
    """Yield successive chunks of at most `size` items."""
    if size <= 0:
        raise ValueError("size must be positive")
    for start in range(0, len(items), size):
        yield items[start:start + size]


def slugify(text: str) -> str:
    cleaned = "".join(ch.lower() if ch.isalnum() else "-" for ch in text.strip())
    while "--" in cleaned:
        cleaned = cleaned.replace("--", "-")
    return cleaned.strip("-")
