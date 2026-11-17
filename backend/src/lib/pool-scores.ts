/**
 * Official pool scoring from finishing positions, including 平頭馬 dead-heats.
 *
 * HKJC prints one finishing position on every horse in a dead-heat and skips
 * the next numbers (2026-11-14 ST race 7: 1st #9, 2nd #8, dead-heat 3rd #6 and
 * #13 labelled 「3 平頭馬」, next horse is 5th). Those two 3rds fill slots 3 and 4.
 *
 * Place / 位置Q: every horse whose official finishingPosition is 1, 2, or 3 is
 * placed. Race 7 therefore pays 位置Q 8,13 as well as 6,8 / 6,9 / 9,13 / 6,13 / 8,9.
 * 連贏 stays the first two slots only (8,9), not the dead-heat 3rds.
 * 單T / 三重彩: each dead-heat 3rd makes its own combination with 1st and 2nd
 * (6,8,9 and 8,9,13; orders 9-8-6 and 9-8-13).
 * 四連環 is the one set {6,8,9,13}. 四重彩 pays both orders 9-8-6-13 and 9-8-13-6.
 *
 * A void race is not scored and is not a denominator.
 */

export type Finisher = { id: string; position: number };

export type PoolScore = {
  void: boolean;
  evaluated: boolean;
  first4Eligible: boolean;
  top1Hit: boolean;
  placedIds: string[];
  top3Intersect: number;
  top3AnyHit: boolean;
  top4Ids: string[];
  top4Intersect: number;
  quinellaHit: boolean;
  qpHit: boolean;
  trioHit: boolean;
  tierceHit: boolean;
  first4Hit: boolean;
  quartetHit: boolean;
  quinellaSets: string[][];
  tierceOrders: string[][];
  trioSets: string[][];
  quartetOrders: string[][];
  first4Sets: string[][];
};

function blank(voidRace: boolean): PoolScore {
  return {
    void: voidRace,
    evaluated: false,
    first4Eligible: false,
    top1Hit: false,
    placedIds: [],
    top3Intersect: 0,
    top3AnyHit: false,
    top4Ids: [],
    top4Intersect: 0,
    quinellaHit: false,
    qpHit: false,
    trioHit: false,
    tierceHit: false,
    first4Hit: false,
    quartetHit: false,
    quinellaSets: [],
    tierceOrders: [],
    trioSets: [],
    quartetOrders: [],
    first4Sets: [],
  };
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i++) {
    const rest = items.slice(0, i).concat(items.slice(i + 1));
    for (const tail of permutations(rest)) out.push([items[i], ...tail]);
  }
  return out;
}

function groupsInPositionOrder(finishers: Finisher[]): Finisher[][] {
  const byPos = new Map<number, Finisher[]>();
  for (const horse of finishers) {
    const position = Number(horse.position);
    if (!Number.isInteger(position) || position < 1 || position >= 99 || !horse.id) continue;
    const group = byPos.get(position);
    if (group) group.push(horse);
    else byPos.set(position, [horse]);
  }
  return [...byPos.keys()].sort((a, b) => a - b).map((position) => byPos.get(position)!);
}

/** Blocks of tied horses that together fill slots 1..slotsNeeded. Null when a gap remains. */
function blocksCovering(finishers: Finisher[], slotsNeeded: number): Finisher[][] | null {
  if (slotsNeeded < 1) return null;
  let nextSlot = 1;
  const blocks: Finisher[][] = [];
  for (const group of groupsInPositionOrder(finishers)) {
    if (nextSlot > slotsNeeded) break;
    if (group[0].position !== nextSlot) return null;
    blocks.push(group);
    nextSlot += group.length;
  }
  if (nextSlot <= slotsNeeded) return null;
  return blocks;
}

function ordersOfFirstSlots(finishers: Finisher[], slotsNeeded: number): string[][] {
  const blocks = blocksCovering(finishers, slotsNeeded);
  if (!blocks) return [];
  let sequences: Finisher[][] = [[]];
  for (const block of blocks) {
    const next: Finisher[][] = [];
    for (const prefix of sequences) {
      for (const perm of permutations(block)) next.push(prefix.concat(perm));
    }
    sequences = next;
  }
  const seen = new Set<string>();
  const orders: string[][] = [];
  for (const sequence of sequences) {
    const ids = sequence.slice(0, slotsNeeded).map((horse) => horse.id);
    const key = ids.join('\0');
    if (seen.has(key)) continue;
    seen.add(key);
    orders.push(ids);
  }
  return orders;
}

function uniqueSets(orders: string[][]): string[][] {
  const seen = new Set<string>();
  const sets: string[][] = [];
  for (const order of orders) {
    const sorted = order.slice().sort();
    const key = sorted.join('\0');
    if (seen.has(key)) continue;
    seen.add(key);
    sets.push(sorted);
  }
  return sets;
}

function sameSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const want = new Set(right);
  return left.every((id) => id && want.has(id)) && want.size === left.length;
}

function sameOrder(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id, index) => id && id === right[index]);
}

export function scoreOfficialPools(
  predictedIdsInRankOrder: string[],
  finishers: Finisher[],
  opts?: { void?: boolean },
): PoolScore {
  if (opts?.void) return blank(true);
  const predicted = predictedIdsInRankOrder.map((id) => String(id ?? '')).filter(Boolean);
  const top1 = predicted[0] ?? '';
  const top2 = predicted.slice(0, 2);
  const top3 = predicted.slice(0, 3);
  const top4 = predicted.slice(0, 4);
  const placedIds = groupsInPositionOrder(finishers)
    .filter((group) => group[0].position >= 1 && group[0].position <= 3)
    .flat()
    .map((horse) => horse.id);
  const placed = new Set(placedIds);
  const tierceOrders = ordersOfFirstSlots(finishers, 3);
  const quartetOrders = ordersOfFirstSlots(finishers, 4);
  const quinellaOrders = ordersOfFirstSlots(finishers, 2);
  const trioSets = uniqueSets(tierceOrders);
  const first4Sets = uniqueSets(quartetOrders);
  const quinellaSets = uniqueSets(quinellaOrders);
  const top4Ids = [...new Set(first4Sets.flat())];
  const top4Set = new Set(top4Ids);
  const winners = new Set(
    groupsInPositionOrder(finishers).filter((group) => group[0].position === 1).flat().map((horse) => horse.id),
  );
  const top3Intersect = top3.filter((id) => placed.has(id)).length;
  const top4Intersect = top4.filter((id) => top4Set.has(id)).length;
  return {
    void: false,
    evaluated: placed.size >= 3,
    first4Eligible: first4Sets.length > 0,
    top1Hit: !!top1 && winners.has(top1),
    placedIds,
    top3Intersect,
    top3AnyHit: top3Intersect > 0,
    top4Ids,
    top4Intersect,
    quinellaHit: top2.length === 2 && quinellaSets.some((set) => sameSet(top2, set)),
    qpHit: top2.length === 2 && placed.size >= 3 && top2.every((id) => placed.has(id)),
    trioHit: top3.length === 3 && trioSets.some((set) => sameSet(top3, set)),
    tierceHit: top3.length === 3 && tierceOrders.some((order) => sameOrder(top3, order)),
    first4Hit: top4.length === 4 && first4Sets.some((set) => sameSet(top4, set)),
    quartetHit: top4.length === 4 && quartetOrders.some((order) => sameOrder(top4, order)),
    quinellaSets,
    tierceOrders,
    trioSets,
    quartetOrders,
    first4Sets,
  };
}
