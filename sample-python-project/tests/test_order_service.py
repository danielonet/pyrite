import pytest

from inventory.models import Customer, OrderStatus, Product
from inventory.repository import InMemoryRepository
from inventory.services.order_service import OrderService


@pytest.fixture
def service() -> OrderService:
    repo = InMemoryRepository()
    repo.add_product(Product(sku="A", name="Thing", price=10.0, stock=5))
    repo.add_customer(Customer(id=1, name="Ada", email="ada@example.com"))
    return OrderService(repo)


def test_place_order_reserves_stock(service):
    order = service.place_order(1, {"A": 2})
    assert order.total == 20.0
    assert service.repo.product("A").stock == 3


def test_empty_order_is_rejected(service):
    with pytest.raises(ValueError):
        service.place_order(1, {})


def test_pay_changes_status(service):
    order = service.place_order(1, {"A": 1})
    service.pay(order.id)
    assert order.status is OrderStatus.PAID
