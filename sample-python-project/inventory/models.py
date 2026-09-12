"""Domain model: products, customers and orders."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Optional


class OrderStatus(Enum):
    """Life cycle of an order."""

    NEW = 1
    PAID = 2
    SHIPPED = 3
    CANCELLED = 4


@dataclass
class Product:
    sku: str
    name: str
    price: float
    stock: int = 0

    @property
    def in_stock(self) -> bool:
        return self.stock > 0

    def reserve(self, quantity: int) -> None:
        """Decrease stock, refusing to go negative."""
        if quantity <= 0:
            raise ValueError(f"quantity must be positive, got {quantity}")
        if quantity > self.stock:
            raise ValueError(f"not enough stock for {self.sku}: wanted {quantity}, have {self.stock}")
        self.stock -= quantity


@dataclass
class Customer:
    id: int
    name: str
    email: str
    vip: bool = False

    def discount_rate(self) -> float:
        return 0.1 if self.vip else 0.0


@dataclass
class OrderLine:
    product: Product
    quantity: int
    unit_price: float

    @property
    def subtotal(self) -> float:
        return round(self.quantity * self.unit_price, 2)


@dataclass
class Order:
    id: int
    customer: Customer
    lines: list[OrderLine] = field(default_factory=list)
    status: OrderStatus = OrderStatus.NEW
    created_at: datetime = field(default_factory=datetime.now)
    note: Optional[str] = None

    @property
    def total(self) -> float:
        gross = sum(line.subtotal for line in self.lines)
        return round(gross * (1 - self.customer.discount_rate()), 2)

    def skus(self) -> set[str]:
        return {line.product.sku for line in self.lines}

    def __str__(self) -> str:
        return f"Order #{self.id} ({self.status.name}) for {self.customer.name}: {self.total:.2f}"


class InventoryError(Exception):
    """Base class for domain errors."""


class UnknownEntityError(InventoryError):
    def __init__(self, kind: str, key):
        super().__init__(f"unknown {kind}: {key!r}")
        self.kind = kind
        self.key = key
