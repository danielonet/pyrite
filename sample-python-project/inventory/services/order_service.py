"""Business rules for placing and paying orders."""

import logging
from typing import Dict, Optional

from ..models import Order, OrderLine, OrderStatus
from ..repository import InMemoryRepository

logger = logging.getLogger(__name__)

MAX_LINES_PER_ORDER = 20
FREE_SHIPPING_THRESHOLD = 100.0


class OrderService:
    def __init__(self, repo: InMemoryRepository, *, currency: str = "EUR"):
        self.repo = repo
        self.currency = currency
        self._placed = 0

    def place_order(self, customer_id: int, items: Dict[str, int], note: Optional[str] = None) -> Order:
        """Create an order, reserving stock for every line.

        Raises ValueError when the basket is empty, too large, or stock is missing.
        """
        if not items:
            raise ValueError("cannot place an empty order")
        if len(items) > MAX_LINES_PER_ORDER:
            raise ValueError(f"too many lines: {len(items)} > {MAX_LINES_PER_ORDER}")

        customer = self.repo.customer(customer_id)
        order = Order(id=self.repo.next_order_id(), customer=customer, note=note)

        for sku, quantity in items.items():
            product = self.repo.product(sku)
            if not product.in_stock:
                raise ValueError(f"{product.name} is out of stock")
            product.reserve(quantity)
            order.lines.append(OrderLine(product=product, quantity=quantity, unit_price=product.price))

        self._placed += 1
        logger.info("placed %s with %d line(s)", order, len(order.lines))
        return self.repo.save_order(order)

    def pay(self, order_id: int) -> Order:
        order = self._require(order_id)
        if order.status != OrderStatus.NEW:
            raise ValueError(f"order {order_id} cannot be paid in status {order.status.name}")
        order.status = OrderStatus.PAID
        return order

    def cancel(self, order_id: int, reason: str = "") -> Order:
        order = self._require(order_id)
        if order.status in (OrderStatus.SHIPPED, OrderStatus.CANCELLED):
            raise ValueError("order can no longer be cancelled")
        # give the stock back
        for line in order.lines:
            line.product.stock += line.quantity
        order.status = OrderStatus.CANCELLED
        order.note = reason or order.note
        return order

    def shipping_cost(self, order: Order) -> float:
        return 0.0 if order.total >= FREE_SHIPPING_THRESHOLD else 4.99

    def summary(self) -> Dict[str, float]:
        totals = {o.id: o.total for o in self.repo.orders()}
        paid = [t for oid, t in totals.items() if self.repo.order(oid).status == OrderStatus.PAID]
        return {
            "orders": float(len(totals)),
            "revenue": round(sum(paid), 2),
            "average": round(sum(paid) / len(paid), 2) if paid else 0.0,
        }

    def _require(self, order_id: int) -> Order:
        order = self.repo.order(order_id)
        if order is None:
            raise ValueError(f"unknown order {order_id}")
        return order

    @property
    def placed(self) -> int:
        return self._placed
