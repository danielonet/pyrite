"""A minimal chunk-oriented batch job, in the spirit of Spring Batch.

Reader -> Processor -> Writer, processed in chunks with per-item skip handling.
"""

import csv
import io
import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Generic, Iterator, List, Optional, TypeVar

from ..models import Order, OrderStatus
from ..repository import InMemoryRepository
from ..utils.formatting import chunked

I = TypeVar("I")
O = TypeVar("O")

logger = logging.getLogger(__name__)


class ItemReader(ABC, Generic[I]):
    @abstractmethod
    def read(self) -> Iterator[I]:
        """Yield items one at a time."""


class ItemProcessor(ABC, Generic[I, O]):
    @abstractmethod
    def process(self, item: I) -> Optional[O]:
        """Transform an item. Return None to filter it out."""


class ItemWriter(ABC, Generic[O]):
    @abstractmethod
    def write(self, items: List[O]) -> None:
        ...


@dataclass
class JobResult:
    read: int = 0
    written: int = 0
    skipped: int = 0
    failed: int = 0

    @property
    def ok(self) -> bool:
        return self.failed == 0


class OrderReader(ItemReader[Order]):
    def __init__(self, repo: InMemoryRepository, status: Optional[OrderStatus] = None):
        self._repo = repo
        self._status = status

    def read(self) -> Iterator[Order]:
        yield from self._repo.orders(self._status)


class OrderToCsvProcessor(ItemProcessor[Order, List[str]]):
    """Flattens an order into a CSV row; cancelled orders are filtered out."""

    def process(self, item: Order) -> Optional[List[str]]:
        if item.status == OrderStatus.CANCELLED:
            return None
        skus = ";".join(sorted(item.skus()))
        return [str(item.id), item.customer.email, item.status.name, f"{item.total:.2f}", skus]


class CsvWriter(ItemWriter[List[str]]):
    HEADER = ["id", "customer", "status", "total", "skus"]

    def __init__(self, buffer: Optional[io.StringIO] = None):
        self.buffer = buffer or io.StringIO()
        self._writer = csv.writer(self.buffer)
        self._writer.writerow(self.HEADER)

    def write(self, items: List[List[str]]) -> None:
        for row in items:
            self._writer.writerow(row)

    def getvalue(self) -> str:
        return self.buffer.getvalue()


class ChunkedJob(Generic[I, O]):
    """Runs reader -> processor -> writer in chunks, skipping items that fail."""

    def __init__(self, reader: ItemReader[I], processor: ItemProcessor[I, O], writer: ItemWriter[O], chunk_size: int = 10, skip_limit: int = 3):
        self.reader = reader
        self.processor = processor
        self.writer = writer
        self.chunk_size = chunk_size
        self.skip_limit = skip_limit

    def run(self) -> JobResult:
        result = JobResult()
        items = list(self.reader.read())
        result.read = len(items)
        for chunk in chunked(items, self.chunk_size):
            outputs: List[O] = []
            for item in chunk:
                try:
                    processed = self.processor.process(item)
                except Exception as exc:  # noqa: BLE001 - skip policy
                    result.skipped += 1
                    logger.warning("skipping %r: %s", item, exc)
                    if result.skipped > self.skip_limit:
                        result.failed += 1
                        raise
                    continue
                if processed is not None:
                    outputs.append(processed)
            if outputs:
                self.writer.write(outputs)
                result.written += len(outputs)
        logger.info("job finished: %s", result)
        return result


class OrderExportJob(ChunkedJob[Order, List[str]]):
    def __init__(self, repo: InMemoryRepository, chunk_size: int = 10):
        self.csv = CsvWriter()
        super().__init__(OrderReader(repo), OrderToCsvProcessor(), self.csv, chunk_size=chunk_size)

    def run(self) -> JobResult:
        result = super().run()
        logger.debug("csv output:\n%s", self.csv.getvalue())
        return result
