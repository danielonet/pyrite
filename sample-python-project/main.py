"""Entry point: seeds a repository, runs a batch job and prints a report."""

import logging
import sys

from inventory.batch.job import OrderExportJob
from inventory.models import Customer, OrderStatus, Product
from inventory.repository import InMemoryRepository
from inventory.services.order_service import OrderService
from inventory.utils.formatting import money, table

logger = logging.getLogger(__name__)
DEFAULT_CURRENCY = "EUR"


def seed(repo: InMemoryRepository) -> None:
    """Populate the repository with a few products and customers."""
    repo.add_product(Product(sku="P-100", name="Keyboard", price=49.90, stock=10))
    repo.add_product(Product(sku="P-200", name="Mouse", price=19.50, stock=0))
    repo.add_product(Product(sku="P-300", name="Monitor", price=249.00, stock=3))
    repo.add_customer(Customer(id=1, name="Ada", email="ada@example.com"))
    repo.add_customer(Customer(id=2, name="Linus", email="linus@example.com", vip=True))


def run(argv: list[str]) -> int:
    logging.basicConfig(level=logging.INFO)
    repo = InMemoryRepository()
    seed(repo)
    service = OrderService(repo, currency=DEFAULT_CURRENCY)

    order = service.place_order(customer_id=2, items={"P-100": 2, "P-300": 1})
    service.pay(order.id)
    try:
        service.place_order(customer_id=1, items={"P-200": 1})
    except ValueError as exc:
        logger.warning("expected failure: %s", exc)

    job = OrderExportJob(repo, chunk_size=2)
    result = job.run()

    rows = [(o.id, o.status.name, money(o.total, DEFAULT_CURRENCY)) for o in repo.orders()]
    print(table(["id", "status", "total"], rows))
    print(f"Exported {result.written} of {result.read} orders, skipped {result.skipped}")
    return 0 if result.failed == 0 else 1


if __name__ == "__main__":
    sys.exit(run(sys.argv[1:]))
