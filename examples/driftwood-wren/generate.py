# /// script
# requires-python = ">=3.11"
# dependencies = ["duckdb"]
# ///
"""
Driftwood Outfitters — deterministic messy-dataset generator.

Generates driftwood.duckdb: an outdoor-gear e-commerce dataset spanning a
2019-2023 "legacy platform" and a 2023-2026 "new platform", with a 2023-03
to 2023-08 migration window. The mess (enum drift, cents vs dollars, naive
local timestamps, semi-additive snapshots, refund double-representation,
etc.) is deliberate — see README.md and TRAPS.md
for the full trap catalogue (T1-T15).

Determinism: all randomness comes from a single `random.Random(42)`
instance, consumed in a fixed call order. No faker, no numpy, no
datetime.now() — "today" is the fixed anchor 2026-06-30. Re-running this
script produces byte-different files (row order / vacuum internals) but
identical query results.

Run: uv run generate.py
"""

from __future__ import annotations

import os
import random
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from decimal import ROUND_HALF_UP, ROUND_UP, Decimal
from zoneinfo import ZoneInfo

import duckdb

# --------------------------------------------------------------------------
# Constants & timeline anchors
# --------------------------------------------------------------------------

SEED = 42
HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(HERE, "driftwood.duckdb")

TODAY = date(2026, 6, 30)

LEGACY_START = date(2019, 1, 1)
LEGACY_END = date(2023, 8, 31)
MIGRATION_START = date(2023, 3, 1)
MIGRATION_END = date(2023, 8, 31)
NEW_START = date(2023, 3, 1)
NEW_END = TODAY
SUB_START = date(2024, 1, 1)

CENT = Decimal("0.01")
UTC = ZoneInfo("UTC")
LA_TZ = ZoneInfo("America/Los_Angeles")

# Target row-count knobs. These are the "organic" (non-derived) counts;
# derived tables (migrated order dupes, refund-reversal payments, snapshots,
# etc.) size themselves off the rules and land close to the design doc's
# "~" targets — see README.md "Actual row counts vs. design targets".
N_CUSTOMERS_TOTAL = 8_000
N_LEGACY_CUSTOMERS_TOTAL = 5_000
N_OVERLAP_HUMANS = 3_000
XREF_COVERAGE = 0.85

N_LEGACY_ORDERS = 45_000
N_ORDERS_TOTAL_TARGET = 60_000

N_PRODUCTS = 600
N_SUBSCRIPTIONS = 2_500
N_WEB_EVENTS = 300_000
N_RETURNS = 2_000
WAREHOUSE_PRODUCT_SAMPLE = 200

rng = random.Random(SEED)


# --------------------------------------------------------------------------
# Word lists (hardcoded — no faker)
# --------------------------------------------------------------------------

FIRST_NAMES = [
    "James", "Mary", "Robert", "Patricia", "John", "Jennifer", "Michael", "Linda",
    "David", "Elizabeth", "William", "Barbara", "Richard", "Susan", "Joseph", "Jessica",
    "Thomas", "Sarah", "Charles", "Karen", "Daniel", "Nancy", "Matthew", "Lisa",
    "Anthony", "Betty", "Mark", "Margaret", "Paul", "Sandra", "Emma", "Olivia",
    "Noah", "Ava", "Liam", "Sophia", "Lucas", "Mia", "Ethan", "Isabella",
    "Anna", "Lukas", "Sophie", "Max", "Julia", "Felix", "Marie", "Tom",
    "Chloe", "Hugo", "Camille", "Louis",
]

LAST_NAMES = [
    "Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis",
    "Rodriguez", "Martinez", "Hernandez", "Lopez", "Gonzalez", "Wilson", "Anderson", "Thomas",
    "Taylor", "Moore", "Jackson", "Martin", "Lee", "Perez", "Thompson", "White",
    "Harris", "Sanchez", "Clark", "Ramirez", "Lewis", "Robinson", "Mueller", "Schmidt",
    "Schneider", "Fischer", "Weber", "Meyer", "Wagner", "Becker", "Dubois", "Bernard",
    "Petit", "Durand", "Leroy", "Moreau", "Simon", "Laurent", "Meyer", "Klein",
    "Hoffmann", "Fontaine",
]

EMAIL_DOMAINS = ["gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "icloud.com", "web.de", "gmx.de"]
TEST_DOMAIN = "driftwood.example"

TOP_CATEGORIES = [
    "Camping", "Climbing", "Hiking", "Cycling", "Water Sports",
    "Winter Sports", "Fishing", "Hunting", "Running", "Fitness",
]
SUBCATEGORIES = {
    "Camping": ["Tents", "Sleeping Bags", "Backpacks", "Stoves"],
    "Climbing": ["Ropes", "Harnesses", "Carabiners"],
    "Hiking": ["Boots", "Poles", "Backpacks", "Apparel"],
    "Cycling": ["Bikes", "Helmets", "Apparel", "Accessories"],
    "Water Sports": ["Kayaks", "Paddles", "Life Vests"],
    "Winter Sports": ["Skis", "Snowboards", "Goggles", "Jackets"],
    "Fishing": ["Rods", "Reels", "Tackle"],
    "Hunting": ["Rifle Cases", "Optics", "Apparel"],
    "Running": ["Shoes", "Apparel", "Accessories"],
    "Fitness": ["Weights", "Mats", "Accessories"],
}

MARKETING_CHANNELS = [
    ("fb", 10), ("facebook", 8), ("Facebook Ads", 5),
    ("google", 12), ("adwords", 6), ("Google", 4),
    ("organic", 20), ("email", 10), ("newsletter", 5),
    (None, 20),
]

COUNTRIES = [("US", 70), ("DE", 12), ("FR", 10), ("GB", 8)]

REGIONS = [("west", 45), ("east", 35), ("eu", 20)]

LEGACY_STATUS_CODES = [
    (1, "pending"), (2, "paid"), (3, "shipped"), (4, "delivered"),
    (9, "cancelled"), (7, "refunded"), (5, "partial"),
]
LEGACY_TO_NEW_STATUS = {2: "paid", 3: "shipped", 4: "delivered"}


# --------------------------------------------------------------------------
# Small deterministic helpers
# --------------------------------------------------------------------------

def weighted_choice(rng: random.Random, options: list[tuple], ):
    """options: list of (value, weight)."""
    total = sum(w for _, w in options)
    x = rng.uniform(0, total)
    cum = 0.0
    for value, w in options:
        cum += w
        if x <= cum:
            return value
    return options[-1][0]


def rand_datetime(rng: random.Random, start: date, end: date) -> datetime:
    start_dt = datetime(start.year, start.month, start.day)
    end_dt = datetime(end.year, end.month, end.day, 23, 59, 59)
    span = (end_dt - start_dt).total_seconds()
    offset = rng.uniform(0, span)
    return (start_dt + timedelta(seconds=offset)).replace(microsecond=0)


def rand_amount(rng: random.Random) -> Decimal:
    """Order gross total: mostly $20-$400, occasionally $400-$1500."""
    if rng.random() < 0.85:
        v = rng.uniform(20, 400)
    else:
        v = rng.uniform(400, 1500)
    return Decimal(str(round(v, 2))).quantize(CENT, rounding=ROUND_HALF_UP)


def month_end_dates(start: date, end: date) -> list[date]:
    out = []
    y, m = start.year, start.month
    while True:
        if m == 12:
            nxt = date(y + 1, 1, 1)
        else:
            nxt = date(y, m + 1, 1)
        last_day = nxt - timedelta(days=1)
        if last_day > end:
            break
        if last_day >= start:
            out.append(last_day)
        y, m = nxt.year, nxt.month
    return out


def fiscal_year_quarter(d: date) -> tuple[int, str]:
    m = d.month
    fy = d.year - 1 if m == 1 else d.year
    if m in (2, 3, 4):
        q = 1
    elif m in (5, 6, 7):
        q = 2
    elif m in (8, 9, 10):
        q = 3
    else:
        q = 4  # 11, 12, 1
    return fy, f"FY{fy}-Q{q}"


def daterange(start: date, end: date):
    d = start
    while d <= end:
        yield d
        d += timedelta(days=1)


def email_variant(base_email: str, rng: random.Random) -> str:
    """Return a casing/whitespace variant of an email (identity-dedup trap)."""
    local, domain = base_email.split("@")
    choice = rng.randrange(6)
    if choice == 0:
        return base_email
    if choice == 1:
        return base_email.upper()
    if choice == 2:
        return local.capitalize() + "@" + domain
    if choice == 3:
        return " " + base_email + " "
    if choice == 4:
        return local + "@" + domain.capitalize()
    return local.capitalize() + "@" + domain.upper()


@dataclass
class Person:
    first: str
    last: str
    base_email: str


def make_person(rng: random.Random, used_emails: dict[str, int]) -> Person:
    first = rng.choice(FIRST_NAMES)
    last = rng.choice(LAST_NAMES)
    domain = rng.choice(EMAIL_DOMAINS)
    local = f"{first.lower()}.{last.lower()}"
    key = local + "@" + domain
    n = used_emails.get(key, 0)
    used_emails[key] = n + 1
    if n:
        local = f"{local}{n}"
    base_email = f"{local}@{domain}"
    return Person(first, last, base_email)


# --------------------------------------------------------------------------
# Item reconciliation for order_items <-> order_total (T14)
# --------------------------------------------------------------------------

def build_reconciled_items(
    rng: random.Random,
    order_id: int,
    base_total: Decimal,
    product_ids: list[int],
    next_item_id: list[int],
    force_exact: bool,
) -> tuple[list[tuple], Decimal]:
    """
    Build 1-5 order_item rows whose (qty*unit_price - discount) sum is
    EXACTLY base_total, using the last line's discount as a slack variable.
    Returns (rows, items_sum). If force_exact is False, the caller may
    perturb the *stored* order_total or the last item's discount afterward
    to create a T14 mismatch — this function always reconciles items to
    base_total itself so the "true" grain-level total is well-defined.
    """
    n = weighted_choice(rng, [(1, 25), (2, 30), (3, 25), (4, 12), (5, 8)])
    quantities = [weighted_choice(rng, [(1, 45), (2, 25), (3, 15), (4, 10), (5, 5)]) for _ in range(n)]
    weights = [rng.uniform(0.5, 1.5) for _ in range(n)]
    wsum = sum(weights)

    rows = []
    running = Decimal("0.00")
    for i in range(n):
        pid = rng.choice(product_ids)
        qty = quantities[i]
        item_id = next_item_id[0]
        next_item_id[0] += 1
        if i < n - 1:
            share = (base_total * Decimal(str(weights[i] / wsum))).quantize(CENT, rounding=ROUND_HALF_UP)
            discount = Decimal("0.00") if rng.random() < 0.8 else Decimal(str(round(rng.uniform(1, 15), 2))).quantize(CENT)
            unit_price = ((share + discount) / qty).quantize(CENT, rounding=ROUND_HALF_UP)
            if unit_price <= 0:
                unit_price = Decimal("0.01")
                discount = Decimal("0.00")
            line_total = (unit_price * qty - discount).quantize(CENT)
            running += line_total
            rows.append((item_id, order_id, pid, qty, unit_price, discount))
        else:
            remainder = base_total - running
            unit_price = (remainder / qty).quantize(CENT, rounding=ROUND_HALF_UP)
            if unit_price <= 0:
                unit_price = Decimal("0.01")
            discount = (unit_price * qty - remainder).quantize(CENT)
            tries = 0
            while discount < 0 and tries < 200:
                unit_price += CENT
                discount = (unit_price * qty - remainder).quantize(CENT)
                tries += 1
            line_total = (unit_price * qty - discount).quantize(CENT)
            running += line_total
            rows.append((item_id, order_id, pid, qty, unit_price, discount))

    items_sum = running
    return rows, items_sum


# --------------------------------------------------------------------------
# Generation
# --------------------------------------------------------------------------

def generate() -> dict[str, list[tuple]]:
    data: dict[str, list[tuple]] = {}
    used_emails: dict[str, int] = {}

    # ---- warehouses -------------------------------------------------
    data["warehouses"] = [
        (1, "West Coast DC", "US", "America/Los_Angeles"),
        (2, "East Coast DC", "US", "America/New_York"),
        (3, "Berlin DC", "DE", "Europe/Berlin"),
    ]

    # ---- products -----------------------------------------------------
    products = []
    product_ids = []
    pid = 1
    per_cat = N_PRODUCTS // len(TOP_CATEGORIES)
    for cat in TOP_CATEGORIES:
        subs = SUBCATEGORIES[cat]
        for _ in range(per_cat):
            sub = rng.choice(subs)
            category = f"{cat} > {sub}"
            price = Decimal(str(round(rng.uniform(15, 800), 2))).quantize(CENT, rounding=ROUND_HALF_UP)
            cost = (price * Decimal(str(round(rng.uniform(0.35, 0.7), 3)))).quantize(CENT, rounding=ROUND_HALF_UP)
            introduced = rand_datetime(rng, LEGACY_START, date(2026, 3, 1))
            discontinued = None
            if rng.random() < 0.12:
                discontinued = rand_datetime(rng, introduced.date(), TODAY)
            sku = f"DW-{cat[:3].upper()}-{pid:04d}"
            name = f"{sub[:-1] if sub.endswith('s') else sub} {rng.choice(['Pro','Trail','Alpine','Classic','Explorer','Summit'])} {pid}"
            products.append((pid, sku, name, category, price, cost, introduced, discontinued))
            product_ids.append(pid)
            pid += 1
    data["products"] = products

    # ---- fiscal_calendar ------------------------------------------------
    fiscal_rows = []
    for d in daterange(date(2019, 1, 1), date(2026, 12, 31)):
        fy, fq = fiscal_year_quarter(d)
        fiscal_rows.append((d, fy, fq))
    data["fiscal_calendar"] = fiscal_rows

    # ---- fx_rates (weekdays only, random walk) --------------------------
    fx_rows = []
    eur_rate = 1.10
    gbp_rate = 1.25
    for d in daterange(date(2023, 1, 1), date(2026, 6, 30)):
        if d.weekday() >= 5:  # Sat/Sun
            continue
        eur_rate = min(1.15, max(1.05, eur_rate + rng.uniform(-0.004, 0.004)))
        gbp_rate = min(1.30, max(1.20, gbp_rate + rng.uniform(-0.004, 0.004)))
        fx_rows.append((d, "EUR", Decimal(str(round(eur_rate, 4)))))
        fx_rows.append((d, "GBP", Decimal(str(round(gbp_rate, 4)))))
    data["fx_rates"] = fx_rows

    # ---- legacy_status_codes ---------------------------------------------
    data["legacy_status_codes"] = list(LEGACY_STATUS_CODES)

    # ---- identity graph: overlap humans, customers-only, legacy-only -----
    overlap_people = [make_person(rng, used_emails) for _ in range(N_OVERLAP_HUMANS)]
    customers_only_people = [make_person(rng, used_emails) for _ in range(N_CUSTOMERS_TOTAL - N_OVERLAP_HUMANS)]
    legacy_only_people = [make_person(rng, used_emails) for _ in range(N_LEGACY_CUSTOMERS_TOTAL - N_OVERLAP_HUMANS)]

    customers = []
    customer_ids_all = []
    overlap_customer_id_by_index: dict[int, int] = {}  # index into overlap_people -> customers.id
    cid = 1

    def make_customer_row(person: Person, cid: int) -> tuple:
        is_test = rng.random() < 0.02
        email = email_variant(person.base_email, rng)
        if is_test:
            if rng.random() < 0.5:
                local = email.strip().split("@")[0]
                email = f"{local}+test@{person.base_email.split('@')[1]}"
            else:
                local = person.base_email.split("@")[0]
                email = f"{local}@{TEST_DOMAIN}"
        full_name = f"{person.first} {person.last}"
        country = weighted_choice(rng, COUNTRIES)
        created_at = rand_datetime(rng, NEW_START, NEW_END)
        deleted_at = None
        if rng.random() < 0.04:
            deleted_at = rand_datetime(rng, created_at.date(), NEW_END)
        channel = weighted_choice(rng, MARKETING_CHANNELS)
        return (cid, email, full_name, country, created_at, deleted_at, is_test, channel)

    for idx, person in enumerate(overlap_people):
        customers.append(make_customer_row(person, cid))
        overlap_customer_id_by_index[idx] = cid
        customer_ids_all.append(cid)
        cid += 1
    for person in customers_only_people:
        customers.append(make_customer_row(person, cid))
        customer_ids_all.append(cid)
        cid += 1
    data["customers"] = customers

    legacy_customers = []
    legacy_ref_by_overlap_index: dict[int, str] = {}
    legacy_ref_all = []
    lc_counter = 1

    def make_legacy_row(person: Person, cust_ref: str) -> tuple:
        email = email_variant(person.base_email, rng)
        signup_dt = rand_datetime(rng, LEGACY_START, LEGACY_END).date()
        region = weighted_choice(rng, REGIONS)
        return (cust_ref, email, signup_dt, region)

    for idx, person in enumerate(overlap_people):
        cust_ref = f"C-{lc_counter:05d}"
        legacy_customers.append(make_legacy_row(person, cust_ref))
        legacy_ref_by_overlap_index[idx] = cust_ref
        legacy_ref_all.append(cust_ref)
        lc_counter += 1
    for person in legacy_only_people:
        cust_ref = f"C-{lc_counter:05d}"
        legacy_customers.append(make_legacy_row(person, cust_ref))
        legacy_ref_all.append(cust_ref)
        lc_counter += 1
    data["legacy_customers"] = legacy_customers

    # customer_xref: covers XREF_COVERAGE of the overlap humans only
    n_xref = int(N_OVERLAP_HUMANS * XREF_COVERAGE)
    overlap_indices = list(range(N_OVERLAP_HUMANS))
    xref_indices = sorted(rng.sample(overlap_indices, n_xref))
    xref_rows = [(legacy_ref_by_overlap_index[i], overlap_customer_id_by_index[i]) for i in xref_indices]
    data["customer_xref"] = xref_rows

    # ---- legacy_orders (+ derive migrated duplicates) --------------------
    legacy_order_rows = []
    dup_order_stubs = []  # (legacy_ord_id, customer_id, utc_placed, status, ship_utc_or_none)
    ord_id = 1
    overlap_refs = [legacy_ref_by_overlap_index[i] for i in range(N_OVERLAP_HUMANS)]
    overlap_ref_to_idx = {ref: i for i, ref in enumerate(overlap_refs)}

    for _ in range(N_LEGACY_ORDERS):
        utc_dt = rand_datetime(rng, LEGACY_START, LEGACY_END)
        utc_aware = utc_dt.replace(tzinfo=UTC)
        la_aware = utc_aware.astimezone(LA_TZ)
        ord_dt_str = la_aware.strftime("%Y-%m-%d %H:%M:%S")
        in_migration_window = MIGRATION_START <= la_aware.date() <= MIGRATION_END

        # Migration-window rows are drawn preferentially from the overlap
        # pool so a migrated duplicate always has a resolvable customer_id
        # (modeling: these are the customers who "stuck around" through
        # the cutover).
        if in_migration_window and rng.random() < 0.7:
            cust_ref = rng.choice(overlap_refs)
        else:
            cust_ref = rng.choice(legacy_ref_all)

        stat = weighted_choice(
            rng,
            [(1, 10), (2, 25), (3, 20), (4, 30), (9, 8), (7, 6), (5, 1)],
        )
        amount = rand_amount(rng)
        amt_c = int((amount * 100).to_integral_value(rounding=ROUND_HALF_UP))

        shipped_statuses = {3, 4, 7, 5}
        ship_dt_str = "1970-01-01 00:00:00"
        ship_utc = None
        if stat in shipped_statuses:
            ship_utc = utc_dt + timedelta(hours=rng.uniform(6, 96))
            ship_la = ship_utc.replace(tzinfo=UTC).astimezone(LA_TZ)
            ship_dt_str = ship_la.strftime("%Y-%m-%d %H:%M:%S")

        migrated_at = None
        if in_migration_window and stat in (2, 3, 4) and rng.random() < 0.90:
            migrated_at = utc_dt + timedelta(hours=rng.uniform(1, 48))
            # resolve customer_id: overlap human always has one, whether
            # or not customer_xref happens to cover it (real-world: the
            # join key is the email, xref coverage is just incomplete).
            found_idx = overlap_ref_to_idx.get(cust_ref)
            if found_idx is not None:
                cust_id = overlap_customer_id_by_index[found_idx]
                dup_order_stubs.append(
                    (ord_id, cust_id, utc_dt, LEGACY_TO_NEW_STATUS[stat], ship_utc, amount)
                )
            else:
                migrated_at = None  # no resolvable identity -> not migrated after all

        legacy_order_rows.append(
            (ord_id, cust_ref, ord_dt_str, amt_c, stat, ship_dt_str, migrated_at)
        )
        ord_id += 1

    data["legacy_orders"] = legacy_order_rows

    # ---- orders (organic + migrated dupes), order_items, payments, refunds
    orders = []
    order_items = []
    payments = []
    refunds = []
    next_item_id = [1]
    next_payment_id = [1]
    next_refund_id = [1]

    organic_target = max(0, N_ORDERS_TOTAL_TARGET - len(dup_order_stubs))
    order_id = 1

    STATUS_WEIGHTS = [
        ("pending", 8), ("paid", 32), ("shipped", 20),
        ("delivered", 25), ("cancelled", 8), ("refunded", 7),
    ]
    CURRENCY_WEIGHTS = [("USD", 65), ("EUR", 25), ("GBP", 10)]

    def maybe_case_variant(status: str) -> str:
        if status == "paid" and rng.random() < 0.03:
            return rng.choice(["PAID", "Paid"])
        return status

    def eligible_for_payment(status_lower: str) -> bool:
        return status_lower in ("paid", "shipped", "delivered", "refunded")

    def finalize_order(order_id, customer_id, currency, placed_at, status_display,
                        shipped_at, base_total, legacy_ord_id, refund_pool):
        force_exact = rng.random() < 0.92
        rows, items_sum = build_reconciled_items(
            rng, order_id, base_total, product_ids, next_item_id, force_exact
        )
        if force_exact:
            order_total = base_total
        else:
            delta = Decimal(str(round(rng.uniform(0.01, 0.99), 2)))
            if legacy_ord_id is not None:
                # order_total must stay == amt_c/100 (T2/T3 contract);
                # perturb the last item's discount instead so the items
                # sum diverges from the header total.
                order_total = base_total
                last_idx = len(rows) - 1
                iid, oid, pidv, qty, up, disc = rows[last_idx]
                sign = 1 if rng.random() < 0.5 else -1
                new_disc = (disc + sign * delta)
                if new_disc < 0:
                    new_disc = disc + delta
                    sign = 1
                new_disc = new_disc.quantize(CENT)
                rows[last_idx] = (iid, oid, pidv, qty, up, new_disc)
                items_sum = items_sum - sign * delta
            else:
                sign = 1 if rng.random() < 0.5 else -1
                order_total = base_total + sign * delta
        order_items.extend(rows)

        status_lower = status_display.lower()
        orders.append(
            (order_id, customer_id, currency, order_total, status_display,
             placed_at, shipped_at, legacy_ord_id)
        )

        if eligible_for_payment(status_lower):
            gross = order_total
            fee = (gross * Decimal("0.029") + Decimal("0.30")).quantize(CENT, rounding=ROUND_HALF_UP)
            net = (gross - fee).quantize(CENT)
            captured_at = placed_at + timedelta(hours=rng.uniform(0, 6))
            method = weighted_choice(rng, [("card", 70), ("paypal", 20), ("apple_pay", 10)])
            payments.append(
                (next_payment_id[0], order_id, net, fee, currency, captured_at, method)
            )
            next_payment_id[0] += 1

        if status_lower in ("shipped", "delivered") and rng.random() < 0.14:
            refund_pool.append((order_id, order_total, currency, placed_at, status_display))

    refund_candidates = []

    # migrated duplicates first (fixed order_total from legacy amt_c)
    for legacy_ord_id, cust_id, utc_placed, status, ship_utc, base_total in dup_order_stubs:
        finalize_order(
            order_id, cust_id, "USD", utc_placed, status, ship_utc,
            base_total, legacy_ord_id, refund_candidates,
        )
        order_id += 1

    # organic orders
    for _ in range(organic_target):
        customer_id = rng.choice(customer_ids_all)
        currency = weighted_choice(rng, CURRENCY_WEIGHTS)
        status = maybe_case_variant(weighted_choice(rng, STATUS_WEIGHTS))
        placed_at = rand_datetime(rng, NEW_START, NEW_END)
        shipped_at = None
        if status.lower() not in ("pending", "cancelled"):
            shipped_at = placed_at + timedelta(hours=rng.uniform(6, 96))
        base_total = rand_amount(rng)
        finalize_order(
            order_id, customer_id, currency, placed_at, status, shipped_at,
            base_total, None, refund_candidates,
        )
        order_id += 1

    # ---- refunds (T5: every refund also produces a negative payment row) -
    for oid, order_total, currency, placed_at, status_display in refund_candidates:
        full_refund = rng.random() < 0.6
        if full_refund:
            amount = order_total
        else:
            frac = Decimal(str(round(rng.uniform(0.1, 0.6), 2)))
            amount = (order_total * frac).quantize(CENT, rounding=ROUND_HALF_UP)
        refunded_at = placed_at + timedelta(hours=rng.uniform(72, 720))
        reason = weighted_choice(
            rng,
            [("defective", 30), ("wrong_item", 20), ("changed_mind", 30),
             ("late_delivery", 10), ("other", 10)],
        )
        refunds.append((next_refund_id[0], oid, amount, reason, refunded_at))
        next_refund_id[0] += 1

        # negative refund-reversal payment row (double representation)
        method = "refund_reversal"
        payments.append(
            (next_payment_id[0], oid, -amount, Decimal("0.00"), currency, refunded_at, method)
        )
        next_payment_id[0] += 1

        if full_refund:
            # flip the order's status to 'refunded' in place
            for i in range(len(orders)):
                if orders[i][0] == oid:
                    o = orders[i]
                    orders[i] = (o[0], o[1], o[2], o[3], "refunded", o[5], o[6], o[7])
                    break

    data["orders"] = orders
    data["order_items"] = order_items
    data["payments"] = payments
    data["refunds"] = refunds

    # ---- subscriptions + subscription_snapshots --------------------------
    subs = []
    sub_id = 1
    plan_prices = {"plus_monthly": Decimal("19.00"), "plus_annual": Decimal("15.83")}
    for _ in range(N_SUBSCRIPTIONS):
        customer_id = rng.choice(customer_ids_all)
        plan = weighted_choice(rng, [("plus_monthly", 60), ("plus_annual", 40)])
        started_at = rand_datetime(rng, SUB_START, TODAY)
        canceled_at = None
        if rng.random() < 0.35:
            canceled_at = rand_datetime(rng, started_at.date(), TODAY)
        subs.append((sub_id, customer_id, plan, started_at, canceled_at, plan_prices[plan]))
        sub_id += 1
    data["subscriptions"] = subs

    snapshot_rows = []
    for snap_date in month_end_dates(date(2024, 1, 1), date(2026, 6, 30)):
        for (s_id, _cust, _plan, started_at, canceled_at, monthly_price) in subs:
            if started_at.date() <= snap_date and (canceled_at is None or canceled_at.date() > snap_date):
                snapshot_rows.append((snap_date, s_id, monthly_price, "active"))
    data["subscription_snapshots"] = snapshot_rows

    # ---- web_events --------------------------------------------------
    web_events = []
    event_types = [("page_view", 60), ("add_to_cart", 20), ("checkout", 10), ("search", 10)]
    for i in range(1, N_WEB_EVENTS + 1):
        et = rand_datetime(rng, NEW_START, NEW_END)
        epoch_ms = int(et.replace(tzinfo=UTC).timestamp() * 1000)
        customer_id = None if rng.random() < 0.35 else rng.choice(customer_ids_all)
        event_type = weighted_choice(rng, event_types)
        session_id = f"sess-{rng.randrange(10**9):09d}"
        web_events.append((i, epoch_ms, customer_id, event_type, session_id))
    data["web_events"] = web_events

    # ---- inventory_levels ----------------------------------------------
    inventory_rows = []
    warehouse_ids = [1, 2, 3]
    warehouse_products = {
        wid: sorted(rng.sample(product_ids, min(WAREHOUSE_PRODUCT_SAMPLE, len(product_ids))))
        for wid in warehouse_ids
    }
    for snap_date in month_end_dates(date(2023, 3, 1), date(2026, 6, 30)):
        for wid in warehouse_ids:
            for p_id in warehouse_products[wid]:
                units = rng.randint(0, 500)
                inventory_rows.append((snap_date, wid, p_id, units))
    data["inventory_levels"] = inventory_rows

    # ---- returns (T15: RMA vs refunds, partial overlap by construction) --
    returns_rows = []
    n_items = len(order_items)
    sample_size = min(N_RETURNS, n_items)
    chosen_positions = sorted(rng.sample(range(n_items), sample_size))
    disposition_weights = [("restock", 50), ("damaged", 30), ("disposed", 20)]
    order_placed_at = {o[0]: o[5] for o in orders}
    rma = 1
    for pos in chosen_positions:
        item_id, o_id, _pid, qty, _up, _disc = order_items[pos]
        qty_returned = rng.randint(1, qty)
        base_placed = order_placed_at.get(o_id, rand_datetime(rng, NEW_START, NEW_END))
        received_at = base_placed + timedelta(hours=rng.uniform(48, 30 * 24))
        disposition = weighted_choice(rng, disposition_weights)
        returns_rows.append((rma, item_id, qty_returned, received_at, disposition))
        rma += 1
    data["returns"] = returns_rows

    return data


# --------------------------------------------------------------------------
# DDL + load
# --------------------------------------------------------------------------

DDL = """
CREATE TABLE warehouses (
    id INTEGER PRIMARY KEY,
    name VARCHAR,
    country VARCHAR,
    tz VARCHAR
);

CREATE TABLE products (
    id INTEGER PRIMARY KEY,
    sku VARCHAR,
    name VARCHAR,
    category VARCHAR,
    current_price DECIMAL(12,2),
    cost DECIMAL(12,2),
    introduced_at TIMESTAMP,
    discontinued_at TIMESTAMP
);

CREATE TABLE fiscal_calendar (
    date DATE PRIMARY KEY,
    fiscal_year INTEGER,
    fiscal_quarter VARCHAR
);

CREATE TABLE fx_rates (
    date DATE,
    currency VARCHAR,
    usd_rate DECIMAL(12,6)
);

CREATE TABLE legacy_status_codes (
    code INTEGER PRIMARY KEY,
    label VARCHAR
);

CREATE TABLE customers (
    id INTEGER PRIMARY KEY,
    email VARCHAR,
    full_name VARCHAR,
    country VARCHAR,
    created_at TIMESTAMP,
    deleted_at TIMESTAMP,
    is_test BOOLEAN,
    marketing_channel VARCHAR
);

CREATE TABLE legacy_customers (
    cust_ref VARCHAR PRIMARY KEY,
    email VARCHAR,
    signup_dt DATE,
    region VARCHAR
);

CREATE TABLE customer_xref (
    cust_ref VARCHAR,
    customer_id INTEGER
);

CREATE TABLE legacy_orders (
    ord_id INTEGER PRIMARY KEY,
    cust_ref VARCHAR,
    ord_dt VARCHAR,
    amt_c INTEGER,
    stat INTEGER,
    ship_dt VARCHAR,
    migrated_at TIMESTAMP
);

CREATE TABLE orders (
    id INTEGER PRIMARY KEY,
    customer_id INTEGER,
    currency VARCHAR,
    order_total DECIMAL(12,2),
    status VARCHAR,
    placed_at TIMESTAMP,
    shipped_at TIMESTAMP,
    legacy_ord_id INTEGER
);

CREATE TABLE order_items (
    id INTEGER PRIMARY KEY,
    order_id INTEGER,
    product_id INTEGER,
    quantity INTEGER,
    unit_price DECIMAL(12,2),
    discount_amount DECIMAL(12,2)
);

CREATE TABLE payments (
    id INTEGER PRIMARY KEY,
    order_id INTEGER,
    amount DECIMAL(12,2),
    fee_amount DECIMAL(12,2),
    currency VARCHAR,
    captured_at TIMESTAMP,
    method VARCHAR
);

CREATE TABLE refunds (
    id INTEGER PRIMARY KEY,
    order_id INTEGER,
    amount DECIMAL(12,2),
    reason VARCHAR,
    refunded_at TIMESTAMP
);

CREATE TABLE subscriptions (
    id INTEGER PRIMARY KEY,
    customer_id INTEGER,
    plan VARCHAR,
    started_at TIMESTAMP,
    canceled_at TIMESTAMP,
    monthly_price DECIMAL(12,2)
);

CREATE TABLE subscription_snapshots (
    snapshot_date DATE,
    subscription_id INTEGER,
    mrr_amount DECIMAL(12,2),
    status VARCHAR
);

CREATE TABLE web_events (
    id BIGINT PRIMARY KEY,
    event_time BIGINT,
    customer_id INTEGER,
    event_type VARCHAR,
    session_id VARCHAR
);

CREATE TABLE inventory_levels (
    snapshot_date DATE,
    warehouse_id INTEGER,
    product_id INTEGER,
    units_on_hand INTEGER
);

CREATE TABLE returns (
    rma_id INTEGER PRIMARY KEY,
    order_item_id INTEGER,
    qty_returned INTEGER,
    received_at TIMESTAMP,
    disposition VARCHAR
);
"""

INSERT_SQL = {
    "warehouses": "INSERT INTO warehouses VALUES (?,?,?,?)",
    "products": "INSERT INTO products VALUES (?,?,?,?,?,?,?,?)",
    "fiscal_calendar": "INSERT INTO fiscal_calendar VALUES (?,?,?)",
    "fx_rates": "INSERT INTO fx_rates VALUES (?,?,?)",
    "legacy_status_codes": "INSERT INTO legacy_status_codes VALUES (?,?)",
    "customers": "INSERT INTO customers VALUES (?,?,?,?,?,?,?,?)",
    "legacy_customers": "INSERT INTO legacy_customers VALUES (?,?,?,?)",
    "customer_xref": "INSERT INTO customer_xref VALUES (?,?)",
    "legacy_orders": "INSERT INTO legacy_orders VALUES (?,?,?,?,?,?,?)",
    "orders": "INSERT INTO orders VALUES (?,?,?,?,?,?,?,?)",
    "order_items": "INSERT INTO order_items VALUES (?,?,?,?,?,?)",
    "payments": "INSERT INTO payments VALUES (?,?,?,?,?,?,?)",
    "refunds": "INSERT INTO refunds VALUES (?,?,?,?,?)",
    "subscriptions": "INSERT INTO subscriptions VALUES (?,?,?,?,?,?)",
    "subscription_snapshots": "INSERT INTO subscription_snapshots VALUES (?,?,?,?)",
    "web_events": "INSERT INTO web_events VALUES (?,?,?,?,?)",
    "inventory_levels": "INSERT INTO inventory_levels VALUES (?,?,?,?)",
    "returns": "INSERT INTO returns VALUES (?,?,?,?,?)",
}

# Load order respects FK dependency (informational only — DuckDB here does
# not enforce FK constraints across these tables).
TABLE_ORDER = [
    "warehouses", "products", "fiscal_calendar", "fx_rates", "legacy_status_codes",
    "customers", "legacy_customers", "customer_xref", "legacy_orders",
    "orders", "order_items", "payments", "refunds",
    "subscriptions", "subscription_snapshots", "web_events", "inventory_levels", "returns",
]


def load(data: dict[str, list[tuple]]) -> None:
    if os.path.exists(DB_PATH):
        os.remove(DB_PATH)
    con = duckdb.connect(DB_PATH)
    con.execute(DDL)
    for table in TABLE_ORDER:
        rows = data[table]
        if rows:
            con.executemany(INSERT_SQL[table], rows)
    con.close()


def print_summary() -> None:
    con = duckdb.connect(DB_PATH, read_only=True)
    print(f"\n{'table':<28} {'rows':>10}")
    print("-" * 40)
    total = 0
    for table in TABLE_ORDER:
        n = con.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        total += n
        print(f"{table:<28} {n:>10,}")
    print("-" * 40)
    print(f"{'TOTAL':<28} {total:>10,}")
    con.close()
    size_mb = os.path.getsize(DB_PATH) / (1024 * 1024)
    print(f"\n{DB_PATH} — {size_mb:.1f} MB")


def main() -> None:
    data = generate()
    load(data)
    print_summary()


if __name__ == "__main__":
    main()
