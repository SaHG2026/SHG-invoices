import type { Customer } from '../types';

/**
 * Finding a customer by whatever is half-remembered about them.
 *
 * Deliberately not `rankSuppliers`. That module exists to put the right
 * supplier first from two or three characters, because it sits inside the
 * fifteen-second add-invoice budget and every wrong guess costs a scroll.
 * Nothing here is on a clock, so ranking would be complexity bought for no
 * reason — a plain match, listed alphabetically, is easier to trust.
 *
 * It also differs in one way that matters: deactivated customers still match.
 * `rankSuppliers` drops them because it feeds a picker, where offering a
 * deactivated supplier would be wrong. This feeds an admin list, where the
 * whole point of showing them is that one deactivated by mistake stays
 * findable — hidden and deactivated is deleting, arrived at politely.
 */
export function filterCustomers(
  customers: readonly Customer[],
  query: string,
): Customer[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...customers];

  return customers.filter((customer) => {
    const haystack = [
      customer.name,
      customer.contact_name ?? '',
      customer.contact_phone ?? '',
      customer.contact_email ?? '',
    ]
      .join(' ')
      .toLowerCase();

    return words.every((word) => haystack.includes(word));
  });
}

/**
 * Active first, then deactivated, each alphabetically.
 *
 * Deactivated always last: they are history, not choices.
 */
export function orderCustomers(customers: readonly Customer[]): Customer[] {
  const byName = (a: Customer, b: Customer) => a.name.localeCompare(b.name);
  return [
    ...customers.filter((customer) => customer.active).sort(byName),
    ...customers.filter((customer) => !customer.active).sort(byName),
  ];
}
