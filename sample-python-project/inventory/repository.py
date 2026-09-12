"""A tiny in-memory repository. Real code would talk to a database."""

import itertools
import threading
from typing import Dict, Iterable, Iterator, List, Optional

from .models import Customer, Order, OrderStatus, Product, UnknownEntityError


class InMemoryRepository:
    """Stores products, customers and orders in dictionaries."""

    def __init__(self):
        self._products: Dict[str, Product] = {}
        self._customers: Dict[int, Customer] = {}
        self._orders: Dict[int, Order] = {}
        self._ids = itertools.count(1)
        self._lock = threading.Lock()

    # ---- products -------------------------------------------------------

    def add_product(self, product: Product) -> None:
        self._products[product.sku] = product

    def product(self, sku: str) -> Product:
        try:
            return self._products[sku]
        except KeyError:
            raise UnknownEntityError("product", sku)

    def products_in_stock(self) -> List[Product]:
        return [p for p in self._products.values() if p.in_stock]

    # ---- customers ------------------------------------------------------

    def add_customer(self, customer: Customer) -> None:
        self._customers[customer.id] = customer

    def customer(self, customer_id: int) -> Customer:
        customer = self._customers.get(customer_id)
        if customer is None:
            raise UnknownEntityError("customer", customer_id)
        return customer

    # ---- orders ---------------------------------------------------------

    def next_order_id(self) -> int:
        with self._lock:
            return next(self._ids)

    def save_order(self, order: Order) -> Order:
        self._orders[order.id] = order
        return order

    def order(self, order_id: int) -> Optional[Order]:
        return self._orders.get(order_id)

    def orders(self, status: Optional[OrderStatus] = None) -> Iterable[Order]:
        for order in self._orders.values():
            if status is None or order.status == status:
                yield order

    def orders_by_customer(self) -> Dict[int, List[Order]]:
        grouped: Dict[int, List[Order]] = {}
        for order in self._orders.values():
            grouped.setdefault(order.customer.id, []).append(order)
        return grouped

    def __len__(self) -> int:
        return len(self._orders)

    def __iter__(self) -> Iterator[Order]:
        return iter(self._orders.values())
