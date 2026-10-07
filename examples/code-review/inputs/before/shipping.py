def shipping_cost(subtotal: int) -> int:
    if subtotal < 50:
        return 5
    return 0
